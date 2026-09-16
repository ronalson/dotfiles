import { describe, expect, it } from "vitest";
import {
  MAX_PERMISSION_GATE_RULE_BYTES,
  MAX_PERMISSION_GATE_TRAILER_BYTES,
  MAX_REPORTED_BLOCK_RULES,
  MAX_REPORTED_BLOCK_SUMMARY_BYTES,
  PERMISSION_GATE_BLOCK_MARKER,
  REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED,
  REPORTED_BLOCKS_UNRESOLVED_WORK,
  boundErrorPreview,
  joinToolResultText,
  parsePermissionGateBlockFromEndEvent,
  parsePermissionGateBlockText,
  ReportedBlockAggregator,
  formatReportedBlocksSummary,
  mergeReportedBlocks,
} from "../permission-gate-block.ts";

function trailer(
  disposition: "denied_by_policy" | "confirmation_unavailable",
  rules: string[],
  extras?: Record<string, unknown>,
): string {
  return `${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({ disposition, rules, ...extras })}`;
}

function reasonWithTrailer(
  disposition: "denied_by_policy" | "confirmation_unavailable" = "denied_by_policy",
  rules: string[] = ["bash.privilege_escalation"],
  reason = "Blocked by permission-gate: privilege escalation.",
): string {
  return `${reason}\n${trailer(disposition, rules)}`;
}

function endEvent(options: {
  text?: string;
  parts?: Array<Record<string, unknown>>;
  isError?: boolean;
  result?: unknown;
}): Record<string, unknown> {
  const result = Object.hasOwn(options, "result")
    ? options.result
    : {
        content: options.parts ?? [{ type: "text", text: options.text ?? reasonWithTrailer() }],
      };
  return {
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "bash",
    isError: options.isError ?? true,
    result,
  };
}

describe("parsePermissionGateBlockText", () => {
  it("parses a valid denied_by_policy trailer and strips it from display text", () => {
    const parsed = parsePermissionGateBlockText(reasonWithTrailer("denied_by_policy", ["bash.privilege_escalation"]));
    expect(parsed).toEqual({
      metadata: { disposition: "denied_by_policy", rules: ["bash.privilege_escalation"] },
      displayText: "Blocked by permission-gate: privilege escalation.",
    });
    expect(parsed?.displayText).not.toContain(PERMISSION_GATE_BLOCK_MARKER);
  });

  it("parses a valid confirmation_unavailable trailer with a trailing CRLF", () => {
    const parsed = parsePermissionGateBlockText(
      `${reasonWithTrailer("confirmation_unavailable", ["bash.destructive_command"])}\r\n`,
    );
    expect(parsed?.metadata).toEqual({
      disposition: "confirmation_unavailable",
      rules: ["bash.destructive_command"],
    });
  });

  it("treats ordinary errors, malformed JSON, extra fields, and unsupported values as missing metadata", () => {
    expect(parsePermissionGateBlockText("command failed: not found")).toBeUndefined();
    expect(parsePermissionGateBlockText(`Blocked.\n${PERMISSION_GATE_BLOCK_MARKER}{not json}`)).toBeUndefined();
    expect(parsePermissionGateBlockText(`Blocked.\n${trailer("denied_by_policy", ["bash.x"], { extra: true })}`)).toBeUndefined();
    expect(parsePermissionGateBlockText(`Blocked.\n${trailer("denied_by_policy", ["bash.x"], { rulesTruncated: true })}`)).toBeUndefined();
    expect(
      parsePermissionGateBlockText(
        `Blocked.\n[pi-permission-gate:block:v2] ${JSON.stringify({ disposition: "denied_by_policy", rules: ["bash.x"] })}`,
      ),
    ).toBeUndefined();
    expect(
      parsePermissionGateBlockText(
        `Blocked.\n${PERMISSION_GATE_BLOCK_MARKER}${JSON.stringify({ disposition: "allowed", rules: ["bash.x"] })}`,
      ),
    ).toBeUndefined();
  });

  it("rejects oversized trailers before JSON.parse", () => {
    const padded = `${PERMISSION_GATE_BLOCK_MARKER}${" ".repeat(MAX_PERMISSION_GATE_TRAILER_BYTES)}${JSON.stringify({
      disposition: "denied_by_policy",
      rules: ["bash.privilege_escalation"],
    })}`;
    expect(Buffer.byteLength(padded, "utf8")).toBeGreaterThan(MAX_PERMISSION_GATE_TRAILER_BYTES);
    expect(parsePermissionGateBlockText(`Blocked.\n${padded}`)).toBeUndefined();
  });

  it("rejects trailing content after the terminal trailer line", () => {
    const valid = reasonWithTrailer();
    expect(parsePermissionGateBlockText(`${valid}\n`)).toEqual(parsePermissionGateBlockText(valid));
    expect(parsePermissionGateBlockText(`${valid}\n\n`)).toBeUndefined();
    expect(parsePermissionGateBlockText(`${valid} extra`)).toBeUndefined();
    expect(parsePermissionGateBlockText(`${valid}\nleftover`)).toBeUndefined();
  });

  it("rejects duplicate, invalid, or overlong rule codes", () => {
    expect(parsePermissionGateBlockText(reasonWithTrailer("denied_by_policy", ["bash.x", "bash.x"]))).toBeUndefined();
    expect(parsePermissionGateBlockText(reasonWithTrailer("denied_by_policy", ["bash"]))).toBeUndefined();
    expect(parsePermissionGateBlockText(reasonWithTrailer("denied_by_policy", ["Bash.x"]))).toBeUndefined();
    expect(parsePermissionGateBlockText(reasonWithTrailer("denied_by_policy", [`bash.${"x".repeat(64)}`]))).toBeUndefined();
  });
});

