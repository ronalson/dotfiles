import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig, ThinkingLevel } from "./agents.ts";
import {
  RADIUS_WEB_SEARCH_TOOL,
  resolvePermissionGateExtension,
  resolveRadiusWebSearchExtension,
} from "./agents.ts";
import {
  boundErrorPreview,
  joinToolResultText,
  parsePermissionGateBlockFromEndEvent,
  ReportedBlockAggregator,
  type PermissionGateBlockMetadata,
  type ReportedBlocks,
} from "./permission-gate-block.ts";

export const PI_INVOCATION_ERROR =
  "Could not resolve a known Pi entrypoint for subagent spawn. Use the current valid script and runtime, or the current standalone executable. The unvalidated PATH `pi` fallback is not used.";

const RADIUS_ROLES = new Set(["scout", "reviewer"]);

export interface RunRequest {
  agent: AgentConfig;
  task: string;
  cwd: string;
  parentModel?: string;
  parentThinking?: ThinkingLevel;
}

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiRuntime {
  execPath: string;
  argv: readonly string[];
  exists(path: string): boolean;
}

export interface PreparedRun extends PiInvocation {
  cwd: string;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
  stdin: string;
  promptPath: string;
  cleanup(): Promise<void>;
}

export interface PrepareRunOptions {
  runtime?: PiRuntime;
  tempRoot?: string;
  resolvePermissionGateExtension?: () => string;
  resolveRadiusExtension?: () => string;
}

export interface ChildProcessLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error & { code?: string }) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type SpawnChild = (
  command: string,
  args: readonly string[],
  options: { cwd: string; shell: false; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessLike;

export interface RunOptions extends PrepareRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RunProgress) => void;
  spawn?: SpawnChild;
  killGraceMs?: number;
  now?: () => number;
}

interface ChildArgumentOptions {
  agent: AgentConfig;
  parentModel?: string;
  parentThinking?: ThinkingLevel;
  promptPath: string;
  permissionGateExtensionPath: string;
  radiusExtensionPath?: string;
}

export function buildChildArguments(options: ChildArgumentOptions): string[] {
  const { agent, parentModel, parentThinking, promptPath, permissionGateExtensionPath, radiusExtensionPath } = options;
  const usesRadius = agent.tools.includes(RADIUS_WEB_SEARCH_TOOL);

  if (!permissionGateExtensionPath) {
    throw new Error("Subagent children require the permission-gate extension");
  }
  if (usesRadius && !RADIUS_ROLES.has(agent.name)) {
    throw new Error(`'${RADIUS_WEB_SEARCH_TOOL}' is allowed only for scout and reviewer`);
  }
  if (usesRadius && !radiusExtensionPath) {
    throw new Error(`Agent '${agent.name}' requires the '${RADIUS_WEB_SEARCH_TOOL}' extension`);
  }
  if (!usesRadius && radiusExtensionPath) {
    throw new Error(`Agent '${agent.name}' does not declare '${RADIUS_WEB_SEARCH_TOOL}'`);
  }

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--tools",
    agent.tools.join(","),
    "--extension",
    permissionGateExtensionPath,
  ];

  if (radiusExtensionPath) {
    args.push("--extension", radiusExtensionPath);
  }

  const model = agent.model ?? parentModel;
  if (model) {
    args.push("--model", model);
  }

  const inheritsParentModel = agent.model === undefined && parentModel !== undefined;
  const thinking = agent.thinking ?? (inheritsParentModel ? parentThinking : undefined);
  if (thinking) {
    args.push("--thinking", thinking);
  }

  args.push("--append-system-prompt", promptPath);
  return args;
}

export function resolvePiInvocation(
  childArgs: string[],
  runtime: PiRuntime = {
    execPath: process.execPath,
    argv: process.argv,
    exists: existsSync,
  },
): PiInvocation {
  const currentScript = runtime.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;

  if (currentScript && !isBunVirtualScript && runtime.exists(currentScript)) {
    return { command: runtime.execPath, args: [currentScript, ...childArgs] };
  }

  const executableName = basename(runtime.execPath.replaceAll("\\", "/")).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(executableName);
  if (!isGenericRuntime) {
    return { command: runtime.execPath, args: [...childArgs] };
  }

  throw new Error(PI_INVOCATION_ERROR);
}

