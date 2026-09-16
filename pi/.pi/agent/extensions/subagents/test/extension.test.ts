import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentDiscovery } from "../agents.ts";
import {
  FifoSemaphore,
  registerSubagentExtension,
  type SubagentDetails,
  type SubagentParams,
} from "../index.ts";
import type { RunProgress, RunRequest, RunResult } from "../runner.ts";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: SubagentDetails;
  usage?: Usage;
}

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolResult) => void) | undefined,
    context: unknown,
  ): Promise<ToolResult>;
}

interface TestDependencies {
  discoverAgents(): AgentDiscovery;
  resolvePermissionGateExtension(): string;
  resolveRadiusExtension(): string;
  runAgent(
    request: RunRequest,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: RunProgress) => void;
      resolvePermissionGateExtension?: () => string;
      resolveRadiusExtension?: () => string;
    },
  ): Promise<RunResult>;
  workingDirectoryAvailable(cwd: string): boolean;
  semaphore: FifoSemaphore;
}

function role(name: "scout" | "reviewer" | "worker"): AgentConfig {
  const readOnly = name !== "worker";
  return {
    name,
    description: `${name} role`,
    tools: readOnly
      ? ["read", "grep", "find", "ls", "radius_web_search"]
      : ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPrompt: `${name} instructions`,
    filePath: `/extension/agents/${name}.md`,
  };
}

function usage(value = 1): Usage {
  return {
    input: value,
    output: value,
    cacheRead: value,
    cacheWrite: value,
    totalTokens: value * 4,
    cost: {
      input: value,
      output: value,
      cacheRead: value,
      cacheWrite: value,
      total: value * 4,
    },
  };
}

function progress(status: RunProgress["status"]): RunProgress {
  return {
    status,
    activeTools: [],
    activeToolOverflow: 0,
    recentTools: [],
    toolCalls: 0,
    turns: status === "succeeded" ? 1 : 0,
    durationMs: 10,
    generating: false,
  };
}

function result(request: RunRequest, overrides: Partial<RunResult> = {}): RunResult {
  return {
    agent: request.agent.name,
    taskPreview: request.task,
    status: "succeeded",
    output: `output:${request.task}`,
    usage: usage(),
    progress: progress("succeeded"),
    ...overrides,
  };
}

function dependencies(overrides: Partial<TestDependencies> = {}): TestDependencies {
  return {
    discoverAgents: () => ({ agents: [role("reviewer"), role("scout"), role("worker")], diagnostics: [] }),
    resolvePermissionGateExtension: () => "/approved/permission-gate/index.ts",
    resolveRadiusExtension: () => "/approved/radius-web-search.ts",
    runAgent: async (request) => result(request),
    workingDirectoryAvailable: () => true,
    semaphore: new FifoSemaphore(4),
    ...overrides,
  };
}

function captureTool(overrides: Partial<TestDependencies> = {}): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(tool: unknown) {
      captured = tool as CapturedTool;
    },
  } as unknown as ExtensionAPI;
  registerSubagentExtension(pi, dependencies(overrides));
  if (!captured) throw new Error("Tool was not registered");
  return captured;
}

function context(overrides: Record<string, unknown> = {}): unknown {
  return {
    cwd: "/workspace",
    model: { provider: "openai", id: "gpt-parent" },
    thinkingLevel: "high",
    ...overrides,
  };
}

