import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverAgents,
  getBundledAgentsDir,
  getSubagentsExtensionDir,
  PERMISSION_GATE_EXPECTED_NAME,
  PERMISSION_GATE_EXPECTED_VERSION,
  PERMISSION_GATE_INSTALL_COMMAND,
  RADIUS_INSTALL_COMMAND,
  resolvePermissionGateExtension,
  resolveRadiusWebSearchExtension,
} from "../agents.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-"));
  temporaryDirectories.push(directory);
  return directory;
}

function agentFile(overrides: {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  thinking?: string;
  body?: string;
} = {}): string {
  const lines = [
    "---",
    `name: ${overrides.name ?? "example"}`,
    `description: ${overrides.description ?? "Example agent"}`,
    `tools: ${overrides.tools ?? "[read, grep]"}`,
  ];
  if (overrides.model !== undefined) lines.push(`model: ${overrides.model}`);
  if (overrides.thinking !== undefined) lines.push(`thinking: ${overrides.thinking}`);
  lines.push("---", "", overrides.body ?? "Follow the delegated task.", "");
  return lines.join("\n");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bundled agents", () => {
  it("resolves its directories from the module URL and loads roles in filename order", () => {
    const expectedExtensionDir = dirname(fileURLToPath(new URL("../agents.ts", import.meta.url)));
    expect(getSubagentsExtensionDir()).toBe(expectedExtensionDir);
    expect(getBundledAgentsDir()).toBe(join(expectedExtensionDir, "agents"));

    const discovery = discoverAgents();
    expect(discovery.diagnostics).toEqual([]);
    expect(discovery.agents.map((agent) => agent.name)).toEqual(["advisor", "reviewer", "scout", "worker"]);
    expect(discovery.agents.map((agent) => agent.tools)).toEqual([
      ["read"],
      ["read", "grep", "find", "ls", "radius_web_search"],
      ["read", "grep", "find", "ls", "radius_web_search"],
      ["read", "grep", "find", "ls", "bash", "edit", "write"],
    ]);
    expect(discovery.agents.map((agent) => agent.model)).toEqual([
      "openai-codex/gpt-6-astra",
      "openai-codex/gpt-5.6-sol",
      "openrouter/z-ai/glm-5.3-flash",
      "xai/grok-4.6",
    ]);
    expect(discovery.agents.map((agent) => agent.thinking)).toEqual(["high", undefined, undefined, "high"]);
    for (const agent of discovery.agents) {
      expect(agent.systemPrompt).toMatch(/do not retry or evade/i);
      expect(agent.systemPrompt).toMatch(/Continue independent work/);
      expect(agent.systemPrompt).toMatch(/Report unresolved blocked work once/);
      expect(agent.systemPrompt).toMatch(/without reproducing machine metadata/);
      expect(agent.systemPrompt).toMatch(/Do not ask the parent to replay or approve/);
    }
  });
});