async function createPromptFile(systemPrompt: string, tempRoot: string): Promise<{
  directory: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tempRoot, "pi-subagent-"));
  const path = join(directory, "system-prompt.md");

  try {
    await writeFile(path, systemPrompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);
    return { directory, path };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareAgentRun(
  request: RunRequest,
  options: PrepareRunOptions = {},
): Promise<PreparedRun> {
  const permissionGateExtensionPath = (options.resolvePermissionGateExtension ?? resolvePermissionGateExtension)();
  const usesRadius = request.agent.tools.includes(RADIUS_WEB_SEARCH_TOOL);
  const radiusExtensionPath = usesRadius
    ? (options.resolveRadiusExtension ?? resolveRadiusWebSearchExtension)()
    : undefined;
  const prompt = await createPromptFile(request.agent.systemPrompt, options.tempRoot ?? tmpdir());

  try {
    const childArgs = buildChildArguments({
      agent: request.agent,
      parentModel: request.parentModel,
      parentThinking: request.parentThinking,
      promptPath: prompt.path,
      permissionGateExtensionPath,
      radiusExtensionPath,
    });
    const invocation = resolvePiInvocation(childArgs, options.runtime);
    let cleaned = false;

    return {
      ...invocation,
      cwd: request.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      stdin: `Delegated task:\n${request.task}`,
      promptPath: prompt.path,
      async cleanup() {
        if (cleaned) return;
        await rm(prompt.directory, { recursive: true, force: true });
        cleaned = true;
      },
    };
  } catch (error) {
    await rm(prompt.directory, { recursive: true, force: true });
    throw error;
  }
}

const MAX_JSONL_RECORD_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ACTIVE_TOOLS = 16;
const MAX_RECENT_TOOLS = 5;
const MAX_PREVIEW_BYTES = 512;
const MAX_TOOL_PREVIEW_BYTES = 240;
const MAX_MALFORMED_SAMPLES = 3;
const OUTPUT_NOTICE_RESERVE_BYTES = 512;
const OUTPUT_NOTICE_RESERVE_LINES = 2;

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ToolProgress {
  id: string;
  name: string;
  preview: string;
}

export interface RecentToolProgress {
  name: string;
  preview: string;
  isError: boolean;
  block?: PermissionGateBlockMetadata;
  errorPreview?: string;
}

export type { PermissionGateBlockMetadata, ReportedBlocks };

export interface RunProgress {
  status: RunStatus;
  activeTools: ToolProgress[];
  activeToolOverflow: number;
  recentTools: RecentToolProgress[];
  lastTextPreview?: string;
  toolCalls: number;
  turns: number;
  durationMs: number;
  lastActivityAgoMs?: number;
  generating: boolean;
  reportedBlocks?: ReportedBlocks;
}

export interface RunResult {
  agent: string;
  taskPreview: string;
  status: RunStatus;
  output: string;
  error?: string;
  model?: string;
  usage: Usage;
  progress: RunProgress;
}

export interface ParsedRun {
  status: "succeeded" | "failed";
  output: string;
  error?: string;
  model?: string;
  stopReason?: string;
  usage: Usage;
  progress: RunProgress;
  stderr: string;
  sessionSeen: boolean;
  malformedLineCount: number;
  malformedLineSamples: string[];
}

export interface FinishStreamOptions {
  exitCode?: number;
}

interface JsonlParserOptions {
  startedAt?: number;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionRecord(event: Record<string, unknown>): boolean {
  return event.type === "session"
    && typeof event.id === "string"
    && event.id.length > 0
    && typeof event.timestamp === "string"
    && event.timestamp.length > 0
    && typeof event.cwd === "string"
    && event.cwd.length > 0
    && (event.version === undefined || typeof event.version === "number");
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function aggregateUsage(usages: readonly Usage[]): Usage {
  const total = emptyUsage();
  let hasCacheWrite1h = false;
  let hasReasoning = false;

  for (const usage of usages) {
    total.input += finiteNumber(usage.input);
    total.output += finiteNumber(usage.output);
    total.cacheRead += finiteNumber(usage.cacheRead);
    total.cacheWrite += finiteNumber(usage.cacheWrite);
    total.totalTokens += finiteNumber(usage.totalTokens);
    total.cost.input += finiteNumber(usage.cost?.input);
    total.cost.output += finiteNumber(usage.cost?.output);
    total.cost.cacheRead += finiteNumber(usage.cost?.cacheRead);
    total.cost.cacheWrite += finiteNumber(usage.cost?.cacheWrite);
    total.cost.total += finiteNumber(usage.cost?.total);

    if (typeof usage.cacheWrite1h === "number" && Number.isFinite(usage.cacheWrite1h)) {
      total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
      hasCacheWrite1h = true;
    }
    if (typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)) {
      total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
      hasReasoning = true;
    }
  }

  if (!hasCacheWrite1h) delete total.cacheWrite1h;
  if (!hasReasoning) delete total.reasoning;
  return total;
}

function usageFrom(value: unknown): Usage {
  if (!isRecord(value)) return emptyUsage();
  const cost = isRecord(value.cost) ? value.cost : {};
  const usage = emptyUsage();
  usage.input = finiteNumber(value.input);
  usage.output = finiteNumber(value.output);
  usage.cacheRead = finiteNumber(value.cacheRead);
  usage.cacheWrite = finiteNumber(value.cacheWrite);
  usage.totalTokens = finiteNumber(value.totalTokens);
  usage.cost.input = finiteNumber(cost.input);
  usage.cost.output = finiteNumber(cost.output);
  usage.cost.cacheRead = finiteNumber(cost.cacheRead);
  usage.cost.cacheWrite = finiteNumber(cost.cacheWrite);
  usage.cost.total = finiteNumber(cost.total);

  if (typeof value.cacheWrite1h === "number" && Number.isFinite(value.cacheWrite1h)) {
    usage.cacheWrite1h = value.cacheWrite1h;
  }
  if (typeof value.reasoning === "number" && Number.isFinite(value.reasoning)) {
    usage.reasoning = value.reasoning;
  }
  return usage;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const bytes = Buffer.from(value, "utf8");
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix)))) + suffix;
}