function invoke(
  tool: CapturedTool,
  tasks: SubagentParams["tasks"],
  options: { signal?: AbortSignal; onUpdate?: (result: ToolResult) => void; context?: unknown } = {},
): Promise<ToolResult> {
  return tool.execute(
    "tool-call",
    { tasks },
    options.signal,
    options.onUpdate,
    options.context ?? context(),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("subagent tool registration", () => {
  it("registers exactly the strict task-array schema with discovered StringEnum roles", () => {
    let registrations = 0;
    let captured: CapturedTool | undefined;
    const pi = {
      registerTool(tool: unknown) {
        registrations++;
        captured = tool as CapturedTool;
      },
    } as unknown as ExtensionAPI;
    registerSubagentExtension(pi, dependencies());

    expect(registrations).toBe(1);
    expect(captured?.name).toBe("subagent");
    expect(captured?.description).toContain("no parent conversation transcript");
    expect(captured?.description).toContain("reviewer: reviewer role");
    expect(captured?.description).toContain("Use direct Pi tools");

    const schema = captured?.parameters as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: {
        tasks: {
          minItems: number;
          maxItems: number;
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: {
              agent: { type: string; enum: string[] };
              task: { minLength: number; maxLength: number };
            };
          };
        };
      };
    };
    expect(Object.keys(schema.properties)).toEqual(["tasks"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["tasks"]);
    expect(schema.properties.tasks).toMatchObject({ minItems: 1, maxItems: 4 });
    expect(schema.properties.tasks.items.additionalProperties).toBe(false);
    expect(schema.properties.tasks.items.required).toEqual(["agent", "task"]);
    expect(Object.keys(schema.properties.tasks.items.properties)).toEqual(["agent", "task"]);
    expect(schema.properties.tasks.items.properties.agent).toEqual({
      type: "string",
      enum: ["reviewer", "scout", "worker"],
      description: "Subagent role name",
    });
    expect(schema.properties.tasks.items.properties.task).toMatchObject({ minLength: 1, maxLength: 65_536 });
  });

  it("warns for invalid files and does not register without a valid role", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerTool = vi.fn();
    const pi = { registerTool } as unknown as ExtensionAPI;
    registerSubagentExtension(
      pi,
      dependencies({
        discoverAgents: () => ({
          agents: [],
          diagnostics: [{ filePath: "/agents/bad.md", message: "invalid frontmatter" }],
        }),
      }),
    );

    expect(registerTool).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("/agents/bad.md"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("not registered"));
    warning.mockRestore();
  });
});

