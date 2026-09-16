import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentConfig, ThinkingLevel } from "../agents.ts";
import { PERMISSION_GATE_BLOCK_MARKER } from "../permission-gate-block.ts";
import {
  aggregateUsage,
  boundFinalOutput,
  boundOutputReservingSuffix,
  buildChildArguments,
  JsonlRunParser,
  PI_INVOCATION_ERROR,
  prepareAgentRun,
  resolvePiInvocation,
  runAgent,
  type ChildProcessLike,
  type PiRuntime,
  type PrepareRunOptions,
  type RunRequest,
  type SpawnChild,
} from "../runner.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-runner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "worker",
    description: "Worker",
    tools: ["read", "bash", "edit", "write"],
    systemPrompt: "Follow the delegated task.",
    filePath: "/extension/agents/worker.md",
    ...overrides,
  };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function runtime(overrides: Partial<PiRuntime> = {}): PiRuntime {
  return {
    execPath: "/usr/bin/node",
    argv: ["/usr/bin/node", "/opt/pi/cli.js"],
    exists: () => true,
    ...overrides,
  };
}

const GATE_PATH = "/agent/git/github.com/ronalson/pi-permission-gate/index.ts";

function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1] !== undefined) values.push(args[index + 1]!);
  }
  return values;
}

function prepareOptions(overrides: PrepareRunOptions = {}): PrepareRunOptions {
  return {
    runtime: runtime(),
    resolvePermissionGateExtension: () => GATE_PATH,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("buildChildArguments", () => {
  it("builds the controlled child environment and exact tool allowlist", () => {
    const args = buildChildArguments({
      agent: agent({ tools: ["read", "grep", "find", "ls", "bash", "edit", "write"] }),
      promptPath: "/tmp/prompt.md",
      permissionGateExtensionPath: GATE_PATH,
    });

    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
      "--tools",
      "read,grep,find,ls,bash,edit,write",
      "--extension",
      GATE_PATH,
      "--append-system-prompt",
      "/tmp/prompt.md",
    ]);
    expect(args).not.toContain("--models");
  });

  it.each<{
    label: string;
    roleModel?: string;
    roleThinking?: ThinkingLevel;
    parentModel?: string;
    parentThinking?: ThinkingLevel;
    expectedModel?: string;
    expectedThinking?: ThinkingLevel;
  }>([
    {
      label: "inherits the parent model and thinking",
      parentModel: "openai/gpt-parent",
      parentThinking: "high",
      expectedModel: "openai/gpt-parent",
      expectedThinking: "high",
    },
    {
      label: "uses role-pinned model and thinking",
      roleModel: "anthropic/role-model",
      roleThinking: "low",
      parentModel: "openai/gpt-parent",
      parentThinking: "high",
      expectedModel: "anthropic/role-model",
      expectedThinking: "low",
    },
    {
      label: "uses Pi default thinking for a role-pinned model",
      roleModel: "anthropic/role-model",
      parentModel: "openai/gpt-parent",
      parentThinking: "high",
      expectedModel: "anthropic/role-model",
    },
    {
      label: "applies role-pinned thinking to an inherited model",
      roleThinking: "xhigh",
      parentModel: "openai/gpt-parent",
      parentThinking: "medium",
      expectedModel: "openai/gpt-parent",
      expectedThinking: "xhigh",
    },
    {
      label: "omits defaults when neither side selects a model",
      parentThinking: "high",
    },
    {
      label: "applies role thinking to the child default model",
      roleThinking: "minimal",
      parentThinking: "high",
      expectedThinking: "minimal",
    },
  ])("$label", (testCase) => {
    const args = buildChildArguments({
      agent: agent({ model: testCase.roleModel, thinking: testCase.roleThinking }),
      parentModel: testCase.parentModel,
      parentThinking: testCase.parentThinking,
      promptPath: "/tmp/prompt.md",
      permissionGateExtensionPath: GATE_PATH,
    });

    expect(flagValue(args, "--model")).toBe(testCase.expectedModel);
    expect(flagValue(args, "--thinking")).toBe(testCase.expectedThinking);
    expect(args).not.toContain("--models");
  });

  it("loads the gate for every role and Radius as a second explicit extension for approved roles", () => {
    const radiusPath = "/agent/npm/node_modules/@earendil-works/pi-radius/extensions/radius-web-search.ts";
    const args = buildChildArguments({
      agent: agent({ name: "scout", tools: ["read", "radius_web_search"] }),
      promptPath: "/tmp/prompt.md",
      permissionGateExtensionPath: GATE_PATH,
      radiusExtensionPath: radiusPath,
    });

    expect(flagValues(args, "--extension")).toEqual([GATE_PATH, radiusPath]);
    expect(flagValue(args, "--tools")).toBe("read,radius_web_search");
    expect(args.filter((value) => value === "--extension")).toHaveLength(2);
  });

  it("rejects Radius for unapproved roles and extension paths for roles that do not declare it", () => {
    expect(() =>
      buildChildArguments({
        agent: agent({ tools: ["read", "radius_web_search"] }),
        promptPath: "/tmp/prompt.md",
        permissionGateExtensionPath: GATE_PATH,
        radiusExtensionPath: "/tmp/radius.ts",
      }),
    ).toThrow("allowed only for scout and reviewer");

    expect(() =>
      buildChildArguments({
        agent: agent(),
        promptPath: "/tmp/prompt.md",
        permissionGateExtensionPath: GATE_PATH,
        radiusExtensionPath: "/role-controlled/extension.ts",
      }),
    ).toThrow("does not declare");
  });

  it("rejects a missing gate path", () => {
    expect(() =>
      buildChildArguments({
        agent: agent(),
        promptPath: "/tmp/prompt.md",
        permissionGateExtensionPath: "",
      }),
    ).toThrow("permission-gate extension");
  });
});