function previewArgs(args: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {}) ?? "{}";
  } catch {
    serialized = "[unserializable arguments]";
  }
  return truncateUtf8(serialized, MAX_TOOL_PREVIEW_BYTES);
}

function assistantText(message: Record<string, unknown>): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

export function boundFinalOutput(output: string): string {
  const truncation = truncateHead(output, {
    maxBytes: DEFAULT_MAX_BYTES - OUTPUT_NOTICE_RESERVE_BYTES,
    maxLines: DEFAULT_MAX_LINES - OUTPUT_NOTICE_RESERVE_LINES,
  });
  if (!truncation.truncated) return output;

  const notice = `[Output truncated: showing ${truncation.outputBytes} of ${truncation.totalBytes} bytes and ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
  const combined = truncation.content ? `${truncation.content}\n\n${notice}` : notice;
  return truncateHead(combined, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  }).content;
}

function countLines(value: string): number {
  if (value === "") return 0;
  return value.split(/\r?\n/).length;
}

export function boundOutputReservingSuffix(
  output: string,
  suffix: string,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): string {
  const trimmedSuffix = suffix.trim();
  if (trimmedSuffix === "") {
    return truncateHead(output, { maxBytes, maxLines }).content;
  }

  const suffixPart = output.trim() === "" ? trimmedSuffix : `\n\n${trimmedSuffix}`;
  const suffixBytes = Buffer.byteLength(suffixPart, "utf8");
  const suffixLines = countLines(suffixPart);
  const headMaxBytes = Math.max(1, maxBytes - suffixBytes);
  const headMaxLines = Math.max(1, maxLines - suffixLines);

  const truncation = truncateHead(output, {
    maxBytes: Math.max(1, headMaxBytes - OUTPUT_NOTICE_RESERVE_BYTES),
    maxLines: Math.max(1, headMaxLines - OUTPUT_NOTICE_RESERVE_LINES),
  });

  let head = output;
  if (truncation.truncated) {
    const notice = `[Output truncated: showing ${truncation.outputBytes} of ${truncation.totalBytes} bytes and ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
    const combined = truncation.content ? `${truncation.content}\n\n${notice}` : notice;
    head = truncateHead(combined, { maxBytes: headMaxBytes, maxLines: headMaxLines }).content;
  } else if (
    Buffer.byteLength(output, "utf8") + suffixBytes > maxBytes
    || countLines(output) + countLines(suffixPart) - (output.endsWith("\n") || suffixPart.startsWith("\n") ? 1 : 0) > maxLines
  ) {
    head = truncateHead(output, { maxBytes: headMaxBytes, maxLines: headMaxLines }).content;
  }

  return `${head}${suffixPart}`;
}