describe("parsePermissionGateBlockFromEndEvent", () => {
  it("joins only top-level text parts", () => {
    const parsed = parsePermissionGateBlockFromEndEvent(
      endEvent({
        parts: [
          { type: "text", text: "Blocked by permission-gate: denied.\n" },
          { type: "image", data: "abc" },
          { type: "text", text: trailer("denied_by_policy", ["read.ssh_private_key"]) },
          { type: "text", nested: { text: trailer("confirmation_unavailable", ["bash.x"]) } },
        ],
      }),
    );
    expect(parsed?.metadata).toEqual({
      disposition: "denied_by_policy",
      rules: ["read.ssh_private_key"],
    });
    expect(parsed?.displayText).toBe("Blocked by permission-gate: denied.");
  });

  it("does not search nested result fields", () => {
    expect(
      parsePermissionGateBlockFromEndEvent(
        endEvent({
          result: {
            content: [{ type: "text", text: "ordinary error" }],
            details: { content: [{ type: "text", text: reasonWithTrailer() }] },
            text: reasonWithTrailer(),
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("ignores a valid-looking trailer on successful events", () => {
    expect(parsePermissionGateBlockFromEndEvent(endEvent({ isError: false }))).toBeUndefined();
  });

  it("does not treat missing or non-boolean isError as a valid gate block", () => {
    const result = { content: [{ type: "text", text: reasonWithTrailer() }] };
    expect(
      parsePermissionGateBlockFromEndEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result,
      }),
    ).toBeUndefined();
    expect(parsePermissionGateBlockFromEndEvent({ ...endEvent({}), isError: "true" })).toBeUndefined();
    expect(parsePermissionGateBlockFromEndEvent({ ...endEvent({}), isError: 1 })).toBeUndefined();
    expect(parsePermissionGateBlockFromEndEvent({ ...endEvent({}), isError: null })).toBeUndefined();
  });

  it("does not throw on missing or malformed results", () => {
    expect(parsePermissionGateBlockFromEndEvent(endEvent({ result: null }))).toBeUndefined();
    expect(parsePermissionGateBlockFromEndEvent(endEvent({ result: "Blocked" }))).toBeUndefined();
    expect(parsePermissionGateBlockFromEndEvent(endEvent({ result: { content: "Blocked" } }))).toBeUndefined();
    expect(joinToolResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
  });
});

function maxLengthRule(index: number): string {
  const prefix = `r${index}.`;
  return `${prefix}${"x".repeat(MAX_PERMISSION_GATE_RULE_BYTES - prefix.length)}`;
}

describe("ReportedBlockAggregator", () => {
  it("counts reported blocked attempts and caps the unique rule union without overcounting omitted rules", () => {
    const aggregator = new ReportedBlockAggregator();
    aggregator.record({ disposition: "denied_by_policy", rules: ["bash.a", "bash.b"] });
    aggregator.record({ disposition: "denied_by_policy", rules: ["bash.a"] });
    aggregator.record({
      disposition: "confirmation_unavailable",
      rules: ["bash.c", "bash.d", "bash.e", "bash.f", "bash.g", "bash.h", "bash.i", "bash.j"],
    });
    aggregator.record({ disposition: "denied_by_policy", rules: ["bash.i", "bash.j", "bash.k"] });

    expect(aggregator.snapshot()).toEqual({
      deniedByPolicy: 3,
      confirmationUnavailable: 1,
      rules: ["bash.a", "bash.b", "bash.c", "bash.d", "bash.e", "bash.f", "bash.g", "bash.h"],
      rulesOmitted: true,
    });
  });

  it("formats a bounded summary without raw reasons", () => {
    const summary = formatReportedBlocksSummary({
      deniedByPolicy: 2,
      confirmationUnavailable: 1,
      rules: ["bash.privilege_escalation", "read.ssh_private_key"],
      rulesOmitted: true,
    });
    expect(summary).toContain("Reported blocks: 2 policy denials, 1 confirmation unavailable.");
    expect(summary).toContain("Sampled rules: bash.privilege_escalation, read.ssh_private_key.");
    expect(summary).toContain(REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED);
    expect(summary).toContain(REPORTED_BLOCKS_UNRESOLVED_WORK);
    expect(summary?.endsWith(REPORTED_BLOCKS_UNRESOLVED_WORK)).toBe(true);
    expect(summary).not.toContain("rm ");
    expect(summary).not.toContain("/");
    expect(summary).not.toContain("+1 more");
    expect(mergeReportedBlocks([undefined])).toBeUndefined();
    expect(boundErrorPreview("Blocked\u0007 by gate\u202e")).toBe("Blocked? by gate?");

    const compact = formatReportedBlocksSummary({
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules: ["bash.privilege_escalation"],
      rulesOmitted: false,
    });
    expect(compact).toContain("Sampled rules: bash.privilege_escalation.");
    expect(compact).not.toContain(REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED);
    expect(compact?.endsWith(REPORTED_BLOCKS_UNRESOLVED_WORK)).toBe(true);
  });

  it("replaces C1 controls in error previews", () => {
    expect(boundErrorPreview("Blocked\u0080 by gate\u009f")).toBe("Blocked? by gate?");
    expect(boundErrorPreview("\u0085hidden\u009b")).toBe("?hidden?");
  });

  it("preserves the unresolved-work sentence under the byte bound with max-length sampled rules", () => {
    const rules = Array.from({ length: MAX_REPORTED_BLOCK_RULES }, (_, index) => maxLengthRule(index));
    for (const rule of rules) {
      expect(Buffer.byteLength(rule, "utf8")).toBe(MAX_PERMISSION_GATE_RULE_BYTES);
    }

    const summary = formatReportedBlocksSummary({
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules,
      rulesOmitted: true,
    });
    expect(summary).toBeDefined();
    expect(summary?.endsWith(REPORTED_BLOCKS_UNRESOLVED_WORK)).toBe(true);
    expect(Buffer.byteLength(summary ?? "", "utf8")).toBeLessThanOrEqual(MAX_REPORTED_BLOCK_SUMMARY_BYTES);
    expect(summary).toContain(REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED);
    expect(summary).not.toContain("\u2026");
    expect(summary).not.toContain("+");
    const included = rules.filter((rule) => summary?.includes(rule));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(rules.length);
    for (const rule of rules) {
      if (summary?.includes(rule.slice(0, 8))) expect(summary).toContain(rule);
    }
  });

  it("omits only whole sampled rule codes when the summary budget is tight", () => {
    const rules = Array.from({ length: MAX_REPORTED_BLOCK_RULES }, (_, index) => maxLengthRule(index));
    const summary = formatReportedBlocksSummary({
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules,
      rulesOmitted: false,
    });
    expect(summary?.endsWith(REPORTED_BLOCKS_UNRESOLVED_WORK)).toBe(true);
    expect(Buffer.byteLength(summary ?? "", "utf8")).toBeLessThanOrEqual(MAX_REPORTED_BLOCK_SUMMARY_BYTES);
    expect(summary).toContain(REPORTED_BLOCKS_ADDITIONAL_RULES_OMITTED);
    const included = rules.filter((rule) => summary?.includes(rule));
    expect(included.length).toBeGreaterThan(0);
    expect(included.length).toBeLessThan(rules.length);
  });

  it("keeps inherited omitted rules as a boolean across merges", () => {
    const first = {
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules: ["bash.a"],
      rulesOmitted: true,
    };
    const second = {
      deniedByPolicy: 1,
      confirmationUnavailable: 0,
      rules: ["bash.a", "bash.b"],
      rulesOmitted: false,
    };
    expect(mergeReportedBlocks([first, second])).toEqual({
      deniedByPolicy: 2,
      confirmationUnavailable: 0,
      rules: ["bash.a", "bash.b"],
      rulesOmitted: true,
    });
  });
});