describe("discoverAgents", () => {
  it("supports regular files and symlinks and diagnoses dangling symlinks", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source.txt");
    writeFileSync(source, agentFile({ name: "linked" }));
    symlinkSync(source, join(directory, "a-linked.md"));
    symlinkSync(join(directory, "missing.md"), join(directory, "b-dangling.md"));
    writeFileSync(join(directory, "c-regular.md"), agentFile({ name: "regular" }));

    const discovery = discoverAgents(directory);
    expect(discovery.agents.map((agent) => agent.name)).toEqual(["linked", "regular"]);
    expect(discovery.diagnostics).toHaveLength(1);
    expect(discovery.diagnostics[0]?.filePath).toBe(join(directory, "b-dangling.md"));
  });

  it("normalizes string and array tool lists while preserving order", async () => {
    const directory = await temporaryDirectory();
    writeFileSync(join(directory, "a.md"), agentFile({ name: "alpha", tools: "read, grep, read, ls" }));
    writeFileSync(join(directory, "b.md"), agentFile({ name: "beta", tools: "[find, read, find]" }));

    expect(discoverAgents(directory).agents.map((agent) => agent.tools)).toEqual([
      ["read", "grep", "ls"],
      ["find", "read"],
    ]);
  });

  it.each([
    ["missing name", "---\ndescription: Agent\ntools: [read]\n---\nPrompt", "name"],
    ["empty description", agentFile({ description: "''" }), "description"],
    ["missing tools", "---\nname: example\ndescription: Agent\n---\nPrompt", "tools"],
    ["empty tools", agentFile({ tools: "[]" }), "at least one"],
    ["non-string tool", agentFile({ tools: "[read, 42]" }), "only strings"],
    ["empty body", agentFile({ body: "   " }), "prompt body"],
    ["invalid name", agentFile({ name: "Bad_Name" }), "must match"],
    ["unknown tool", agentFile({ tools: "[read, custom_tool]" }), "unknown tool"],
    ["non-string model", agentFile({ model: "42" }), "model"],
    ["invalid thinking", agentFile({ thinking: "extreme" }), "thinking"],
  ])("skips an agent with %s", async (_label, content, expectedMessage) => {
    const directory = await temporaryDirectory();
    const path = join(directory, "invalid.md");
    writeFileSync(path, content);

    const discovery = discoverAgents(directory);
    expect(discovery.agents).toEqual([]);
    expect(discovery.diagnostics).toHaveLength(1);
    expect(discovery.diagnostics[0]).toMatchObject({ filePath: path });
    expect(discovery.diagnostics[0]?.message).toContain(expectedMessage);
  });

  it("accepts supported model and thinking scalars", async () => {
    const directory = await temporaryDirectory();
    writeFileSync(
      join(directory, "valid.md"),
      agentFile({ name: "valid", model: "anthropic/model-id", thinking: "xhigh" }),
    );

    expect(discoverAgents(directory).agents[0]).toMatchObject({
      model: "anthropic/model-id",
      thinking: "xhigh",
    });
  });

  it("allows Radius search only for scout and reviewer", async () => {
    const directory = await temporaryDirectory();
    writeFileSync(join(directory, "a.md"), agentFile({ name: "reviewer", tools: "[read, radius_web_search]" }));
    writeFileSync(join(directory, "b.md"), agentFile({ name: "scout", tools: "radius_web_search, read" }));
    writeFileSync(join(directory, "c.md"), agentFile({ name: "worker", tools: "[read, radius_web_search]" }));

    const discovery = discoverAgents(directory);
    expect(discovery.agents.map((agent) => agent.name)).toEqual(["reviewer", "scout"]);
    expect(discovery.diagnostics).toHaveLength(1);
    expect(discovery.diagnostics[0]?.message).toContain("allowed only for scout and reviewer");
  });

  it("skips malformed files but retains valid agents with path-specific diagnostics", async () => {
    const directory = await temporaryDirectory();
    const invalidPath = join(directory, "a-invalid.md");
    writeFileSync(invalidPath, "---\nname: [not valid yaml\n---\nPrompt");
    writeFileSync(join(directory, "b-valid.md"), agentFile({ name: "valid" }));

    const discovery = discoverAgents(directory);
    expect(discovery.agents.map((agent) => agent.name)).toEqual(["valid"]);
    expect(discovery.diagnostics).toHaveLength(1);
    expect(discovery.diagnostics[0]?.filePath).toBe(invalidPath);
  });

  it("rejects every definition sharing a duplicate name", async () => {
    const directory = await temporaryDirectory();
    writeFileSync(join(directory, "a.md"), agentFile({ name: "duplicate", description: "First" }));
    writeFileSync(join(directory, "b.md"), agentFile({ name: "duplicate", description: "Second" }));

    const discovery = discoverAgents(directory);
    expect(discovery.agents).toEqual([]);
    expect(discovery.diagnostics).toHaveLength(2);
    expect(discovery.diagnostics.every((diagnostic) => diagnostic.message.includes("duplicate agent name"))).toBe(true);
  });

  it("returns no usable agents when the directory is missing or every file is invalid", async () => {
    const directory = await temporaryDirectory();
    const missing = discoverAgents(join(directory, "missing"));
    expect(missing.agents).toEqual([]);
    expect(missing.diagnostics[0]?.filePath).toBe(join(directory, "missing"));

    writeFileSync(join(directory, "invalid.md"), "not an agent");
    expect(discoverAgents(directory).agents).toEqual([]);
  });

  it("diagnoses unreadable agent files", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "unreadable.md");
    writeFileSync(path, agentFile());
    chmodSync(path, 0o000);

    const discovery = discoverAgents(directory);
    expect(discovery.agents).toEqual([]);
    expect(discovery.diagnostics[0]?.filePath).toBe(path);
  });
});

describe("resolveRadiusWebSearchExtension", () => {
  it("returns the installed readable Radius extension", async () => {
    const agentDir = await temporaryDirectory();
    const extensionPath = join(
      agentDir,
      "npm/node_modules/@earendil-works/pi-radius/extensions/radius-web-search.ts",
    );
    mkdirSync(dirname(extensionPath), { recursive: true });
    writeFileSync(extensionPath, "export default () => {};\n");

    expect(resolveRadiusWebSearchExtension(agentDir)).toBe(extensionPath);
  });

  it("gives an actionable error when Radius is unavailable", async () => {
    const agentDir = await temporaryDirectory();
    expect(() => resolveRadiusWebSearchExtension(agentDir)).toThrow(RADIUS_INSTALL_COMMAND);
  });
});