function stderrText(buffer: Buffer): string {
  let offset = 0;
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset++;
  return buffer.subarray(offset).toString("utf8");
}

export class JsonlRunParser {
  private readonly decoder = new StringDecoder("utf8");
  private readonly startedAt: number;
  private readonly now: () => number;
  private pending = "";
  private ended = false;
  private sessionSeen = false;
  private protocolError?: string;
  private output = "";
  private model?: string;
  private stopReason?: string;
  private assistantError?: string;
  private usage: Usage = emptyUsage();
  private malformedLineCount = 0;
  private readonly malformedLineSamples: string[] = [];
  private readonly activeTools = new Map<string, ToolProgress>();
  private activeToolOverflow = 0;
  private readonly recentTools: RecentToolProgress[] = [];
  private lastTextPreview?: string;
  private toolCalls = 0;
  private turns = 0;
  private lastObservedActivityAt?: number;
  private generating = false;
  private streamingText = "";
  private stderr = Buffer.alloc(0);
  private readonly reportedBlocks = new ReportedBlockAggregator();

  constructor(options: JsonlParserOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  writeStdout(chunk: Buffer | string): void {
    if (this.ended) throw new Error("cannot write stdout after the JSONL parser has ended");
    if (this.protocolError) return;
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.consumeDecoded(this.decoder.write(buffer), false);
  }

  writeStderr(chunk: Buffer | string): void {
    if (this.ended) throw new Error("cannot write stderr after the JSONL parser has ended");
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const combined = Buffer.concat([this.stderr, buffer]);
    this.stderr = combined.length > MAX_STDERR_BYTES ? combined.subarray(combined.length - MAX_STDERR_BYTES) : combined;
  }

  hasProtocolError(): boolean {
    return this.protocolError !== undefined;
  }

  snapshot(status: RunStatus = "running"): RunProgress {
    const now = this.now();
    const reportedBlocks = this.reportedBlocks.snapshot();
    return {
      status,
      activeTools: [...this.activeTools.values()].map((tool) => ({ ...tool })),
      activeToolOverflow: this.activeToolOverflow,
      recentTools: this.recentTools.map((tool) => ({
        ...tool,
        ...(tool.block ? { block: { ...tool.block, rules: [...tool.block.rules] } } : {}),
      })),
      ...(this.lastTextPreview === undefined ? {} : { lastTextPreview: this.lastTextPreview }),
      toolCalls: this.toolCalls,
      turns: this.turns,
      durationMs: Math.max(0, now - this.startedAt),
      ...(this.lastObservedActivityAt === undefined
        ? {}
        : { lastActivityAgoMs: Math.max(0, now - this.lastObservedActivityAt) }),
      generating: status === "running" && this.generating,
      ...(reportedBlocks === undefined ? {} : { reportedBlocks }),
    };
  }

  finish(options: FinishStreamOptions = {}): ParsedRun {
    if (!this.ended) {
      this.consumeDecoded(this.decoder.end(), true);
      this.ended = true;
    }

    let error = this.protocolError;
    if (!error && !this.sessionSeen) {
      error = "child output did not contain a valid session record";
    } else if (!error && options.exitCode !== undefined && options.exitCode !== 0) {
      error = `child process exited with code ${options.exitCode}`;
    } else if (!error && (this.stopReason === "error" || this.stopReason === "aborted")) {
      error = this.assistantError || `assistant stopped with reason '${this.stopReason}'`;
    } else if (!error && this.assistantError) {
      error = this.assistantError;
    } else if (!error && this.output.trim() === "") {
      error = "child output did not contain a usable final assistant response";
    }

    const status = error ? "failed" : "succeeded";
    return {
      status,
      output: this.output,
      ...(error === undefined ? {} : { error }),
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      usage: aggregateUsage([this.usage]),
      progress: this.snapshot(status),
      stderr: stderrText(this.stderr),
      sessionSeen: this.sessionSeen,
      malformedLineCount: this.malformedLineCount,
      malformedLineSamples: [...this.malformedLineSamples],
    };
  }

  private consumeDecoded(decoded: string, flush: boolean): void {
    if (this.protocolError) return;
    const combined = this.pending + decoded;
    let start = 0;
    let newline = combined.indexOf("\n", start);

    while (newline !== -1) {
      const line = combined.slice(start, newline);
      if (!this.processLine(line)) return;
      start = newline + 1;
      newline = combined.indexOf("\n", start);
    }

    const remainder = combined.slice(start);
    if (flush) {
      this.pending = "";
      if (remainder !== "") this.processLine(remainder);
    } else if (Buffer.byteLength(remainder, "utf8") > MAX_JSONL_RECORD_BYTES) {
      this.failOversizedRecord();
    } else {
      this.pending = remainder;
    }
  }

  private processLine(rawLine: string): boolean {
    if (Buffer.byteLength(rawLine, "utf8") > MAX_JSONL_RECORD_BYTES) {
      this.failOversizedRecord();
      return false;
    }

    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === "") return true;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.malformedLineCount++;
      if (this.malformedLineSamples.length < MAX_MALFORMED_SAMPLES) {
        this.malformedLineSamples.push(truncateUtf8(line, MAX_TOOL_PREVIEW_BYTES));
      }
      return true;
    }

