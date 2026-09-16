import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  getMarkdownTheme,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentDetails, SubagentParams } from "./index.ts";
import {
  formatReportedBlocksCounts,
  formatReportedBlocksSummary,
  type PermissionGateBlockDisposition,
} from "./permission-gate-block.ts";
import type { RunProgress, RunResult, RunStatus } from "./runner.ts";

const STATUS_DISPLAY: Record<RunStatus, { icon: string; color: "muted" | "warning" | "success" | "error" }> = {
  queued: { icon: "○", color: "muted" },
  running: { icon: "◌", color: "warning" },
  succeeded: { icon: "✓", color: "success" },
  failed: { icon: "✗", color: "error" },
  cancelled: { icon: "⊘", color: "warning" },
};

function preview(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : normalized;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 1000) return `${Math.round(ms)}ms`;

  const tenths = Math.round(ms / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function compactStats(run: RunResult): string {
  const progress = run.progress;
  const parts = [
    `${progress.turns} turn${progress.turns === 1 ? "" : "s"}`,
    `${progress.toolCalls} tool${progress.toolCalls === 1 ? "" : "s"}`,
    `${formatTokens(run.usage.totalTokens)} tok`,
    `$${run.usage.cost.total.toFixed(4)}`,
  ];
  if (run.model) parts.push(run.model);
  return parts.join(" · ");
}

function formatTiming(progress: RunProgress): string {
  const elapsed = formatDuration(progress.durationMs);
  if (progress.lastActivityAgoMs === undefined) {
    return `${elapsed} · No activity observed`;
  }
  return `${elapsed} · last activity ${formatDuration(progress.lastActivityAgoMs)} ago`;
}

function usageBreakdown(run: RunResult): string {
  const usage = run.usage;
  const parts = [
    `input ${formatTokens(usage.input)}`,
    `output ${formatTokens(usage.output)}`,
    `cache read ${formatTokens(usage.cacheRead)}`,
    `cache write ${formatTokens(usage.cacheWrite)}`,
  ];
  if (usage.cacheWrite1h !== undefined) parts.push(`cache write 1h ${formatTokens(usage.cacheWrite1h)}`);
  if (usage.reasoning !== undefined) parts.push(`reasoning ${formatTokens(usage.reasoning)}`);
  parts.push(`total ${formatTokens(usage.totalTokens)}`, `$${usage.cost.total.toFixed(4)}`);
  if (run.model) parts.push(run.model);
  return parts.join(" · ");
}

function statusText(status: RunStatus, theme: Theme): string {
  const display = STATUS_DISPLAY[status];
  return theme.fg(display.color, `${display.icon} ${status}`);
}

function blockLabel(disposition: PermissionGateBlockDisposition): string {
  return disposition === "denied_by_policy" ? "blocked by policy" : "confirmation unavailable";
}

function renderActivity(progress: RunProgress, theme: Theme, expanded = false): string[] {
  const lines: string[] = [];
  if (progress.generating && progress.status === "running") {
    lines.push(theme.fg("muted", "  generating"));
  }
  for (const tool of progress.activeTools) {
    lines.push(`  ${theme.fg("warning", "→")} ${theme.fg("accent", tool.name)} ${theme.fg("dim", tool.preview)}`);
  }
  if (progress.activeToolOverflow > 0) {
    lines.push(theme.fg("muted", `  … ${progress.activeToolOverflow} additional active tool calls`));
  }
  for (const tool of progress.recentTools.slice(-5)) {
    if (tool.block) {
      const icon = theme.fg("warning", "⊘");
      const label = theme.fg("warning", blockLabel(tool.block.disposition));
      lines.push(`  ${icon} ${theme.fg("muted", tool.name)} ${label} ${theme.fg("dim", tool.preview)}`);
      if (expanded && tool.errorPreview) {
        lines.push(theme.fg("dim", `    ${preview(tool.errorPreview, 240)}`));
      }
    } else {
      const icon = tool.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      lines.push(`  ${icon} ${theme.fg("muted", tool.name)} ${theme.fg("dim", tool.preview)}`);
      if (expanded && tool.isError && tool.errorPreview) {
        lines.push(theme.fg("error", `    ${preview(tool.errorPreview, 240)}`));
      }
    }
  }
  if (progress.reportedBlocks) {
    const counts = formatReportedBlocksCounts(progress.reportedBlocks);
    lines.push(theme.fg("warning", `  ${expanded ? formatReportedBlocksSummary(progress.reportedBlocks) ?? counts : counts}`));
  }
  if (progress.lastTextPreview) {
    lines.push(theme.fg("toolOutput", `  ${preview(progress.lastTextPreview, 240)}`));
  }
  return lines;
}

function fallbackText(result: AgentToolResult<SubagentDetails>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function validRuns(details: unknown): RunResult[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const candidate = details as Partial<SubagentDetails>;
  if (candidate.kind !== "subagents" || candidate.version !== 1 || !Array.isArray(candidate.runs)) return undefined;
  return candidate.runs;
}

export function renderSubagentCall(args: SubagentParams, theme: Theme): Component {
  const tasks = Array.isArray(args.tasks) ? args.tasks : [];
  if (tasks.length === 1) {
    const task = tasks[0];
    return new Text(
      theme.fg("toolTitle", theme.bold("subagent "))
        + theme.fg("accent", task?.agent || "…")
        + theme.fg("muted", `  ${preview(task?.task || "…", 80)}`),
      0,
      0,
    );
  }

  const roles = tasks.map((task) => task.agent).join(", ") || "…";
  return new Text(
    theme.fg("toolTitle", theme.bold("subagent "))
      + theme.fg("accent", `parallel ×${tasks.length}`)
      + theme.fg("muted", `  ${roles}`),
    0,
    0,
  );
}

export function renderSubagentResult(
  result: AgentToolResult<SubagentDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { args: SubagentParams },
): Component {
  const runs = validRuns(result.details);
  if (!runs || runs.length === 0) {
    return new Text(fallbackText(result), 0, 0);
  }

  if (!options.expanded) {
    const lines: string[] = [];
    for (const run of runs) {
      const display = STATUS_DISPLAY[run.status] ?? STATUS_DISPLAY.failed;
      lines.push(
        `${theme.fg(display.color, display.icon)} ${theme.fg("accent", run.agent)} ${theme.fg("muted", `— ${run.taskPreview}`)} ${theme.fg("dim", `· ${formatTiming(run.progress)}`)}`,
      );
      lines.push(...renderActivity(run.progress, theme, false));
      lines.push(theme.fg("dim", `  ${compactStats(run)}`));
      if (run.error) lines.push(theme.fg("error", `  ${preview(run.error, 240)}`));
    }
    return new Text(lines.join("\n"), 0, 0);
  }

  const container = new Container();
  const tasks = Array.isArray(context.args?.tasks) ? context.args.tasks : [];
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    if (index > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "───"), 0, 0));
      container.addChild(new Spacer(1));
    }

    container.addChild(
      new Text(
        `${statusText(run.status, theme)}  ${theme.fg("toolTitle", theme.bold(run.agent))}`,
        0,
        0,
      ),
    );
    container.addChild(new Text(theme.fg("dim", formatTiming(run.progress)), 0, 0));
    container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
    container.addChild(new Text(tasks[index]?.task ?? run.taskPreview, 0, 0));

    const activityLines = renderActivity(run.progress, theme, true);
    if (activityLines.length > 0) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(activityLines.join("\n"), 0, 0));
    }
    if (run.output) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "Output"), 0, 0));
      container.addChild(new Markdown(run.output, 0, 0, getMarkdownTheme()));
    }
    if (run.error) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("error", `Error: ${run.error}`), 0, 0));
    }

    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usageBreakdown(run)), 0, 0));
  }
  return container;
}