function installPermissionGate(
  agentDir: string,
  options: { version?: string; packageJson?: string; index?: string } = {},
): { extensionPath: string; packageJsonPath: string } {
  const packageDir = join(agentDir, "git/github.com/ronalson/pi-permission-gate");
  mkdirSync(packageDir, { recursive: true });
  const extensionPath = join(packageDir, "index.ts");
  const packageJsonPath = join(packageDir, "package.json");
  writeFileSync(extensionPath, options.index ?? "export default () => {};\n");
  writeFileSync(
    packageJsonPath,
    options.packageJson ?? JSON.stringify({ name: PERMISSION_GATE_EXPECTED_NAME, version: options.version ?? PERMISSION_GATE_EXPECTED_VERSION }),
  );
  return { extensionPath, packageJsonPath };
}

describe("resolvePermissionGateExtension", () => {
  it("returns the installed readable v0.4.0 gate", async () => {
    const agentDir = await temporaryDirectory();
    const { extensionPath } = installPermissionGate(agentDir);
    expect(resolvePermissionGateExtension(agentDir)).toBe(extensionPath);
  });

  it("honors PI_CODING_AGENT_DIR through getAgentDir", async () => {
    const agentDir = await temporaryDirectory();
    const { extensionPath } = installPermissionGate(agentDir);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      expect(resolvePermissionGateExtension()).toBe(extensionPath);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("does not resolve the gate from cwd", async () => {
    const cwdDir = await temporaryDirectory();
    installPermissionGate(cwdDir);
    const agentDir = await temporaryDirectory();
    const previousCwd = process.cwd();
    process.chdir(cwdDir);
    try {
      expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("fails when the gate is missing", async () => {
    const agentDir = await temporaryDirectory();
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/missing/);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
  });

  it("fails when index.ts is not a regular file", async () => {
    const directoryInsteadOfFile = await temporaryDirectory();
    mkdirSync(join(directoryInsteadOfFile, "git/github.com/ronalson/pi-permission-gate/index.ts"), { recursive: true });
    writeFileSync(
      join(directoryInsteadOfFile, "git/github.com/ronalson/pi-permission-gate/package.json"),
      JSON.stringify({ name: PERMISSION_GATE_EXPECTED_NAME, version: PERMISSION_GATE_EXPECTED_VERSION }),
    );
    expect(() => resolvePermissionGateExtension(directoryInsteadOfFile)).toThrow(/not a regular file/);
  });

  it("fails when index.ts has no read permission bits", async () => {
    const agentDir = await temporaryDirectory();
    const { extensionPath } = installPermissionGate(agentDir);
    chmodSync(extensionPath, 0o000);
    try {
      expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/unreadable/);
      expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
    } finally {
      chmodSync(extensionPath, 0o644);
    }
  });

  it("fails when package.json has no read permission bits", async () => {
    const agentDir = await temporaryDirectory();
    const { packageJsonPath } = installPermissionGate(agentDir);
    chmodSync(packageJsonPath, 0o000);
    try {
      expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/unreadable/);
      expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
    } finally {
      chmodSync(packageJsonPath, 0o644);
    }
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["non-object JSON", "[]"],
    ["missing name", JSON.stringify({ version: PERMISSION_GATE_EXPECTED_VERSION })],
    ["missing version", JSON.stringify({ name: PERMISSION_GATE_EXPECTED_NAME })],
    ["non-string version", JSON.stringify({ name: PERMISSION_GATE_EXPECTED_NAME, version: 3 })],
  ])("fails when package.json is malformed (%s)", async (_label, packageJson) => {
    const agentDir = await temporaryDirectory();
    installPermissionGate(agentDir, { packageJson });
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/malformed/);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
  });

  it("fails when the package name is not pi-permission-gate", async () => {
    const agentDir = await temporaryDirectory();
    installPermissionGate(agentDir, {
      packageJson: JSON.stringify({ name: "other-gate", version: PERMISSION_GATE_EXPECTED_VERSION }),
    });
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/other-gate/);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_EXPECTED_NAME);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
  });

  it("fails when the installed release is stale", async () => {
    const agentDir = await temporaryDirectory();
    installPermissionGate(agentDir, { version: "0.3.0" });
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/0\.3\.0/);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/0\.4\.0/);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(PERMISSION_GATE_INSTALL_COMMAND);
  });

  it("truncates long gate diagnostics on a UTF-8 boundary", () => {
    const agentDir = "\u{1F30D}".repeat(200);
    expect(() => resolvePermissionGateExtension(agentDir)).toThrow(/^Required permission-gate /);
    try {
      resolvePermissionGateExtension(agentDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(512);
      expect(message.endsWith("\u2026")).toBe(true);
      expect(message).not.toContain("\uFFFD");
    }
  });
});