    if (!isRecord(event)) return true;
    this.processEvent(event);
    return true;
  }

  private failOversizedRecord(): void {
    this.pending = "";
    this.protocolError = `child JSONL record exceeded ${MAX_JSONL_RECORD_BYTES} bytes`;
  }

  private markActivity(): void {
    this.lastObservedActivityAt = this.now();
  }

  private processEvent(event: Record<string, unknown>): void {
    this.markActivity();

    if (isSessionRecord(event)) {
      this.sessionSeen = true;
      return;
    }

    if (event.type === "tool_execution_start") {
      this.toolCalls++;
      if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
      const tool = {
        id: event.toolCallId,
        name: event.toolName,
        preview: previewArgs(event.args),
      };
      if (this.activeTools.size < MAX_ACTIVE_TOOLS) {
        this.activeTools.set(tool.id, tool);
      } else {
        this.activeToolOverflow++;
      }
      return;
    }

    if (event.type === "tool_execution_update") {
      return;
    }

    if (event.type === "tool_execution_end") {
      const parsedBlock = parsePermissionGateBlockFromEndEvent(event);
      if (parsedBlock) this.reportedBlocks.record(parsedBlock.metadata);
      if (typeof event.toolCallId !== "string") return;

      let completed = this.activeTools.get(event.toolCallId);
      if (completed) {
        this.activeTools.delete(event.toolCallId);
      } else if (this.activeToolOverflow > 0 && typeof event.toolName === "string") {
        this.activeToolOverflow--;
        completed = {
          id: event.toolCallId,
          name: event.toolName,
          preview: previewArgs(event.args),
        };
      }
      if (completed) {
        const isSuccess = event.isError === false;
        const recent: RecentToolProgress = {
          name: completed.name,
          preview: completed.preview,
          isError: !isSuccess,
        };
        if (!isSuccess) {
          const display = parsedBlock?.displayText ?? joinToolResultText(event.result) ?? "";
          const errorPreview = boundErrorPreview(display);
          if (parsedBlock) recent.block = { ...parsedBlock.metadata, rules: [...parsedBlock.metadata.rules] };
          if (errorPreview) recent.errorPreview = errorPreview;
        }
        this.recentTools.push(recent);
        if (this.recentTools.length > MAX_RECENT_TOOLS) this.recentTools.shift();
      }
      return;
    }

    if (event.type === "message_start") {
      if (isRecord(event.message) && event.message.role === "assistant") {
        this.generating = true;
        this.streamingText = "";
      }
      return;
    }

    if (event.type === "message_update") {
      this.generating = true;
      this.consumeMessageUpdate(event);
      return;
    }

    if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
      return;
    }

    this.generating = false;
    this.streamingText = "";
    const message = event.message;
    this.turns++;
    this.usage = aggregateUsage([this.usage, usageFrom(message.usage)]);
    this.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    this.assistantError = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? truncateUtf8(message.errorMessage.trim(), MAX_PREVIEW_BYTES)
      : undefined;

    if (typeof message.model === "string" && message.model) {
      this.model = typeof message.provider === "string" && message.provider
        ? `${message.provider}/${message.model}`
        : message.model;
    }

    const text = assistantText(message);
    if (text.trim() !== "") {
      this.output = boundFinalOutput(text);
      this.lastTextPreview = truncateUtf8(text, MAX_PREVIEW_BYTES);
    }
  }

  private consumeMessageUpdate(event: Record<string, unknown>): void {
    const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
    if (!update || typeof update.type !== "string") return;
    if (update.type.startsWith("thinking_")) return;
    if (update.type !== "text_delta" || typeof update.delta !== "string") return;
    this.streamingText = truncateUtf8(this.streamingText + update.delta, MAX_PREVIEW_BYTES);
    if (this.streamingText.trim() !== "") {
      this.lastTextPreview = this.streamingText;
    }
  }
}

