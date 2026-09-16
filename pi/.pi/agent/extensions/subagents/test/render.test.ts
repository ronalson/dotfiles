import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { SubagentDetails, SubagentParams } from "../index.ts";
import { renderSubagentCall, renderSubagentResult } from "../render.ts";
import type { RunResult, RunStatus } from "../runner.ts";
import { emptyUsage } from "../runner.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

beforeAll(() => {
  initTheme("dark", false);
});

function run(status: RunStatus, overrides: Partial<RunResult> = {}): RunResult {
  const usage = emptyUsage();
  usage.input = 1000;
  usage.output = 250;
  usage.cacheRead = 500;
  usage.cacheWrite = 100;
  usage.cacheWrite1h = 50;
  usage.reasoning = 75;
  usage.totalTokens = 1850;
  usage.cost.total = 0.0123;

  return {
    agent: "scout",
    taskPreview: "Map the authentication flow",
    status,
    output: "## Findings\n\nAuthentication starts in `src/auth.ts`.",
    usage,
    progress: {
      status,
      activeTools: [],
      activeToolOverflow: 0,
      recentTools: [],
      lastTextPreview: "Authentication starts in src/auth.ts",
      toolCalls: 2,
      turns: 1,
      durationMs: 1250,
      generating: false,
    },
    model: "openai/gpt-test",
    ...overrides,
  };
}

function toolResult(runs: RunResult[]): AgentToolResult<SubagentDetails> {
  return {
    content: [{ type: "text", text: "model-visible fallback" }],
    details: { kind: "subagents", version: 1, runs },
  };
}

function renderResult(
  runs: RunResult[],
  expanded = false,
  tasks: SubagentParams["tasks"] = runs.map((item) => ({ agent: item.agent, task: item.taskPreview })),
): string[] {
  return renderSubagentResult(
    toolResult(runs),
    { expanded, isPartial: !runs.every((item) => item.status === "succeeded") },
    plainTheme,
    { args: { tasks } },
  ).render(120);
}

