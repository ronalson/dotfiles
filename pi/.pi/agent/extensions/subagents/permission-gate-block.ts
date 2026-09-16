import { StringDecoder } from "node:string_decoder";

export const PERMISSION_GATE_BLOCK_MARKER = "[pi-permission-gate:block:v1] ";
export const PERMISSION_GATE_BLOCK_MARKER_PREFIX = "[pi-permission-gate:block:";
export const MAX_PERMISSION_GATE_TRAILER_BYTES = 768;
export const MAX_PERMISSION_GATE_TRAILER_RULES = 8;
export const MAX_PERMISSION_GATE_RULE_BYTES = 64;
export const MAX_REPORTED_BLOCK_RULES = 8;
export const MAX_REPORTED_BLOCK_SUMMARY_BYTES = 512;
export const MAX_BLOCK_ERROR_PREVIEW_BYTES = 240;
export const REPORTED_BLOCKS_UNRESOLVED_WORK =
  "Blocked attempts did not complete; related work remains unresolved unless completed independently.";
export const REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED = "additional rules omitted";

const BLOCK_RULE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export const PERMISSION_GATE_BLOCK_DISPOSITIONS = ["denied_by_policy", "confirmation_unavailable"] as const;
export type PermissionGateBlockDisposition = (typeof PERMISSION_GATE_BLOCK_DISPOSITIONS)[number];

export interface PermissionGateBlockMetadata {
  disposition: PermissionGateBlockDisposition;
  rules: string[];
}

export interface ParsedPermissionGateBlock {
  metadata: PermissionGateBlockMetadata;
  displayText: string;
}

export interface ReportedBlocks {
  deniedByPolicy: number;
  confirmationUnavailable: number;
  rules: string[];
  rulesOmitted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "…";
  const bytes = Buffer.from(value, "utf8");
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(suffix)))) + suffix;
}

export function sanitizeControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "?");
}

export function boundErrorPreview(value: string): string {
  return truncateUtf8(sanitizeControlChars(value).trim(), MAX_BLOCK_ERROR_PREVIEW_BYTES);
}

export function joinToolResultText(result: unknown): string | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  return result.content.filter(isTextPart).map((part) => part.text).join("");
}

function splitTerminalLine(text: string): { prefix: string; lastLine: string } | undefined {
  let body = text;
  if (body.endsWith("\r\n")) body = body.slice(0, -2);
  else if (body.endsWith("\n")) body = body.slice(0, -1);

  if (body.endsWith("\n") || body.endsWith("\r")) return undefined;

  const lastNewline = body.lastIndexOf("\n");
  let prefix = lastNewline === -1 ? "" : body.slice(0, lastNewline);
  const lastLine = lastNewline === -1 ? body : body.slice(lastNewline + 1);
  if (prefix.endsWith("\r")) prefix = prefix.slice(0, -1);
  if (lastLine.includes("\r")) return undefined;
  return { prefix, lastLine };
}

function parseTrailerPayload(jsonText: string): PermissionGateBlockMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !Object.hasOwn(parsed, "disposition") || !Object.hasOwn(parsed, "rules")) {
    return undefined;
  }

  const { disposition, rules } = parsed;
  if (disposition !== "denied_by_policy" && disposition !== "confirmation_unavailable") return undefined;
  if (!Array.isArray(rules) || rules.length > MAX_PERMISSION_GATE_TRAILER_RULES) return undefined;

  const unique = new Set<string>();
  for (const rule of rules) {
    if (typeof rule !== "string") return undefined;
    if (Buffer.byteLength(rule, "utf8") > MAX_PERMISSION_GATE_RULE_BYTES) return undefined;
    if (!BLOCK_RULE_PATTERN.test(rule)) return undefined;
    if (unique.has(rule)) return undefined;
    unique.add(rule);
  }

  return { disposition, rules: [...rules] };
}

export function parsePermissionGateBlockText(text: string): ParsedPermissionGateBlock | undefined {
  const split = splitTerminalLine(text);
  if (!split) return undefined;
  if (Buffer.byteLength(split.lastLine, "utf8") > MAX_PERMISSION_GATE_TRAILER_BYTES) return undefined;
  if (!split.lastLine.startsWith(PERMISSION_GATE_BLOCK_MARKER)) return undefined;

  const metadata = parseTrailerPayload(split.lastLine.slice(PERMISSION_GATE_BLOCK_MARKER.length));
  if (!metadata) return undefined;
  return { metadata, displayText: split.prefix };
}