describe("resolvePiInvocation", () => {
  const childArgs = ["--mode", "json"];

  it("prefers the running Pi entry script with the current runtime", () => {
    expect(resolvePiInvocation(childArgs, runtime())).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/pi/cli.js", ...childArgs],
    });
  });

  it("uses a standalone Pi executable directly", () => {
    expect(
      resolvePiInvocation(
        childArgs,
        runtime({ execPath: "/Applications/Pi/pi", argv: ["/Applications/Pi/pi"], exists: () => false }),
      ),
    ).toEqual({ command: "/Applications/Pi/pi", args: childArgs });
  });

  it("fails before spawn instead of selecting PATH pi", () => {
    expect(() =>
      resolvePiInvocation(
        childArgs,
        runtime({ execPath: "/usr/bin/bun", argv: ["bun", "/$bunfs/root/cli.js"], exists: () => true }),
      ),
    ).toThrow(PI_INVOCATION_ERROR);

    expect(() =>
      resolvePiInvocation(
        childArgs,
        runtime({ execPath: "C:\\node.exe", argv: ["node"], exists: () => false }),
      ),
    ).toThrow(PI_INVOCATION_ERROR);
  });
});

describe("prepareAgentRun", () => {
  it("prepares piped stdin, shell-free spawn settings, and a private prompt file", async () => {
    const tempRoot = await temporaryDirectory();
    const request = {
      agent: agent({ systemPrompt: "Private role instructions" }),
      task: "Inspect this; echo $(env)",
      cwd: "/workspace/project",
      parentModel: "openai/gpt-parent",
      parentThinking: "high" as const,
    };
    const prepared = await prepareAgentRun(request, { tempRoot, ...prepareOptions() });

    expect(prepared.command).toBe("/usr/bin/node");
    expect(prepared.cwd).toBe(request.cwd);
    expect(prepared.shell).toBe(false);
    expect(prepared.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(prepared.stdin).toBe(`Delegated task:\n${request.task}`);
    expect(prepared.args.join(" ")).not.toContain(request.task);
    expect(flagValue(prepared.args, "--append-system-prompt")).toBe(prepared.promptPath);
    expect(statSync(prepared.promptPath).mode & 0o777).toBe(0o600);
    expect(statSync(prepared.promptPath).isFile()).toBe(true);
    expect(readFileSync(prepared.promptPath, "utf8")).toBe(request.agent.systemPrompt);

    await prepared.cleanup();
    expect(() => statSync(prepared.promptPath)).toThrow();
    await prepared.cleanup();
  });

  it("resolves the gate for every role and Radius only for roles that declare it", async () => {
    const tempRoot = await temporaryDirectory();
    const radiusPath = join(tempRoot, "installed-radius.ts");
    writeFileSync(radiusPath, "export default () => {};\n");
    const gateResolver = vi.fn(() => GATE_PATH);
    const radiusResolver = vi.fn(() => radiusPath);

    const scoutRun = await prepareAgentRun(
      {
        agent: agent({ name: "scout", tools: ["read", "radius_web_search"] }),
        task: "Research current behavior",
        cwd: "/workspace",
      },
      prepareOptions({ tempRoot, resolvePermissionGateExtension: gateResolver, resolveRadiusExtension: radiusResolver }),
    );
    expect(gateResolver).toHaveBeenCalledOnce();
    expect(radiusResolver).toHaveBeenCalledOnce();
    expect(flagValues(scoutRun.args, "--extension")).toEqual([GATE_PATH, radiusPath]);
    await scoutRun.cleanup();

    gateResolver.mockClear();
    radiusResolver.mockClear();
    const workerRun = await prepareAgentRun(
      { agent: agent(), task: "Implement behavior", cwd: "/workspace" },
      prepareOptions({ tempRoot, resolvePermissionGateExtension: gateResolver, resolveRadiusExtension: radiusResolver }),
    );
    expect(gateResolver).toHaveBeenCalledOnce();
    expect(radiusResolver).not.toHaveBeenCalled();
    expect(flagValues(workerRun.args, "--extension")).toEqual([GATE_PATH]);
    await workerRun.cleanup();
  });

  it("does not accept an extension path from role data", async () => {
    const tempRoot = await temporaryDirectory();
    const radiusPath = join(tempRoot, "approved-radius.ts");
    mkdirSync(tempRoot, { recursive: true });
    const role = {
      ...agent({ name: "reviewer", tools: ["read", "radius_web_search"] }),
      extension: "/role-controlled/extension.ts",
      extensions: ["/another/role-extension.ts"],
      permissionGate: "/role-controlled/gate.ts",
    } as AgentConfig;
    const prepared = await prepareAgentRun(
      { agent: role, task: "Review", cwd: "/workspace" },
      prepareOptions({ tempRoot, resolveRadiusExtension: () => radiusPath }),
    );

    expect(flagValues(prepared.args, "--extension")).toEqual([GATE_PATH, radiusPath]);
    expect(prepared.args).not.toContain("/role-controlled/extension.ts");
    expect(prepared.args).not.toContain("/another/role-extension.ts");
    expect(prepared.args).not.toContain("/role-controlled/gate.ts");
    await prepared.cleanup();
  });

  it("fails before creating a prompt when the gate cannot be resolved", async () => {
    const tempRoot = await temporaryDirectory();
    await expect(
      prepareAgentRun(
        { agent: agent(), task: "Implement behavior", cwd: "/workspace" },
        prepareOptions({
          tempRoot,
          resolvePermissionGateExtension() {
            throw new Error("Required permission-gate is missing. Install v0.4.0 with: pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0");
          },
        }),
      ),
    ).rejects.toThrow("Required permission-gate is missing");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("fails before spawn when the current Pi entrypoint is unusable", async () => {
    const tempRoot = await temporaryDirectory();
    await expect(
      prepareAgentRun(
        { agent: agent(), task: "Implement behavior", cwd: "/workspace" },
        prepareOptions({
          tempRoot,
          runtime: runtime({ execPath: "/usr/bin/node", argv: ["node"], exists: () => false }),
        }),
      ),
    ).rejects.toThrow(PI_INVOCATION_ERROR);
    expect(readdirSync(tempRoot)).toEqual([]);
  });
});

function sessionLine(): string {
  return `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session-id",
    timestamp: "2026-09-14T00:00:00.000Z",
    cwd: "/workspace",
  })}\n`;
}

function assistantEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
      provider: "openai",
      model: "gpt-test",
      stopReason: "stop",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 20,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      },
      ...overrides,
    },
  };
}