describe("renderSubagentCall", () => {
  it("renders concise single and parallel headers", () => {
    const single = renderSubagentCall(
      { tasks: [{ agent: "scout", task: "Map the authentication flow and cite relevant files." }] },
      plainTheme,
    ).render(120).map((line) => line.trimEnd()).join("\n");
    expect(single).toBe("subagent scout  Map the authentication flow and cite relevant files.");

    const parallel = renderSubagentCall(
      {
        tasks: [
          { agent: "scout", task: "Map persistence" },
          { agent: "reviewer", task: "Review errors" },
          { agent: "scout", task: "Find tests" },
        ],
      },
      plainTheme,
    ).render(120).map((line) => line.trimEnd()).join("\n");
    expect(parallel).toBe("subagent parallel ×3  scout, reviewer, scout");
  });

  it("wraps long calls within narrow terminal widths", () => {
    const component = renderSubagentCall(
      { tasks: [{ agent: "worker", task: "Implement a deliberately long delegated task with verification details" }] },
      plainTheme,
    );
    expect(component.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});

describe("renderSubagentResult", () => {
  it.each([
    ["queued", "○"],
    ["running", "◌"],
    ["succeeded", "✓"],
    ["failed", "✗"],
    ["cancelled", "⊘"],
  ] as const)("renders %s distinctly", (status, icon) => {
    const text = renderResult([run(status)]).join("\n");
    expect(text).toContain(`${icon} scout`);
  });

  it("shows every active tool, bounded recent activity, previews, and compact statistics", () => {
    const activeTools = Array.from({ length: 4 }, (_, index) => ({
      id: `active-${index}`,
      name: index % 2 === 0 ? "read" : "grep",
      preview: `active preview ${index}`,
    }));
    const recentTools = Array.from({ length: 7 }, (_, index) => ({
      name: "read",
      preview: `recent preview ${index}`,
      isError: false,
    }));
    const text = renderResult([
      run("running", {
        progress: {
          ...run("running").progress,
          activeTools,
          activeToolOverflow: 3,
          recentTools,
        },
      }),
    ]).join("\n");

    for (const tool of activeTools) expect(text).toContain(tool.preview);
    expect(text).toContain("3 additional active tool calls");
    expect(text).not.toContain("recent preview 0");
    expect(text).not.toContain("recent preview 1");
    expect(text).toContain("recent preview 2");
    expect(text).toContain("Authentication starts in src/auth.ts");
    expect(text).toContain("1.3s · No activity observed");
    expect(text).toContain("1 turn · 2 tools · 1.9k tok · $0.0123 · openai/gpt-test");
    expect(text).not.toContain("1.9k tok · 1.3s");
  });

  it("uses full tasks from renderer context and renders output, errors, and usage when expanded", () => {
    const fullTask = "Review the complete authentication flow, including middleware and integration tests.";
    const text = renderResult(
      [run("failed", { error: "Missing authorization check" })],
      true,
      [{ agent: "scout", task: fullTask }],
    ).join("\n");

    expect(text).toContain(fullTask);
    expect(text).not.toContain("Task\nMap the authentication flow\n");
    expect(text).toContain("Findings");
    expect(text).toContain("Authentication starts in");
    expect(text).toContain("Error: Missing authorization check");
    expect(text).toContain("input 1.0k");
    expect(text).toContain("cache write 1h 50");
    expect(text).toContain("reasoning 75");
    expect(text).toContain("$0.0123");
  });

  it("keeps collapsed and expanded output within narrow widths", () => {
    const item = run("failed", {
      error: "A long failure diagnostic that must wrap cleanly without overflowing the terminal",
    });
    const tasks = [{ agent: "scout", task: "A full delegated task with enough text to wrap on narrow terminals" }];
    for (const expanded of [false, true]) {
      const component = renderSubagentResult(
        toolResult([item]),
        { expanded, isPartial: false },
        plainTheme,
        { args: { tasks } },
      );
      expect(component.render(28).every((line) => visibleWidth(line) <= 28)).toBe(true);
    }
  });

  it("does not format durations as 60.0s or Xm 60s", () => {
    const almostMinute = run("running", {
      progress: {
        ...run("running").progress,
        durationMs: 59_950,
        lastActivityAgoMs: 59_950,
        generating: false,
      },
    });
    for (const text of [renderResult([almostMinute]).join("\n"), renderResult([almostMinute], true).join("\n")]) {
      expect(text).not.toContain("60.0s");
      expect(text).toContain("1m 0s");
    }

    const minuteRollover = run("running", {
      progress: {
        ...run("running").progress,
        durationMs: 119_500,
        lastActivityAgoMs: 119_500,
        generating: false,
      },
    });
    for (const text of [renderResult([minuteRollover]).join("\n"), renderResult([minuteRollover], true).join("\n")]) {
      expect(text).not.toMatch(/\b60s\b/);
      expect(text).toContain("2m 0s");
    }
  });

  it("shows elapsed time and quiet duration in both views", () => {
    const silent = run("running", {
      progress: {
        ...run("running").progress,
        lastTextPreview: undefined,
        durationMs: 134_000,
        generating: false,
      },
    });
    const collapsedSilent = renderResult([silent]).join("\n");
    const expandedSilent = renderResult([silent], true).join("\n");
    for (const text of [collapsedSilent, expandedSilent]) {
      expect(text).toContain("2m 14s");
      expect(text).toContain("No activity observed");
    }
    expect(collapsedSilent).toContain("1 turn · 2 tools · 1.9k tok · $0.0123");
    expect(collapsedSilent).not.toContain("tok · 2m 14s");

    const active = run("running", {
      progress: {
        ...run("running").progress,
        durationMs: 134_000,
        lastActivityAgoMs: 37_000,
        generating: true,
      },
    });
    const collapsedActive = renderResult([active]).join("\n");
    const expandedActive = renderResult([active], true).join("\n");
    for (const text of [collapsedActive, expandedActive]) {
      expect(text).toContain("2m 14s");
      expect(text).toContain("last activity 37.0s ago");
      expect(text).toContain("generating");
      expect(text).not.toContain("thinking");
    }
  });

  it("renders failed tool completions as errors rather than success", () => {
    const text = renderResult([
      run("running", {
        progress: {
          ...run("running").progress,
          recentTools: [
            { name: "bash", preview: '{"command":"rm secret"}', isError: true },
            { name: "read", preview: '{"path":"src/auth.ts"}', isError: false },
          ],
        },
      }),
    ]).join("\n");

    expect(text).toContain("✗ bash");
    expect(text).toContain("✓ read");
    expect(text).not.toContain("✓ bash");
  });

  it("renders reported blocks distinctly from ordinary tool errors in both views", () => {
    const item = run("running", {
      progress: {
        ...run("running").progress,
        recentTools: [
          {
            name: "bash",
            preview: '{"command":"sudo true"}',
            isError: true,
            block: { disposition: "denied_by_policy", rules: ["bash.privilege_escalation"] },
            errorPreview: "Blocked by permission-gate: privilege escalation.",
          },
          {
            name: "bash",
            preview: '{"command":"rm cache"}',
            isError: true,
            block: { disposition: "confirmation_unavailable", rules: ["bash.destructive_command"] },
            errorPreview: "Blocked by permission-gate: confirmation required.",
          },
          { name: "grep", preview: '{"pattern":"TODO"}', isError: true, errorPreview: "ripgrep failed" },
        ],
        reportedBlocks: {
          deniedByPolicy: 1,
          confirmationUnavailable: 1,
          rules: ["bash.privilege_escalation", "bash.destructive_command"],
          rulesOmitted: false,
        },
      },
    });

    const collapsed = renderResult([item]).join("\n");
    const expanded = renderResult([item], true).join("\n");
    for (const text of [collapsed, expanded]) {
      expect(text).toContain("⊘ bash");
      expect(text).toContain("blocked by policy");
      expect(text).toContain("confirmation unavailable");
      expect(text).toContain("✗ grep");
      expect(text).toContain("Reported blocks: 1 policy denial, 1 confirmation unavailable");
      expect(text).not.toContain("✗ bash");
      expect(text).not.toContain("✓ bash");
    }
    expect(expanded).toContain("Blocked by permission-gate: privilege escalation.");
    expect(expanded).toContain("ripgrep failed");
    expect(collapsed).not.toContain("ripgrep failed");
  });

  it("keeps timing, generating, and error activity within narrow widths", () => {
    const item = run("running", {
      error: "A long failure diagnostic that must wrap cleanly without overflowing the terminal",
      progress: {
        ...run("running").progress,
        durationMs: 134_000,
        lastActivityAgoMs: 37_000,
        generating: true,
        recentTools: [{ name: "bash", preview: '{"command":"a deliberately long command that should wrap"}', isError: true }],
      },
    });
    const tasks = [{ agent: "scout", task: "A full delegated task with enough text to wrap on narrow terminals" }];
    for (const expanded of [false, true]) {
      const component = renderSubagentResult(
        toolResult([item]),
        { expanded, isPartial: true },
        plainTheme,
        { args: { tasks } },
      );
      expect(component.render(28).every((line) => visibleWidth(line) <= 28)).toBe(true);
    }
  });

  it("falls back safely when details or optional fields are missing", () => {
    const withoutDetails = renderSubagentResult(
      {
        content: [{ type: "text", text: "fallback output" }],
        details: undefined as unknown as SubagentDetails,
      },
      { expanded: false, isPartial: false },
      plainTheme,
      { args: { tasks: [] } },
    ).render(40);
    expect(withoutDetails.map((line) => line.trimEnd()).join("\n")).toBe("fallback output");

    const minimal = run("succeeded", { model: undefined, error: undefined });
    expect(() => renderResult([minimal], false)).not.toThrow();
    expect(() => renderResult([minimal], true)).not.toThrow();
  });
});