describe("subagent preflight", () => {
  it("rejects every task before launching when any role is unknown", async () => {
    const runAgent = vi.fn<TestDependencies["runAgent"]>();
    const tool = captureTool({ runAgent });

    await expect(
      invoke(tool, [
        { agent: "worker", task: "valid" },
        { agent: "missing", task: "invalid" },
      ]),
    ).rejects.toThrow("Unknown subagent 'missing'");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("enforces one to four tasks even when execute is called without schema validation", async () => {
    const runAgent = vi.fn<TestDependencies["runAgent"]>();
    const tool = captureTool({ runAgent });

    await expect(invoke(tool, [])).rejects.toThrow("between one and four tasks");
    await expect(
      invoke(tool, Array.from({ length: 5 }, (_, index) => ({ agent: "worker", task: `task-${index}` }))),
    ).rejects.toThrow("between one and four tasks");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects unavailable working directories and UTF-8 tasks over 64 KiB before launch", async () => {
    const runAgent = vi.fn<TestDependencies["runAgent"]>();
    const unavailable = captureTool({ runAgent, workingDirectoryAvailable: () => false });
    await expect(invoke(unavailable, [{ agent: "worker", task: "work" }])).rejects.toThrow(
      "working directory is unavailable",
    );
    expect(runAgent).not.toHaveBeenCalled();

    const available = captureTool({ runAgent, workingDirectoryAvailable: () => true });
    await expect(invoke(available, [{ agent: "worker", task: "🌍".repeat(20_000) }])).rejects.toThrow(
      "64 KiB limit",
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("resolves the gate and Radius once before launch and passes only those resolved paths to runners", async () => {
    const resolvePermissionGateExtension = vi.fn(() => "/approved/permission-gate/index.ts");
    const resolveRadiusExtension = vi.fn(() => "/approved/radius.ts");
    const runAgent = vi.fn<TestDependencies["runAgent"]>(async (request, options) => {
      expect(options.resolvePermissionGateExtension?.()).toBe("/approved/permission-gate/index.ts");
      expect(options.resolveRadiusExtension?.()).toBe("/approved/radius.ts");
      return result(request);
    });
    const tool = captureTool({ resolvePermissionGateExtension, resolveRadiusExtension, runAgent });

    await invoke(tool, [
      { agent: "scout", task: "research" },
      { agent: "reviewer", task: "review" },
    ]);
    expect(resolvePermissionGateExtension).toHaveBeenCalledOnce();
    expect(resolveRadiusExtension).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledTimes(2);
  });

  it("resolves the gate for worker-only calls without resolving Radius", async () => {
    const resolvePermissionGateExtension = vi.fn(() => "/approved/permission-gate/index.ts");
    const resolveRadiusExtension = vi.fn(() => "/approved/radius.ts");
    const runAgent = vi.fn<TestDependencies["runAgent"]>(async (request, options) => {
      expect(options.resolvePermissionGateExtension?.()).toBe("/approved/permission-gate/index.ts");
      expect(options.resolveRadiusExtension).toBeUndefined();
      return result(request);
    });
    const tool = captureTool({ resolvePermissionGateExtension, resolveRadiusExtension, runAgent });

    await invoke(tool, [{ agent: "worker", task: "implement" }]);
    expect(resolvePermissionGateExtension).toHaveBeenCalledOnce();
    expect(resolveRadiusExtension).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("fails the entire call when the gate cannot be resolved", async () => {
    const runAgent = vi.fn<TestDependencies["runAgent"]>();
    const resolveRadiusExtension = vi.fn(() => "/approved/radius.ts");
    const tool = captureTool({
      runAgent,
      resolveRadiusExtension,
      resolvePermissionGateExtension() {
        throw new Error("Install v0.4.0 with: pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0");
      },
    });

    await expect(invoke(tool, [{ agent: "scout", task: "research" }])).rejects.toThrow(
      "pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0",
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(resolveRadiusExtension).not.toHaveBeenCalled();
  });

  it("fails the entire call when Radius cannot be resolved", async () => {
    const runAgent = vi.fn<TestDependencies["runAgent"]>();
    const tool = captureTool({
      runAgent,
      resolveRadiusExtension() {
        throw new Error("Install with: pi install npm:@earendil-works/pi-radius");
      },
    });

    await expect(invoke(tool, [{ agent: "scout", task: "research" }])).rejects.toThrow(
      "pi install npm:@earendil-works/pi-radius",
    );
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("tool result policy", () => {
  it("returns direct single output, stable details, aggregate usage, and parent defaults", async () => {
    const updates: ToolResult[] = [];
    const runAgent = vi.fn<TestDependencies["runAgent"]>(async (request, options) => {
      expect(request).toMatchObject({
        task: "implement",
        cwd: "/workspace",
        parentModel: "openai/gpt-parent",
        parentThinking: "high",
      });
      options.onProgress?.(progress("running"));
      return result(request, { output: "finished", usage: usage(3) });
    });
    const tool = captureTool({ runAgent });

    const execution = await invoke(tool, [{ agent: "worker", task: "implement" }], {
      onUpdate: (update) => updates.push(update),
    });
    expect(execution.content).toEqual([{ type: "text", text: "finished" }]);
    expect(execution.details).toMatchObject({ kind: "subagents", version: 1 });
    expect(execution.details.runs).toHaveLength(1);
    expect(execution.usage).toEqual(usage(3));
    expect(updates.at(0)?.details.runs[0]?.status).toBe("queued");
    expect(updates.at(-1)?.details.runs[0]?.status).toBe("succeeded");
  });

  it("throttles progress snapshots and flushes completion immediately", async () => {
    const updates: ToolResult[] = [];
    const runAgent: TestDependencies["runAgent"] = async (request, options) => {
      for (let index = 0; index < 20; index++) options.onProgress?.(progress("running"));
      await delay(180);
      for (let index = 0; index < 20; index++) options.onProgress?.(progress("running"));
      return result(request, { output: "complete" });
    };
    const tool = captureTool({ runAgent });

    await invoke(tool, [{ agent: "worker", task: "work" }], {
      onUpdate: (update) => updates.push(update),
    });

    expect(updates).toHaveLength(3);
    expect(updates.map((update) => update.details.runs[0]?.status)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);
  });

  it("preserves input order and returns unmistakable mixed parallel failures", async () => {
    const runAgent: TestDependencies["runAgent"] = async (request) => {
      if (request.task === "slow") {
        await delay(20);
        return result(request, { output: "slow result", usage: usage(2) });
      }
      await delay(1);
      return result(request, {
        status: "failed",
        output: "partial evidence",
        error: "review failed",
        usage: usage(4),
        progress: progress("failed"),
      });
    };
    const tool = captureTool({ runAgent });

    const execution = await invoke(tool, [
      { agent: "worker", task: "slow" },
      { agent: "reviewer", task: "fast failure" },
    ]);
    expect(execution.content[0]?.text).toMatch(/^Parallel: 1\/2 succeeded/);
    expect(execution.content[0]?.text.indexOf("## worker — succeeded")).toBeLessThan(
      execution.content[0]?.text.indexOf("## reviewer — failed") ?? 0,
    );
    expect(execution.content[0]?.text).toContain("Error: review failed");
    expect(execution.content[0]?.text).toContain("Partial output:");
    expect(execution.details.runs.map((run) => run.agent)).toEqual(["worker", "reviewer"]);
    expect(execution.usage).toEqual(usage(6));
  });

  it("throws for a single failure and waits for every all-failed parallel task", async () => {
    const completed: string[] = [];
    const runAgent: TestDependencies["runAgent"] = async (request) => {
      await delay(request.task === "first" ? 1 : 15);
      completed.push(request.task);
      return result(request, {
        status: "failed",
        output: "",
        error: `${request.task} failed`,
        progress: progress("failed"),
      });
    };
    const tool = captureTool({ runAgent });

    await expect(invoke(tool, [{ agent: "worker", task: "single" }])).rejects.toThrow(
      "Subagent worker failed: single failed",
    );
    await expect(
      invoke(tool, [
        { agent: "worker", task: "first" },
        { agent: "reviewer", task: "second" },
      ]),
    ).rejects.toThrow("All 2 subagents failed");
    expect(completed).toEqual(["single", "first", "second"]);
  });

  it("appends a reserved block summary to single and parallel content", async () => {
    const reportedBlocks = {
      deniedByPolicy: 2,
      confirmationUnavailable: 1,
      rules: ["bash.privilege_escalation"],
      rulesOmitted: false,
    };
    const tool = captureTool({
      runAgent: async (request) => result(request, {
        output: request.task === "huge" ? "x".repeat(60 * 1024) : `output:${request.task}`,
        progress: { ...progress("succeeded"), reportedBlocks },
      }),
    });

    const single = await invoke(tool, [{ agent: "worker", task: "implement" }]);
    expect(single.content[0]?.text).toContain("output:implement");
    expect(single.content[0]?.text).toContain("Reported blocks: 2 policy denials, 1 confirmation unavailable.");
    expect(single.content[0]?.text).toContain("Sampled rules: bash.privilege_escalation.");
    expect(single.content[0]?.text).toContain("Blocked attempts did not complete");
    expect(single.content[0]?.text).not.toContain("sudo");
    expect(single.details.version).toBe(1);

    const huge = await invoke(tool, [{ agent: "worker", task: "huge" }]);
    expect(huge.content[0]?.text).toContain("Reported blocks: 2 policy denials, 1 confirmation unavailable.");
    expect(huge.content[0]?.text.endsWith(
      "Blocked attempts did not complete; related work remains unresolved unless completed independently.",
    )).toBe(true);
    expect(Buffer.byteLength(huge.content[0]?.text ?? "")).toBeLessThanOrEqual(50 * 1024);

    const parallel = await invoke(tool, [
      { agent: "worker", task: "huge" },
      { agent: "reviewer", task: "huge" },
    ]);
    expect(parallel.content[0]?.text).toContain("Reported blocks:");
    expect(parallel.content[0]?.text).toContain("Blocked attempts did not complete");
    expect(Buffer.byteLength(parallel.content[0]?.text ?? "")).toBeLessThanOrEqual(50 * 1024);
    expect((parallel.content[0]?.text ?? "").split("\n").length).toBeLessThanOrEqual(2000);
  });

  it("keeps partial output and block summaries in single and all-failed diagnostics", async () => {
    const reportedBlocks = {
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules: ["bash.privilege_escalation"],
      rulesOmitted: false,
    };
    const tool = captureTool({
      runAgent: async (request) => result(request, {
        status: "failed",
        output: request.task === "huge" ? `partial-${"x".repeat(20_000)}` : `partial:${request.task}`,
        error: `${request.task} failed`,
        progress: { ...progress("failed"), reportedBlocks },
      }),
    });

    await expect(invoke(tool, [{ agent: "worker", task: "single" }])).rejects.toThrow(
      /Subagent worker failed: single failed[\s\S]*Partial output:\npartial:single[\s\S]*Reported blocks: 1 policy denial\./,
    );

    try {
      await invoke(tool, [
        { agent: "worker", task: "huge" },
        { agent: "reviewer", task: "second" },
      ]);
      throw new Error("expected all-failed diagnostic");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("All 2 subagents failed");
      expect(message).toContain("Partial output:");
      expect(message).toContain("Reported blocks:");
      expect(message).toContain("bash.privilege_escalation");
      expect(message).not.toContain("sudo true");
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(8192);
      expect(message).toMatch(/Reported blocks:[\s\S]*Blocked attempts did not complete/);
    }
  });

  it("budgets parallel content and stored output below Pi limits", async () => {
    const largeOutput = Array.from({ length: 2500 }, (_, index) => `line-${index}-${"x".repeat(40)}`).join("\n");
    const tool = captureTool({
      runAgent: async (request) => request.task === "two" || request.task === "four"
        ? result(request, {
            status: "failed",
            output: largeOutput,
            error: `failure-${"x".repeat(4000)}`,
            progress: progress("failed"),
          })
        : result(request, { output: largeOutput }),
    });
    const execution = await invoke(tool, [
      { agent: "worker", task: "one" },
      { agent: "worker", task: "two" },
      { agent: "worker", task: "three" },
      { agent: "worker", task: "four" },
    ]);

    expect(Buffer.byteLength(execution.content[0]?.text ?? "")).toBeLessThanOrEqual(50 * 1024);
    expect((execution.content[0]?.text ?? "").split("\n").length).toBeLessThanOrEqual(2000);
    expect(execution.content[0]?.text).toContain("Output truncated for parallel result");
    expect(execution.content[0]?.text).toContain("## worker — succeeded");
    expect((execution.content[0]?.text.match(/^## worker —/gm) ?? [])).toHaveLength(4);
    for (const run of execution.details.runs) {
      expect(Buffer.byteLength(run.output)).toBeLessThan(13 * 1024);
      expect(run.output.split("\n").length).toBeLessThan(500);
    }
  });
});

describe("global concurrency and cancellation", () => {
  it("starts queued work FIFO and releases permits after runner failures", async () => {
    const starts: string[] = [];
    const semaphore = new FifoSemaphore(1);
    const runAgent: TestDependencies["runAgent"] = async (request) => {
      starts.push(request.task);
      if (request.task === "first") throw new Error("runner failed");
      return result(request);
    };
    const tool = captureTool({ semaphore, runAgent });

    const execution = await invoke(tool, [
      { agent: "worker", task: "first" },
      { agent: "worker", task: "second" },
    ]);
    expect(starts).toEqual(["first", "second"]);
    expect(execution.content[0]?.text).toMatch(/^Parallel: 1\/2 succeeded/);
  });

  it("never exceeds four runners across simultaneous tool calls", async () => {
    let active = 0;
    let maximum = 0;
    const runAgent: TestDependencies["runAgent"] = async (request) => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(15);
      active--;
      return result(request);
    };
    const tool = captureTool({ semaphore: new FifoSemaphore(4), runAgent });
    const tasks = ["one", "two", "three", "four"].map((task) => ({ agent: "worker", task }));

    await Promise.all([invoke(tool, tasks), invoke(tool, tasks)]);
    expect(maximum).toBe(4);
  });

  it("cancels queued and running work, then throws only after settlement", async () => {
    const controller = new AbortController();
    let runningSettled = false;
    const runAgent = vi.fn<TestDependencies["runAgent"]>(async (request, options) =>
      new Promise<RunResult>((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            runningSettled = true;
            resolve(result(request, {
              status: "cancelled",
              output: "",
              error: "Subagent cancelled",
              progress: progress("cancelled"),
            }));
          },
          { once: true },
        );
      }),
    );
    const tool = captureTool({ semaphore: new FifoSemaphore(1), runAgent });
    const execution = invoke(
      tool,
      [
        { agent: "worker", task: "running" },
        { agent: "worker", task: "queued" },
      ],
      { signal: controller.signal },
    );

    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledOnce());
    controller.abort();
    await expect(execution).rejects.toThrow("Subagent execution cancelled");
    expect(runningSettled).toBe(true);
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it("removes aborted semaphore waiters without consuming a permit", async () => {
    const semaphore = new FifoSemaphore(1);
    const release = await semaphore.acquire();
    const controller = new AbortController();
    const queued = semaphore.acquire(controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });

    release();
    const nextRelease = await semaphore.acquire();
    nextRelease();
  });
});