function jsonl(...events: Array<Record<string, unknown>>): string {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

describe("JsonlRunParser", () => {
  it("parses several events in one chunk and one event across chunks", () => {
    const parser = new JsonlRunParser({ startedAt: 100, now: () => 250 });
    const assistant = JSON.stringify(assistantEvent());
    parser.writeStdout(`${sessionLine()}\n`);
    parser.writeStdout(assistant.slice(0, 13));
    parser.writeStdout(assistant.slice(13));
    parser.writeStdout("\n");

    const result = parser.finish();
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe("Done");
    expect(result.model).toBe("openai/gpt-test");
    expect(result.progress).toMatchObject({ turns: 1, durationMs: 150, status: "succeeded" });
  });

  it("preserves Unicode split across buffer boundaries", () => {
    const parser = new JsonlRunParser();
    const payload = Buffer.from(`${sessionLine()}${jsonl(assistantEvent({ content: [{ type: "text", text: "A 🌍 B" }] }))}`);
    const emoji = Buffer.from("🌍");
    const splitAt = payload.indexOf(emoji) + 2;

    parser.writeStdout(payload.subarray(0, splitAt));
    parser.writeStdout(payload.subarray(splitAt));

    expect(parser.finish().output).toBe("A 🌍 B");
  });

  it("ignores blank lines and bounds malformed-line diagnostics", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(`\n  \n${sessionLine()}`);
    for (let index = 0; index < 8; index++) {
      parser.writeStdout(`not-json-${index}-${"x".repeat(400)}\n`);
    }
    parser.writeStdout(jsonl(assistantEvent()));

    const result = parser.finish();
    expect(result.status).toBe("succeeded");
    expect(result.malformedLineCount).toBe(8);
    expect(result.malformedLineSamples).toHaveLength(3);
    expect(result.malformedLineSamples.every((sample) => Buffer.byteLength(sample) <= 240)).toBe(true);
  });

  it("fails and discards a pending or completed JSONL record over 1 MiB", () => {
    const pendingParser = new JsonlRunParser();
    pendingParser.writeStdout("x".repeat(1024 * 1024 + 1));
    const pending = pendingParser.finish();
    expect(pending.status).toBe("failed");
    expect(pending.error).toContain("exceeded 1048576 bytes");
    expect(pending.malformedLineSamples).toEqual([]);

    const completedParser = new JsonlRunParser();
    completedParser.writeStdout(`${"x".repeat(1024 * 1024 + 1)}\n${sessionLine()}`);
    const completed = completedParser.finish();
    expect(completed.status).toBe("failed");
    expect(completed.sessionSeen).toBe(false);
  });

  it("requires a session record but tolerates isolated malformed lines", () => {
    const missingSession = new JsonlRunParser();
    missingSession.writeStdout(jsonl({ type: "session" }, assistantEvent()));
    expect(missingSession.finish()).toMatchObject({
      status: "failed",
      error: "child output did not contain a valid session record",
    });

    const usable = new JsonlRunParser();
    usable.writeStdout(`malformed\n${sessionLine()}${jsonl(assistantEvent())}`);
    expect(usable.finish()).toMatchObject({ status: "succeeded", malformedLineCount: 1 });
  });

  it("tracks interleaved active tools, overflow, out-of-order ends, and a five-item recent ring", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    for (let index = 0; index < 18; index++) {
      parser.writeStdout(
        jsonl({
          type: "tool_execution_start",
          toolCallId: `tool-${index}`,
          toolName: index % 2 === 0 ? "read" : "grep",
          args: { path: `/very/long/${"x".repeat(300)}/${index}` },
        }),
      );
    }

    expect(parser.snapshot()).toMatchObject({ toolCalls: 18, activeToolOverflow: 2 });
    expect(parser.snapshot().activeTools).toHaveLength(16);
    expect(parser.snapshot().activeTools.every((tool) => Buffer.byteLength(tool.preview) <= 240)).toBe(true);

    for (const index of [3, 1, 17, 16, 2, 4, 5]) {
      parser.writeStdout(
        jsonl({
          type: "tool_execution_end",
          toolCallId: `tool-${index}`,
          toolName: index % 2 === 0 ? "read" : "grep",
          args: { path: `/file-${index}` },
        }),
      );
    }

    const progress = parser.snapshot();
    expect(progress.activeToolOverflow).toBe(0);
    expect(progress.activeTools.map((tool) => tool.id)).not.toContain("tool-1");
    expect(progress.activeTools.map((tool) => tool.id)).not.toContain("tool-3");
    expect(progress.recentTools).toHaveLength(5);
    expect(progress.recentTools.map((tool) => tool.name)).toEqual(["grep", "read", "read", "read", "grep"]);
  });

  it("retains tool_execution_end isError on completed tools", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        {
          type: "tool_execution_start",
          toolCallId: "blocked",
          toolName: "bash",
          args: { command: "rm secret" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "blocked",
          toolName: "bash",
          isError: true,
          result: { content: [{ type: "text", text: "blocked" }] },
        },
        {
          type: "tool_execution_start",
          toolCallId: "ok",
          toolName: "read",
          args: { path: "src/auth.ts" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "ok",
          toolName: "read",
          isError: false,
        },
        {
          type: "tool_execution_end",
          toolCallId: "unmatched",
          toolName: "grep",
          isError: true,
        },
      ),
    );

    expect(parser.snapshot().recentTools).toEqual([
      { name: "bash", preview: expect.stringContaining("rm secret"), isError: true, errorPreview: "blocked" },
      { name: "read", preview: expect.stringContaining("src/auth.ts"), isError: false },
    ]);
  });

  it("treats missing or non-boolean isError as an ordinary error, not success or a gate block", () => {
    const trailer = `Blocked by permission-gate: privilege escalation.\n${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({
      disposition: "denied_by_policy",
      rules: ["bash.privilege_escalation"],
    })}`;
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        {
          type: "tool_execution_start",
          toolCallId: "missing",
          toolName: "bash",
          args: { command: "sudo true" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "missing",
          toolName: "bash",
          result: { content: [{ type: "text", text: trailer }] },
        },
        {
          type: "tool_execution_start",
          toolCallId: "string-true",
          toolName: "bash",
          args: { command: "sudo true" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "string-true",
          toolName: "bash",
          isError: "true",
          result: { content: [{ type: "text", text: trailer }] },
        },
        {
          type: "tool_execution_start",
          toolCallId: "numeric",
          toolName: "read",
          args: { path: "src/auth.ts" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "numeric",
          toolName: "read",
          isError: 1,
          result: { content: [{ type: "text", text: "failed" }] },
        },
      ),
    );

    const recent = parser.snapshot().recentTools;
    expect(recent).toEqual([
      {
        name: "bash",
        preview: expect.stringContaining("sudo true"),
        isError: true,
        errorPreview: expect.stringContaining("Blocked by permission-gate"),
      },
      {
        name: "bash",
        preview: expect.stringContaining("sudo true"),
        isError: true,
        errorPreview: expect.stringContaining("Blocked by permission-gate"),
      },
      { name: "read", preview: expect.stringContaining("src/auth.ts"), isError: true, errorPreview: "failed" },
    ]);
    expect(recent.every((tool) => tool.block === undefined)).toBe(true);
    expect(parser.snapshot().reportedBlocks).toBeUndefined();
  });

  it("parses block trailers, strips display text, and aggregates independently of matching and recent eviction", () => {
    const deny = `Blocked by permission-gate: privilege escalation.\n${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({
      disposition: "denied_by_policy",
      rules: ["bash.privilege_escalation"],
    })}`;
    const confirm = `Blocked by permission-gate: confirmation required.\n${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({
      disposition: "confirmation_unavailable",
      rules: ["bash.destructive_command"],
    })}`;
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        {
          type: "tool_execution_end",
          toolCallId: "unmatched-deny",
          toolName: "bash",
          isError: true,
          result: { content: [{ type: "text", text: deny }] },
        },
        {
          type: "tool_execution_start",
          toolCallId: "spoof-ok",
          toolName: "bash",
          args: { command: "echo ok" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "spoof-ok",
          toolName: "bash",
          isError: false,
          result: { content: [{ type: "text", text: deny }] },
        },
      ),
    );

    for (let index = 0; index < 6; index++) {
      parser.writeStdout(
        jsonl(
          {
            type: "tool_execution_start",
            toolCallId: `block-${index}`,
            toolName: "bash",
            args: { command: `rm file-${index}` },
          },
          {
            type: "tool_execution_end",
            toolCallId: `block-${index}`,
            toolName: "bash",
            isError: true,
            result: {
              content: [{
                type: "text",
                text: index === 0 ? confirm : `Blocked by permission-gate: deny ${index}.\n${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({
                  disposition: "denied_by_policy",
                  rules: [`bash.rule_${index}`],
                })}`,
              }],
            },
          },
        ),
      );
    }

    const progress = parser.snapshot();
    expect(progress.recentTools).toHaveLength(5);
    expect(progress.recentTools.every((tool) => tool.name !== undefined)).toBe(true);
    expect(progress.recentTools.some((tool) => tool.block?.disposition === "confirmation_unavailable")).toBe(false);
    expect(progress.reportedBlocks).toEqual({
      deniedByPolicy: 6,
      confirmationUnavailable: 1,
      rules: [
        "bash.privilege_escalation",
        "bash.destructive_command",
        "bash.rule_1",
        "bash.rule_2",
        "bash.rule_3",
        "bash.rule_4",
        "bash.rule_5",
      ],
      rulesOmitted: false,
    });
    expect(progress.recentTools.at(-1)?.block).toEqual({
      disposition: "denied_by_policy",
      rules: ["bash.rule_5"],
    });
    expect(progress.recentTools.at(-1)?.errorPreview).toBe("Blocked by permission-gate: deny 5.");
    expect(progress.recentTools.at(-1)?.errorPreview).not.toContain(PERMISSION_GATE_BLOCK_MARKER);
    expect(progress.recentTools.some((tool) => tool.errorPreview?.includes(PERMISSION_GATE_BLOCK_MARKER))).toBe(false);
  });

  it("keeps malformed, oversized, and successful spoofed trailers as ordinary tool errors", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        {
          type: "tool_execution_start",
          toolCallId: "ordinary",
          toolName: "bash",
          args: { command: "false" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "ordinary",
          toolName: "bash",
          isError: true,
          result: { content: [{ type: "text", text: "exit 1" }] },
        },
        {
          type: "tool_execution_start",
          toolCallId: "malformed",
          toolName: "bash",
          args: { command: "rm x" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "malformed",
          toolName: "bash",
          isError: true,
          result: {
            content: [{
              type: "text",
              text: `Blocked.\n${PERMISSION_GATE_BLOCK_MARKER}{not json}`,
            }],
          },
        },
      ),
    );

    const progress = parser.snapshot();
    expect(progress.reportedBlocks).toBeUndefined();
    expect(progress.recentTools.map((tool) => tool.block)).toEqual([undefined, undefined]);
    expect(progress.recentTools[0]?.isError).toBe(true);
    expect(progress.recentTools[0]?.errorPreview).toBe("exit 1");
  });

  it("tracks streaming text activity without exposing thinking or replacing final output", () => {
    let now = 1000;
    const parser = new JsonlRunParser({ startedAt: 1000, now: () => now });
    parser.writeStdout(sessionLine());
    parser.writeStdout(jsonl({ type: "message_start", message: { role: "assistant", content: [] } }));
    parser.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
      }),
    );
    parser.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "secret chain of thought" },
      }),
    );
    parser.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "secret chain of thought" },
      }),
    );

    const progress = parser.snapshot();
    expect(progress.generating).toBe(true);
    expect(progress.lastTextPreview).toBeUndefined();
    expect(JSON.stringify(progress)).not.toContain("secret chain of thought");
    expect(parser.finish().output).toBe("");

    const streaming = new JsonlRunParser({ startedAt: 1000, now: () => now });
    streaming.writeStdout(sessionLine());
    streaming.writeStdout(jsonl({ type: "message_start", message: { role: "assistant", content: [] } }));
    streaming.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Partial " },
      }),
    );
    expect(streaming.snapshot()).toMatchObject({
      generating: true,
      lastTextPreview: "Partial ",
      lastActivityAgoMs: 0,
    });
    expect(streaming.finish().output).toBe("");

    const complete = new JsonlRunParser({ startedAt: 1000, now: () => now });
    complete.writeStdout(sessionLine());
    complete.writeStdout(jsonl({ type: "message_start", message: { role: "assistant", content: [] } }));
    complete.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "hidden reasoning" },
      }),
    );
    complete.writeStdout(
      jsonl({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Draft" },
      }),
    );
    now = 2500;
    expect(complete.snapshot()).toMatchObject({
      durationMs: 1500,
      lastActivityAgoMs: 1500,
      lastTextPreview: "Draft",
      generating: true,
    });
    now = 2600;
    complete.writeStdout(
      jsonl({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: "running" }] },
      }),
    );
    expect(complete.snapshot().lastActivityAgoMs).toBe(0);
    complete.writeStdout(
      jsonl(
        assistantEvent({
          content: [
            { type: "thinking", thinking: "hidden reasoning" },
            { type: "text", text: "Final answer" },
          ],
        }),
      ),
    );

    const result = complete.finish();
    expect(result.output).toBe("Final answer");
    expect(result.progress.lastTextPreview).toBe("Final answer");
    expect(result.progress.generating).toBe(false);
    expect(result.output).not.toContain("hidden reasoning");
    expect(result.progress.lastTextPreview).not.toContain("hidden reasoning");
  });

  it("does not claim generation for non-assistant message_start or message_end", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl({
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "Delegated task:\nInspect auth" }] },
      }),
    );
    expect(parser.snapshot()).toMatchObject({ generating: false, turns: 0 });
    expect(parser.snapshot().lastTextPreview).toBeUndefined();

    parser.writeStdout(
      jsonl({
        type: "message_end",
        message: { role: "user", content: [{ type: "text", text: "Delegated task:\nInspect auth" }] },
      }),
    );
    expect(parser.snapshot()).toMatchObject({ generating: false, turns: 0 });
    expect(parser.snapshot().lastTextPreview).toBeUndefined();

    parser.writeStdout(
      jsonl({
        type: "message_start",
        message: { role: "system", content: "Internal instructions" },
      }),
    );
    parser.writeStdout(
      jsonl({
        type: "message_end",
        message: { role: "system", content: "Internal instructions" },
      }),
    );
    expect(parser.snapshot()).toMatchObject({ generating: false, turns: 0 });

    parser.writeStdout(jsonl({ type: "message_start" }));
    parser.writeStdout(jsonl({ type: "message_end", message: "not-a-record" }));
    expect(parser.snapshot().generating).toBe(false);
    expect(parser.snapshot().turns).toBe(0);

    parser.writeStdout(jsonl({ type: "message_start", message: { role: "assistant", content: [] } }));
    expect(parser.snapshot().generating).toBe(true);
  });

  it("bounds the streaming text accumulator across multiple deltas", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(jsonl({ type: "message_start", message: { role: "assistant", content: [] } }));
    for (let index = 0; index < 10; index++) {
      parser.writeStdout(
        jsonl({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `chunk-${index}-${"🌍".repeat(40)}` },
        }),
      );
    }

    const progress = parser.snapshot();
    expect(progress.generating).toBe(true);
    expect(Buffer.byteLength(progress.lastTextPreview ?? "")).toBeLessThanOrEqual(512);
    expect(progress.lastTextPreview).not.toContain("�");
    expect(Buffer.byteLength((parser as unknown as { streamingText: string }).streamingText)).toBeLessThanOrEqual(512);
  });

  it("uses the latest non-empty assistant text and bounds its preview", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(jsonl(assistantEvent({ content: [{ type: "text", text: "First" }] })));
    parser.writeStdout(jsonl(assistantEvent({ content: [{ type: "text", text: "" }] })));
    parser.writeStdout(
      jsonl(assistantEvent({ content: [{ type: "text", text: `Latest ${"🌍".repeat(300)}` }] })),
    );

    const result = parser.finish();
    expect(result.output.startsWith("Latest")).toBe(true);
    expect(result.progress.turns).toBe(3);
    expect(Buffer.byteLength(result.progress.lastTextPreview ?? "")).toBeLessThanOrEqual(512);
    expect(result.progress.lastTextPreview).not.toContain("�");
  });

  it("captures assistant stop reasons and bounded provider errors", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        assistantEvent({
          content: [],
          stopReason: "error",
          errorMessage: `Provider failed: ${"x".repeat(1000)}`,
        }),
      ),
    );

    const result = parser.finish();
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("error");
    expect(result.error).toContain("Provider failed");
    expect(Buffer.byteLength(result.error ?? "")).toBeLessThanOrEqual(512);
  });

  it("bounds stderr to its final 64 KiB without broken leading Unicode", () => {
    const parser = new JsonlRunParser();
    parser.writeStderr(`discard-${"a".repeat(70 * 1024)}`);
    parser.writeStderr("🌍 final diagnostic");
    parser.writeStdout(`${sessionLine()}${jsonl(assistantEvent())}`);

    const result = parser.finish();
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(result.stderr).toContain("🌍 final diagnostic");
    expect(result.stderr).not.toContain("�");
  });

  it("classifies non-zero exits and missing final output as failures", () => {
    const exited = new JsonlRunParser();
    exited.writeStdout(`${sessionLine()}${jsonl(assistantEvent())}`);
    expect(exited.finish({ exitCode: 7 })).toMatchObject({
      status: "failed",
      error: "child process exited with code 7",
    });

    const empty = new JsonlRunParser();
    empty.writeStdout(sessionLine());
    expect(empty.finish()).toMatchObject({
      status: "failed",
      error: "child output did not contain a usable final assistant response",
    });
  });
});

