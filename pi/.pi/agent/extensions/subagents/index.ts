import { accessSync, constants, statSync } from "node:fs";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentConfig, AgentDiscovery } from "./agents.ts";
import {
  discoverAgents,
  RADIUS_WEB_SEARCH_TOOL,
  resolveRadiusWebSearchExtension,
} from "./agents.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { RunProgress, RunRequest, RunResult } from "./runner.ts";
import { aggregateUsage, emptyUsage, runAgent } from "./runner.ts";

const MAX_TASK_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_AGGREGATE_ERROR_BYTES = 8192;
const PARALLEL_OUTPUT_RESERVE_BYTES = 2048;
const PARALLEL_OUTPUT_RESERVE_LINES = 32;
const PROGRESS_INTERVAL_MS = 150;

export interface SubagentParams {
  tasks: Array<{
    agent: string;
    task: string;
  }>;
}

export interface SubagentDetails {
  kind: "subagents";
  version: 1;
  runs: RunResult[];
}

interface SemaphoreWaiter {
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

export class FifoSemaphore {
  private active = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Semaphore capacity must be a positive integer");
    }
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index === -1) return;
        this.queue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.abort!);
        reject(abortError());
      };

      if (this.active < this.capacity && this.queue.length === 0) {
        this.grant(waiter);
      } else {
        this.queue.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
      }
    });
  }

  private grant(waiter: SemaphoreWaiter): void {
    waiter.signal?.removeEventListener("abort", waiter.abort!);
    this.active++;
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.capacity && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        waiter.signal.removeEventListener("abort", waiter.abort!);
        waiter.reject(abortError());
        continue;
      }
      this.grant(waiter);
    }
  }
}

interface ExtensionDependencies {
  discoverAgents(): AgentDiscovery;
  resolveRadiusExtension(): string;
  runAgent(request: RunRequest, options: {
    signal?: AbortSignal;
    onProgress?: (progress: RunProgress) => void;
    resolveRadiusExtension?: () => string;
  }): Promise<RunResult>;
  workingDirectoryAvailable(cwd: string): boolean;
  semaphore: FifoSemaphore;
}

const processSemaphore = new FifoSemaphore(4);