const DEFAULT_KILL_GRACE_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 1000;
const MAX_ERROR_BYTES = 4096;
const MAX_TASK_PREVIEW_BYTES = 240;

const defaultSpawn: SpawnChild = (command, args, options) =>
  nodeSpawn(command, [...args], options) as ChildProcessLike;

function emitProgress(callback: RunOptions["onProgress"], progress: RunProgress): void {
  try {
    callback?.(progress);
  } catch {
    // Rendering failures must not strand a child process.
  }
}

function taskPreview(task: string): string {
  return truncateUtf8(task.replace(/\s+/g, " ").trim(), MAX_TASK_PREVIEW_BYTES);
}

function initialProgress(status: RunStatus, startedAt: number, now: () => number): RunProgress {
  return {
    status,
    activeTools: [],
    activeToolOverflow: 0,
    recentTools: [],
    toolCalls: 0,
    turns: 0,
    durationMs: Math.max(0, now() - startedAt),
    generating: false,
  };
}

function cancelledResult(request: RunRequest, startedAt: number, now: () => number): RunResult {
  return {
    agent: request.agent.name,
    taskPreview: taskPreview(request.task),
    status: "cancelled",
    output: "",
    error: "Subagent cancelled",
    usage: emptyUsage(),
    progress: initialProgress("cancelled", startedAt, now),
  };
}

function spawnFailure(agent: string, error: Error & { code?: string }): string {
  if (error.code === "ENOENT") return "Pi executable could not be resolved";
  if (error.code === "EACCES") return "Resolved Pi executable is not runnable";
  const detail = error.code || error.message || "unknown spawn error";
  return truncateUtf8(`Could not start subagent '${agent}': ${detail}`, MAX_ERROR_BYTES);
}

function appendStderr(error: string, stderr: string): string {
  const diagnostic = stderr.trim();
  if (!diagnostic) return truncateUtf8(error, MAX_ERROR_BYTES);
  return truncateUtf8(`${error}\n${diagnostic}`, MAX_ERROR_BYTES);
}

function processResult(
  request: RunRequest,
  parsed: ParsedRun,
  override: { status?: "failed" | "cancelled"; error?: string } = {},
): RunResult {
  const status = override.status ?? parsed.status;
  const error = override.error ?? parsed.error;
  return {
    agent: request.agent.name,
    taskPreview: taskPreview(request.task),
    status,
    output: parsed.output,
    ...(error === undefined ? {} : { error: appendStderr(error, parsed.stderr) }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    usage: parsed.usage,
    progress: { ...parsed.progress, status },
  };
}

interface ProcessCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error & { code?: string };
  inputError?: Error;
  cancelled: boolean;
}