describe("usage and output accounting", () => {
  it("sums the complete usage shape across turns", () => {
    const parser = new JsonlRunParser();
    parser.writeStdout(sessionLine());
    parser.writeStdout(
      jsonl(
        assistantEvent({
          usage: {
            input: 10,
            output: 5,
            cacheRead: 3,
            cacheWrite: 2,
            cacheWrite1h: 1,
            reasoning: 4,
            totalTokens: 20,
            cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
          },
        }),
        assistantEvent({
          usage: {
            input: 20,
            output: 10,
            cacheRead: 6,
            cacheWrite: 4,
            cacheWrite1h: 2,
            reasoning: 8,
            totalTokens: 40,
            cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
          },
        }),
      ),
    );

    expect(parser.finish().usage).toEqual({
      input: 30,
      output: 15,
      cacheRead: 9,
      cacheWrite: 6,
      cacheWrite1h: 3,
      reasoning: 12,
      totalTokens: 60,
      cost: { input: 3, output: 6, cacheRead: 9, cacheWrite: 12, total: 30 },
    });
  });

  it("aggregates usage across runs while preserving optional fields only when reported", () => {
    const first: Usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite1h: 5,
      totalTokens: 10,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const second: Usage = {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      reasoning: 6,
      totalTokens: 100,
      cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
    };

    expect(aggregateUsage([first, second])).toEqual({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      cacheWrite1h: 5,
      reasoning: 6,
      totalTokens: 110,
      cost: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
    });
    expect(aggregateUsage([])).not.toHaveProperty("cacheWrite1h");
    expect(aggregateUsage([])).not.toHaveProperty("reasoning");
  });

  it("bounds final output by bytes and lines and includes an exact truncation notice", () => {
    const byBytes = boundFinalOutput("x".repeat(60 * 1024));
    expect(Buffer.byteLength(byBytes)).toBeLessThanOrEqual(50 * 1024);
    expect(byBytes).toContain("[Output truncated:");

    const byLines = boundFinalOutput(Array.from({ length: 2500 }, (_, index) => `line ${index}`).join("\n"));
    expect(byLines.split("\n")).toHaveLength(2000);
    expect(byLines).toContain("of 2500 lines");
  });

  it("reserves a generated suffix so truncation cannot remove it", () => {
    const suffix = "Reported blocks: 1 policy denial. Blocked attempts did not complete; related work remains unresolved unless completed independently.";
    const bounded = boundOutputReservingSuffix("x".repeat(60 * 1024), suffix);
    expect(bounded.endsWith(suffix)).toBe(true);
    expect(bounded).toContain("[Output truncated:");
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(50 * 1024);
  });
});

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signals: NodeJS.Signals[] = [];
  stdinText = "";

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => {
      this.stdinText += chunk.toString("utf8");
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }

  fail(error: Error & { code?: string }): void {
    this.emit("error", error);
  }
}

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agent: agent(),
    task: "Implement the delegated change",
    cwd: "/workspace/project",
    ...overrides,
  };
}