const defaultDependencies: ExtensionDependencies = {
  discoverAgents,
  resolveRadiusExtension: resolveRadiusWebSearchExtension,
  runAgent,
  workingDirectoryAvailable(cwd) {
    try {
      if (!statSync(cwd).isDirectory()) return false;
      accessSync(cwd, constants.R_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  semaphore: processSemaphore,
};

function abortError(): Error {
  return new DOMException("Subagent execution cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maxBytes - 3) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return `${value.slice(0, low)}…`;
}

function previewTask(task: string): string {
  return boundedText(task.replace(/\s+/g, " ").trim(), 240);
}

function emptyProgress(status: RunProgress["status"]): RunProgress {
  return {
    status,
    activeTools: [],
    activeToolOverflow: 0,
    recentTools: [],
    toolCalls: 0,
    turns: 0,
    durationMs: 0,
  };
}

function placeholder(agent: string, task: string, status: "queued" | "cancelled" | "failed"): RunResult {
  return {
    agent,
    taskPreview: previewTask(task),
    status,
    output: "",
    ...(status === "cancelled" ? { error: "Subagent cancelled" } : {}),
    usage: emptyUsage(),
    progress: emptyProgress(status),
  };
}

function failureResult(agent: string, task: string, error: unknown): RunResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...placeholder(agent, task, "failed"),
    error: boundedText(message || "Unknown subagent failure", MAX_ERROR_BYTES),
  };
}

function details(runs: RunResult[]): SubagentDetails {
  return {
    kind: "subagents",
    version: 1,
    runs: runs.map((run) => ({
      ...run,
      usage: { ...run.usage, cost: { ...run.usage.cost } },
      progress: {
        ...run.progress,
        activeTools: run.progress.activeTools.map((tool) => ({ ...tool })),
        recentTools: run.progress.recentTools.map((tool) => ({ ...tool })),
      },
    })),
  };
}

function progressText(runs: RunResult[]): string {
  const complete = runs.filter((run) => run.status === "succeeded" || run.status === "failed" || run.status === "cancelled").length;
  const running = runs.filter((run) => run.status === "running").length;
  return `Subagents: ${complete}/${runs.length} complete, ${running} running`;
}

function createProgressEmitter(emit: () => void): { schedule(): void; flush(): void } {
  let lastEmission = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    lastEmission = Date.now();
    try {
      emit();
    } catch {
      // Rendering updates must not interrupt child cleanup.
    }
  };

  return {
    schedule() {
      const remaining = PROGRESS_INTERVAL_MS - (Date.now() - lastEmission);
      if (remaining <= 0) flush();
      else timer ??= setTimeout(flush, remaining);
    },
    flush,
  };
}

function boundedSectionOutput(output: string, maxBytes: number, maxLines: number): string {
  const noticeReserveBytes = 320;
  const noticeReserveLines = 2;
  const truncation = truncateHead(output, {
    maxBytes: Math.max(1, maxBytes - noticeReserveBytes),
    maxLines: Math.max(1, maxLines - noticeReserveLines),
  });
  if (!truncation.truncated) return output;

  const notice = `[Output truncated for parallel result: showing ${truncation.outputBytes} of ${truncation.totalBytes} bytes and ${truncation.outputLines} of ${truncation.totalLines} lines.]`;
  return truncation.content ? `${truncation.content}\n\n${notice}` : notice;
}

function budgetParallelResults(runs: RunResult[]): { runs: RunResult[]; content: string } {
  const perTaskBytes = Math.floor((DEFAULT_MAX_BYTES - PARALLEL_OUTPUT_RESERVE_BYTES) / runs.length);
  const perTaskLines = Math.floor((DEFAULT_MAX_LINES - PARALLEL_OUTPUT_RESERVE_LINES) / runs.length);
  const boundedRuns: RunResult[] = [];
  const sections: string[] = [];

  for (const run of runs) {
    const boundedRun = {
      ...run,
      output: boundedSectionOutput(run.output, perTaskBytes, perTaskLines),
    };
    boundedRuns.push(boundedRun);

    const diagnostic = run.error ? `Error: ${run.error}` : "";
    const candidate = run.status === "succeeded"
      ? run.output
      : [diagnostic, run.output ? `Partial output:\n${run.output}` : ""].filter(Boolean).join("\n\n");
    const body = boundedSectionOutput(candidate || "(no output)", perTaskBytes, perTaskLines);
    sections.push(`## ${run.agent} — ${run.status}\n\n${body}`);
  }

  const succeeded = runs.filter((run) => run.status === "succeeded").length;
  const combined = `Parallel: ${succeeded}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
  return {
    runs: boundedRuns,
    content: truncateHead(combined, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).content,
  };
}

function aggregateFailure(runs: RunResult[]): Error {
  const lines = runs.map((run) => `${run.agent}: ${run.error || "failed without a diagnostic"}`);
  return new Error(boundedText(`All ${runs.length} subagents failed:\n${lines.join("\n")}`, MAX_AGGREGATE_ERROR_BYTES));
}

function preflight(
  params: SubagentParams,
  agents: Map<string, AgentConfig>,
  cwd: string,
  dependencies: ExtensionDependencies,
): { requests: RunRequest[]; radiusExtensionPath?: string } {
  if (!Array.isArray(params.tasks) || params.tasks.length < 1 || params.tasks.length > 4) {
    throw new Error("subagent requires between one and four tasks");
  }
  if (!dependencies.workingDirectoryAvailable(cwd)) {
    throw new Error(`Subagent working directory is unavailable: ${cwd}`);
  }

  const requests = params.tasks.map((task, index) => {
    if (!task || typeof task.agent !== "string" || typeof task.task !== "string") {
      throw new Error(`Invalid subagent task at index ${index}`);
    }
    const agent = agents.get(task.agent);
    if (!agent) {
      throw new Error(`Unknown subagent '${task.agent}'. Available agents: ${[...agents.keys()].join(", ")}`);
    }
    if (task.task.length < 1) {
      throw new Error(`Subagent task at index ${index} must not be empty`);
    }
    if (task.task.length > 65_536 || Buffer.byteLength(task.task, "utf8") > MAX_TASK_BYTES) {
      throw new Error(`Subagent task at index ${index} exceeds the 64 KiB limit`);
    }
    return { agent, task: task.task, cwd };
  });

  const needsRadius = requests.some((request) => request.agent.tools.includes(RADIUS_WEB_SEARCH_TOOL));
  return {
    requests,
    ...(needsRadius ? { radiusExtensionPath: dependencies.resolveRadiusExtension() } : {}),
  };
}

export function registerSubagentExtension(
  pi: ExtensionAPI,
  overrides: Partial<ExtensionDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };
  const discovery = dependencies.discoverAgents();

  for (const diagnostic of discovery.diagnostics) {
    console.warn(`[subagents] Skipping ${diagnostic.filePath}: ${diagnostic.message}`);
  }
  if (discovery.agents.length === 0) {
    console.warn("[subagents] No valid agents found; the subagent tool was not registered.");
    return;
  }

  const agents = new Map(discovery.agents.map((agent) => [agent.name, agent]));
  const agentNames = discovery.agents.map((agent) => agent.name);
  const roleDescriptions = discovery.agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ");
  const TaskSchema = Type.Object(
    {
      agent: StringEnum(agentNames, { description: "Subagent role name" }),
      task: Type.String({
        minLength: 1,
        maxLength: 65_536,
        description: "Self-contained task including all necessary conversation context",
      }),
    },
    { additionalProperties: false },
  );
  const Parameters = Type.Object(
    {
      tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 4 }),
    },
    { additionalProperties: false },
  );

  pi.registerTool<typeof Parameters, SubagentDetails>({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate self-contained tasks to isolated subagents that receive no parent conversation transcript.",
      "One task is a normal single delegation; multiple independent tasks run concurrently.",
      "Use direct Pi tools for simple file reads or shell commands.",
      "Use subagents for independent reasoning, review, exploration, or an isolated implementation slice.",
      `Available roles: ${roleDescriptions}`,
      "Combined output is limited to 50 KiB and 2,000 lines.",
    ].join(" "),
    parameters: Parameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const preflightResult = preflight(params, agents, ctx.cwd, dependencies);
      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const requests = preflightResult.requests.map((request) => ({
        ...request,
        ...(parentModel === undefined ? {} : { parentModel }),
        ...(ctx.thinkingLevel === undefined ? {} : { parentThinking: ctx.thinkingLevel }),
      }));
      const radiusExtensionPath = preflightResult.radiusExtensionPath;
      const runs = requests.map((request) => placeholder(request.agent.name, request.task, "queued"));

      const progressEmitter = createProgressEmitter(() => {
        onUpdate?.({
          content: [{ type: "text", text: progressText(runs) }],
          details: details(runs.map((run) => ({ ...run, output: "" }))),
        });
      });
      const update = (flush = false) => flush ? progressEmitter.flush() : progressEmitter.schedule();
      update(true);

      const executeRequest = async (request: RunRequest, index: number): Promise<RunResult> => {
        let release: (() => void) | undefined;
        try {
          release = await dependencies.semaphore.acquire(signal);
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) {
            const cancelled = placeholder(request.agent.name, request.task, "cancelled");
            runs[index] = cancelled;
            update(true);
            return cancelled;
          }
          const failed = failureResult(request.agent.name, request.task, error);
          runs[index] = failed;
          update(true);
          return failed;
        }

        try {
          const result = await dependencies.runAgent(request, {
            signal,
            ...(radiusExtensionPath === undefined
              ? {}
              : { resolveRadiusExtension: () => radiusExtensionPath }),
            onProgress(progress) {
              runs[index] = { ...runs[index], status: progress.status, progress };
              update();
            },
          });
          runs[index] = result;
          update(true);
          return result;
        } catch (error) {
          const result = signal?.aborted
            ? placeholder(request.agent.name, request.task, "cancelled")
            : failureResult(request.agent.name, request.task, error);
          runs[index] = result;
          update(true);
          return result;
        } finally {
          release();
        }
      };

      const results = await Promise.all(requests.map(executeRequest));
      if (signal?.aborted || results.some((result) => result.status === "cancelled")) {
        throw new Error("Subagent execution cancelled");
      }

      if (results.length === 1) {
        const result = results[0];
        if (result.status !== "succeeded") {
          throw new Error(boundedText(`Subagent ${result.agent} failed: ${result.error || "no diagnostic"}`, MAX_ERROR_BYTES));
        }
        return {
          content: [{ type: "text", text: result.output }],
          details: details(results),
          usage: aggregateUsage(results.map((run) => run.usage)),
        };
      }

      const succeeded = results.filter((result) => result.status === "succeeded").length;
      if (succeeded === 0) throw aggregateFailure(results);

      const bounded = budgetParallelResults(results);
      return {
        content: [{ type: "text", text: bounded.content }],
        details: details(bounded.runs),
        usage: aggregateUsage(results.map((run) => run.usage)),
      };
    },

    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },

    renderResult(result, options, theme, context) {
      return renderSubagentResult(result, options, theme, context);
    },
  });
}

export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentExtension(pi);
}