export async function runAgent(request: RunRequest, options: RunOptions = {}): Promise<RunResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const signal = options.signal;

  if (signal?.aborted) {
    const result = cancelledResult(request, startedAt, now);
    emitProgress(options.onProgress, result.progress);
    return result;
  }

  let prepared: PreparedRun;
  try {
    prepared = await prepareAgentRun(request, options);
  } catch (error) {
    if (signal?.aborted) {
      const result = cancelledResult(request, startedAt, now);
      emitProgress(options.onProgress, result.progress);
      return result;
    }
    throw error;
  }

  try {
    if (signal?.aborted) {
      const result = cancelledResult(request, startedAt, now);
      emitProgress(options.onProgress, result.progress);
      return result;
    }

    const parser = new JsonlRunParser({ startedAt, now });
    const spawnChild = options.spawn ?? defaultSpawn;
    let child: ChildProcessLike;

    try {
      child = spawnChild(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        shell: prepared.shell,
        stdio: prepared.stdio,
      });
    } catch (error) {
      const spawnError = error instanceof Error ? error : new Error(String(error));
      const parsed = parser.finish();
      const result = processResult(request, parsed, {
        status: "failed",
        error: spawnFailure(request.agent.name, spawnError),
      });
      emitProgress(options.onProgress, result.progress);
      return result;
    }

    emitProgress(options.onProgress, parser.snapshot("running"));

    const completion = await new Promise<ProcessCompletion>((resolve) => {
      let closed = false;
      let cancelled = false;
      let spawnError: (Error & { code?: string }) | undefined;
      let inputError: Error | undefined;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let terminationStarted = false;
      let progressStopped = false;

      const stopHeartbeat = () => {
        if (heartbeatTimer === undefined) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      };

      const stopProgress = () => {
        progressStopped = true;
        stopHeartbeat();
      };

      const emitRunningProgress = () => {
        if (closed || progressStopped) return;
        emitProgress(options.onProgress, parser.snapshot("running"));
      };

      const terminate = () => {
        if (terminationStarted) return;
        terminationStarted = true;
        stopProgress();
        try {
          child.kill("SIGTERM");
        } catch {
          // The close event remains authoritative.
        }
        escalationTimer ??= setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {
              // The close event remains authoritative.
            }
          }
        }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      };

      const abort = () => {
        if (closed || cancelled) return;
        cancelled = true;
        terminate();
      };

      child.stdout.on("data", (chunk: Buffer | string) => {
        parser.writeStdout(chunk);
        if (parser.hasProtocolError()) terminate();
        else emitRunningProgress();
      });
      child.stderr.on("data", (chunk: Buffer | string) => parser.writeStderr(chunk));
      child.stdin.on("error", (error: Error) => {
        inputError = error;
        terminate();
      });
      child.once("error", (error) => {
        spawnError = error;
        stopProgress();
      });
      child.once("close", (code, closeSignal) => {
        closed = true;
        stopHeartbeat();
        if (escalationTimer) clearTimeout(escalationTimer);
        signal?.removeEventListener("abort", abort);
        resolve({ code, signal: closeSignal, spawnError, inputError, cancelled });
      });

      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });

      try {
        child.stdin.end(prepared.stdin);
      } catch (error) {
        inputError = error instanceof Error ? error : new Error(String(error));
        terminate();
      }

      if (!progressStopped && !closed) {
        heartbeatTimer = setInterval(() => {
          emitRunningProgress();
        }, HEARTBEAT_INTERVAL_MS);
      }
    });

    const parsed = parser.finish({ exitCode: completion.code ?? undefined });
    let result: RunResult;
    if (completion.cancelled || signal?.aborted) {
      result = processResult(request, parsed, { status: "cancelled", error: "Subagent cancelled" });
    } else if (completion.spawnError) {
      result = processResult(request, parsed, {
        status: "failed",
        error: spawnFailure(request.agent.name, completion.spawnError),
      });
    } else if (completion.inputError) {
      result = processResult(request, parsed, {
        status: "failed",
        error: truncateUtf8(`Could not send task to subagent '${request.agent.name}': ${completion.inputError.message}`, MAX_ERROR_BYTES),
      });
    } else if (completion.signal && !parser.hasProtocolError()) {
      result = processResult(request, parsed, {
        status: "failed",
        error: `Child process exited due to signal ${completion.signal}`,
      });
    } else {
      result = processResult(request, parsed);
    }

    emitProgress(options.onProgress, result.progress);
    return result;
  } finally {
    await prepared.cleanup();
  }
}