function fakeSpawn(child: FakeChild): ReturnType<typeof vi.fn<SpawnChild>> {
  return vi.fn<SpawnChild>(() => child);
}

function interceptHeartbeats(): { fire(): void; state: { started: number; cleared: number } } {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const handlers = new Map<unknown, () => void>();
  const state = { started: 0, cleared: 0 };

  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: (...handlerArgs: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    if (delay === 1000) {
      state.started++;
      const token = { id: state.started };
      handlers.set(token, () => handler(...args));
      return token as unknown as ReturnType<typeof setInterval>;
    }
    return originalSetInterval(handler, delay, ...args);
  }) as typeof setInterval);

  vi.spyOn(globalThis, "clearInterval").mockImplementation(((token: unknown) => {
    if (handlers.has(token)) {
      state.cleared++;
      handlers.delete(token);
      return;
    }
    originalClearInterval(token as ReturnType<typeof setInterval>);
  }) as typeof clearInterval);

  return {
    state,
    fire() {
      for (const handler of handlers.values()) handler();
    },
  };
}

async function waitForSpawn(spawn: ReturnType<typeof vi.fn<SpawnChild>>): Promise<void> {
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
}

function emitSuccessfulRun(child: FakeChild, output = "Completed work"): void {
  child.stdout.write(sessionLine());
  child.stdout.write(jsonl(assistantEvent({ content: [{ type: "text", text: output }] })));
  child.close(0);
}