export function parsePermissionGateBlockFromEndEvent(
  event: Record<string, unknown>,
): ParsedPermissionGateBlock | undefined {
  if (event.type !== "tool_execution_end" || event.isError !== true) return undefined;
  const text = joinToolResultText(event.result);
  if (text === undefined) return undefined;
  return parsePermissionGateBlockText(text);
}

export class ReportedBlockAggregator {
  private deniedByPolicy = 0;
  private confirmationUnavailable = 0;
  private readonly rules: string[] = [];
  private readonly ruleSet = new Set<string>();
  private rulesOmitted = false;

  record(metadata: PermissionGateBlockMetadata): void {
    if (metadata.disposition === "denied_by_policy") this.deniedByPolicy += 1;
    else this.confirmationUnavailable += 1;

    for (const rule of metadata.rules) {
      if (this.ruleSet.has(rule)) continue;
      if (this.rules.length < MAX_REPORTED_BLOCK_RULES) {
        this.rules.push(rule);
        this.ruleSet.add(rule);
      } else {
        this.rulesOmitted = true;
      }
    }
  }

  snapshot(): ReportedBlocks | undefined {
    if (this.deniedByPolicy === 0 && this.confirmationUnavailable === 0) return undefined;
    return {
      deniedByPolicy: this.deniedByPolicy,
      confirmationUnavailable: this.confirmationUnavailable,
      rules: [...this.rules],
      rulesOmitted: this.rulesOmitted,
    };
  }
}

export function mergeReportedBlocks(list: Array<ReportedBlocks | undefined>): ReportedBlocks | undefined {
  const aggregator = new ReportedBlockAggregator();
  let deniedByPolicy = 0;
  let confirmationUnavailable = 0;
  let rulesOmitted = false;

  for (const item of list) {
    if (!item) continue;
    deniedByPolicy += item.deniedByPolicy;
    confirmationUnavailable += item.confirmationUnavailable;
    if (item.rulesOmitted) rulesOmitted = true;
    aggregator.record({
      disposition: "denied_by_policy",
      rules: item.rules,
    });
  }

  if (deniedByPolicy === 0 && confirmationUnavailable === 0) return undefined;
  const snap = aggregator.snapshot();
  return {
    deniedByPolicy,
    confirmationUnavailable,
    rules: snap?.rules ?? [],
    rulesOmitted: rulesOmitted || (snap?.rulesOmitted ?? false),
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatReportedBlocksCounts(blocks: ReportedBlocks): string {
  const parts: string[] = [];
  if (blocks.deniedByPolicy > 0) {
    parts.push(plural(blocks.deniedByPolicy, "policy denial", "policy denials"));
  }
  if (blocks.confirmationUnavailable > 0) {
    parts.push(`${blocks.confirmationUnavailable} confirmation unavailable`);
  }
  return `Reported blocks: ${parts.join(", ")}`;
}

function formatSampledRulesSection(rules: readonly string[], rulesOmitted: boolean, budget: number): string {
  if (budget <= 0 || (rules.length === 0 && !rulesOmitted)) return "";

  const omittedClause = ` ${REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED}.`;
  const render = (kept: readonly string[], omitted: boolean): string => {
    if (kept.length === 0) return omitted ? omittedClause : "";
    const sampled = ` Sampled rules: ${kept.join(", ")}.`;
    return omitted ? `${sampled}${omittedClause}` : sampled;
  };
  const fits = (text: string): boolean => Buffer.byteLength(text, "utf8") <= budget;

  let kept = [...rules];
  if (fits(render(kept, rulesOmitted))) return render(kept, rulesOmitted);

  while (kept.length > 0) {
    kept.pop();
    const candidate = render(kept, true);
    if (fits(candidate)) return candidate;
  }

  return fits(omittedClause) ? omittedClause : "";
}

export function formatReportedBlocksSummary(blocks: ReportedBlocks | undefined): string | undefined {
  if (!blocks || blocks.deniedByPolicy + blocks.confirmationUnavailable <= 0) return undefined;

  const counts = `${formatReportedBlocksCounts(blocks)}.`;
  const unresolved = ` ${REPORTED_BLOCKS_UNRESOLVED_WORK}`;
  const budget = MAX_REPORTED_BLOCK_SUMMARY_BYTES - Buffer.byteLength(counts, "utf8") - Buffer.byteLength(unresolved, "utf8");
  const rulesSection = formatSampledRulesSection(blocks.rules, blocks.rulesOmitted, Math.max(0, budget));
  return `${counts}${rulesSection}${unresolved}`;
}