describe("runAgent process lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns once, pipes the task, parses output, reports progress, and cleans its prompt", async () => {
    const tempRoot = await temporaryDirectory();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const progress = vi.fn();
    const request = runRequest();
    const promise = runAgent(request, { tempRoot, ...prepareOptions(), spawn, onProgress: progress });

    await waitForSpawn(spawn);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      expect.arrayContaining(["/opt/pi/cli.js", "--mode", "json", "--no-extensions", "--extension", GATE_PATH]),
      { cwd: request.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(child.stdinText).toBe(`Delegated task:\n${request.task}`);

    emitSuccessfulRun(child);
    const result = await promise;
    expect(result).toMatchObject({
      agent: "worker",
      taskPreview: request.task,
      status: "succeeded",
      output: "Completed work",
      model: "openai/gpt-test",
    });
    expect(progress.mock.calls.at(0)?.[0].status).toBe("running");
    expect(progress.mock.calls.at(-1)?.[0].status).toBe("succeeded");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("classifies non-zero exits with bounded stderr and cleans parser failures", async () => {
    const tempRoot = await temporaryDirectory();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const promise = runAgent(runRequest(), { tempRoot, ...prepareOptions(), spawn });

    await waitForSpawn(spawn);
    child.stdout.write(sessionLine());
    child.stderr.write(`command failed\n${"x".repeat(10_000)}`);
    child.close(9);

    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited with code 9");
    expect(result.error).toContain("command failed");
    expect(Buffer.byteLength(result.error ?? "")).toBeLessThanOrEqual(4096);
    expect(readdirSync(tempRoot)).toEqual([]);

    const oversizedChild = new FakeChild();
    const oversizedSpawn = fakeSpawn(oversizedChild);
    const oversizedPromise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn: oversizedSpawn,
    });
    await waitForSpawn(oversizedSpawn);
    oversizedChild.stdout.write("x".repeat(1024 * 1024 + 1));
    expect(oversizedChild.signals).toEqual(["SIGTERM"]);
    oversizedChild.close(null, "SIGTERM");
    expect((await oversizedPromise).error).toContain("JSONL record exceeded");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it.each([
    ["ENOENT", "Pi executable could not be resolved"],
    ["EACCES", "Resolved Pi executable is not runnable"],
    ["UNKNOWN", "Could not start subagent 'worker': UNKNOWN"],
  ])("classifies synchronous %s spawn errors", async (code, expected) => {
    const tempRoot = await temporaryDirectory();
    const error = Object.assign(new Error("spawn failed"), { code });
    const spawn: SpawnChild = () => {
      throw error;
    };

    const result = await runAgent(runRequest(), { tempRoot, ...prepareOptions(), spawn });
    expect(result).toMatchObject({ status: "failed", error: expected });
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("classifies emitted spawn errors after close and removes the prompt", async () => {
    const tempRoot = await temporaryDirectory();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const promise = runAgent(runRequest(), { tempRoot, ...prepareOptions(), spawn });

    await waitForSpawn(spawn);
    child.fail(Object.assign(new Error("not found"), { code: "ENOENT" }));
    child.close(-2);

    expect(await promise).toMatchObject({
      status: "failed",
      error: "Pi executable could not be resolved",
    });
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("does not spawn when the gate cannot be resolved", async () => {
    const tempRoot = await temporaryDirectory();
    const spawn = fakeSpawn(new FakeChild());

    await expect(
      runAgent(runRequest(), {
        tempRoot,
        ...prepareOptions({
          resolvePermissionGateExtension() {
            throw new Error("Required permission-gate is missing");
          },
        }),
        spawn,
      }),
    ).rejects.toThrow("Required permission-gate is missing");
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("does not spawn when already aborted", async () => {
    const tempRoot = await temporaryDirectory();
    const controller = new AbortController();
    controller.abort();
    const spawn = fakeSpawn(new FakeChild());

    const result = await runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(spawn).not.toHaveBeenCalled();
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("sends SIGTERM once and does not escalate when the child exits during grace", async () => {
    const tempRoot = await temporaryDirectory();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const promise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      signal: controller.signal,
    });

    await waitForSpawn(spawn);
    vi.useFakeTimers();
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    child.close(null, "SIGTERM");

    const result = await promise;
    await vi.advanceTimersByTimeAsync(5000);
    expect(result.status).toBe("cancelled");
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(removeListener).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("escalates to SIGKILL after grace when exitCode is still null", async () => {
    const tempRoot = await temporaryDirectory();
    const controller = new AbortController();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const promise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      signal: controller.signal,
      killGraceMs: 5000,
    });

    await waitForSpawn(spawn);
    vi.useFakeTimers();
    controller.abort();
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.close(null, "SIGKILL");

    expect((await promise).status).toBe("cancelled");
    expect(vi.getTimerCount()).toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("marks an externally signalled process as failed", async () => {
    const tempRoot = await temporaryDirectory();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const promise = runAgent(runRequest(), { tempRoot, ...prepareOptions(), spawn });

    await waitForSpawn(spawn);
    child.stdout.write(`${sessionLine()}${jsonl(assistantEvent())}`);
    child.close(null, "SIGTERM");

    expect(await promise).toMatchObject({
      status: "failed",
      error: "Child process exited due to signal SIGTERM",
    });
  });
});

describe("runAgent heartbeats", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits a one-second heartbeat that does not reset observed activity", async () => {
    const heartbeats = interceptHeartbeats();
    const tempRoot = await temporaryDirectory();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    let now = 1000;
    const progress = vi.fn();
    const promise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      now: () => now,
      onProgress: progress,
    });

    await waitForSpawn(spawn);
    expect(heartbeats.state.started).toBe(1);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ status: "running", generating: false });
    expect(progress.mock.calls.at(-1)?.[0]).not.toHaveProperty("lastActivityAgoMs");

    child.stdout.write(sessionLine());
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "running",
      lastActivityAgoMs: 0,
    });

    now = 3500;
    heartbeats.fire();
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
      status: "running",
      durationMs: 2500,
      lastActivityAgoMs: 2500,
    });

    emitSuccessfulRun(child);
    expect((await promise).status).toBe("succeeded");
    expect(heartbeats.state.cleared).toBe(1);

    const calls = progress.mock.calls.length;
    heartbeats.fire();
    expect(progress.mock.calls.length).toBe(calls);
  });

  it("does not start a heartbeat when spawn throws", async () => {
    const heartbeats = interceptHeartbeats();
    const tempRoot = await temporaryDirectory();
    const spawn: SpawnChild = () => {
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    };

    const result = await runAgent(runRequest(), { tempRoot, ...prepareOptions(), spawn });
    expect(result).toMatchObject({ status: "failed", error: "Pi executable could not be resolved" });
    expect(heartbeats.state.started).toBe(0);
    expect(heartbeats.state.cleared).toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("does not start a heartbeat if termination already began", async () => {
    const heartbeats = interceptHeartbeats();
    const tempRoot = await temporaryDirectory();
    const controller = new AbortController();
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const progress = vi.fn((update: { status: string }) => {
      if (update.status === "running" && !controller.signal.aborted) controller.abort();
    });
    const promise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      signal: controller.signal,
      onProgress: progress,
    });

    await waitForSpawn(spawn);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(heartbeats.state.started).toBe(0);
    expect(heartbeats.state.cleared).toBe(0);

    const calls = progress.mock.calls.length;
    expect(progress.mock.calls.at(-1)?.[0].status).toBe("running");
    heartbeats.fire();
    expect(progress.mock.calls.length).toBe(calls);

    child.close(null, "SIGTERM");
    expect((await promise).status).toBe("cancelled");
    expect(progress.mock.calls.at(-1)?.[0].status).toBe("cancelled");
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it.each([
    {
      label: "cancellation",
      failInput: false,
      trigger(child: FakeChild, controller: AbortController) {
        controller.abort();
        expect(child.signals).toEqual(["SIGTERM"]);
      },
      close(child: FakeChild) {
        child.close(null, "SIGTERM");
      },
      expected: { status: "cancelled", error: "Subagent cancelled" },
    },
    {
      label: "protocol failure",
      failInput: false,
      trigger(child: FakeChild) {
        child.stdout.write("x".repeat(1024 * 1024 + 1));
        expect(child.signals).toEqual(["SIGTERM"]);
      },
      close(child: FakeChild) {
        child.close(null, "SIGTERM");
      },
      expected: { status: "failed" },
    },
    {
      label: "emitted spawn error",
      failInput: false,
      trigger(child: FakeChild) {
        child.fail(Object.assign(new Error("not found"), { code: "ENOENT" }));
      },
      close(child: FakeChild) {
        child.close(-2);
      },
      expected: { status: "failed", error: "Pi executable could not be resolved" },
    },
    {
      label: "input failure",
      failInput: true,
      trigger(child: FakeChild) {
        expect(child.signals).toEqual(["SIGTERM"]);
      },
      close(child: FakeChild) {
        child.close(1);
      },
      expected: { status: "failed" },
    },
  ])("stops nonterminal progress on $label before close", async ({ failInput, trigger, close, expected }) => {
    const heartbeats = interceptHeartbeats();
    const tempRoot = await temporaryDirectory();
    const controller = new AbortController();
    const child = new FakeChild();
    if (failInput) {
      child.stdin.end = (() => {
        throw new Error("broken pipe");
      }) as typeof child.stdin.end;
    }
    const spawn = fakeSpawn(child);
    const progress = vi.fn();
    const promise = runAgent(runRequest(), {
      tempRoot,
      ...prepareOptions(),
      spawn,
      signal: controller.signal,
      onProgress: progress,
    });

    await waitForSpawn(spawn);
    trigger(child, controller);

    if (failInput) {
      expect(heartbeats.state.started).toBe(0);
      expect(heartbeats.state.cleared).toBe(0);
    } else {
      expect(heartbeats.state.started).toBe(1);
      expect(heartbeats.state.cleared).toBe(1);
    }

    const calls = progress.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(progress.mock.calls.at(-1)?.[0].status).toBe("running");
    heartbeats.fire();
    expect(progress.mock.calls.length).toBe(calls);

    close(child);
    const result = await promise;
    expect(result).toMatchObject(expected);
    expect(progress.mock.calls.at(-1)?.[0].status).toBe(expected.status);
    expect(readdirSync(tempRoot)).toEqual([]);

    const afterClose = progress.mock.calls.length;
    heartbeats.fire();
    expect(progress.mock.calls.length).toBe(afterClose);
  });
});
