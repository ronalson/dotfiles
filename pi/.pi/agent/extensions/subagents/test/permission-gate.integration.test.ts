import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import {
  PERMISSION_GATE_EXPECTED_NAME,
  PERMISSION_GATE_EXPECTED_VERSION,
  resolvePermissionGateExtension,
} from "../agents.ts";
import { parsePermissionGateBlockFromEndEvent } from "../permission-gate-block.ts";

const HOST_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const INTEGRATION_GATE_PATH = process.env.PERMISSION_GATE_INTEGRATION_PATH;
const PI_CLI = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
const FAUX_PROVIDER = fileURLToPath(new URL("./fixtures/faux-child-provider.ts", import.meta.url));
const FAKE_GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const SENTINEL_NAME = "SENTINEL";
const INTEGRATION_TIMEOUT_MS = 30_000;

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-subagent-gate-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function eventText(value: unknown): string {
  return JSON.stringify(value ?? "");
}

function jsonlEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (event && typeof event === "object" && !Array.isArray(event)) events.push(event as Record<string, unknown>);
    } catch {
      // Child diagnostics can appear on stdout before JSONL starts.
    }
  }
  return events;
}

function toolEnds(stdout: string): Array<Record<string, unknown>> {
  return jsonlEvents(stdout).filter((event) => event.type === "tool_execution_end");
}

function toolEnd(stdout: string, toolName: string): Record<string, unknown> {
  const match = toolEnds(stdout).find((event) => event.toolName === toolName);
  if (!match) throw new Error(`No tool_execution_end for ${toolName} in:\n${stdout}`);
  return match;
}

function readPackageJson(packageJsonPath: string): { name: string; version: string } {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof parsed?.name !== "string" || parsed.name.trim() === "" || typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`Invalid permission-gate package.json at ${packageJsonPath}`);
  }
  return { name: parsed.name.trim(), version: parsed.version.trim() };
}

function resolveWorktreePermissionGate(indexPath: string): { path: string; name: string; version: string } {
  const stats = statSync(indexPath);
  if (!stats.isFile()) throw new Error(`PERMISSION_GATE_INTEGRATION_PATH is not a file: ${indexPath}`);
  accessSync(indexPath, constants.R_OK);
  const packageJsonPath = join(dirname(indexPath), "package.json");
  const { name, version } = readPackageJson(packageJsonPath);
  if (name !== PERMISSION_GATE_EXPECTED_NAME) {
    throw new Error(`PERMISSION_GATE_INTEGRATION_PATH package name is '${name}', expected '${PERMISSION_GATE_EXPECTED_NAME}'`);
  }
  if (version !== PERMISSION_GATE_EXPECTED_VERSION) {
    throw new Error(
      `PERMISSION_GATE_INTEGRATION_PATH version is '${version}', expected '${PERMISSION_GATE_EXPECTED_VERSION}'`,
    );
  }
  return { path: indexPath, name, version };
}

function resolveReleasedGate(): { path: string; name: string; version: string } {
  if (INTEGRATION_GATE_PATH) return resolveWorktreePermissionGate(INTEGRATION_GATE_PATH);
  const path = resolvePermissionGateExtension(HOST_AGENT_DIR);
  const { name, version } = readPackageJson(join(dirname(path), "package.json"));
  expect(name).toBe(PERMISSION_GATE_EXPECTED_NAME);
  expect(version).toBe(PERMISSION_GATE_EXPECTED_VERSION);
  return { path, name, version };
}

function blockMetadata(event: Record<string, unknown>) {
  return parsePermissionGateBlockFromEndEvent(event)?.metadata;
}

async function runPiJson(options: {
  cwd: string;
  agentDir: string;
  extensions: string[];
  script: unknown;
  prompt?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = join(options.agentDir, "faux-script.json");
  const syntheticHome = join(options.agentDir, "home");
  writeJson(scriptPath, options.script);
  mkdirSync(join(options.agentDir, "sessions"), { recursive: true });
  mkdirSync(syntheticHome, { recursive: true });

  const args = [
    PI_CLI,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--tools",
    "write,edit,bash,read",
    ...options.extensions.flatMap((extension) => ["--extension", extension]),
    "--model",
    "faux/scripted",
    options.prompt ?? "Follow the scripted tool calls.",
  ];

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: syntheticHome,
        TMPDIR: process.env.TMPDIR,
        PI_CODING_AGENT_DIR: options.agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(options.agentDir, "sessions"),
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_SUBAGENT_FAUX_SCRIPT: scriptPath,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi timed out.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, INTEGRATION_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stripAnsi(stderr) });
    });
  });
}

function sentinelScript(cwd: string) {
  return [
    {
      type: "tools",
      calls: [{ name: "write", arguments: { path: join(cwd, SENTINEL_NAME), content: "executed" } }],
    },
    { type: "text", text: "wrote sentinel" },
  ];
}

describe("worktree permission-gate override", () => {
  it("requires the package version to be exactly PERMISSION_GATE_EXPECTED_VERSION", () => {
    const directory = temporaryDirectory();
    const indexPath = join(directory, "index.ts");
    writeFileSync(indexPath, "export default function () {}\n");

    writeJson(join(directory, "package.json"), { name: PERMISSION_GATE_EXPECTED_NAME, version: "0.3.0" });
    expect(() => resolveWorktreePermissionGate(indexPath)).toThrow(/0\.3\.0/);
    expect(() => resolveWorktreePermissionGate(indexPath)).toThrow(PERMISSION_GATE_EXPECTED_VERSION);

    writeJson(join(directory, "package.json"), { name: PERMISSION_GATE_EXPECTED_NAME, version: "0.4.0-rc.1" });
    expect(() => resolveWorktreePermissionGate(indexPath)).toThrow(/0\.4\.0-rc\.1/);
    expect(() => resolveWorktreePermissionGate(indexPath)).toThrow(PERMISSION_GATE_EXPECTED_VERSION);

    writeJson(join(directory, "package.json"), { name: PERMISSION_GATE_EXPECTED_NAME, version: PERMISSION_GATE_EXPECTED_VERSION });
    expect(resolveWorktreePermissionGate(indexPath)).toEqual({
      path: indexPath,
      name: PERMISSION_GATE_EXPECTED_NAME,
      version: PERMISSION_GATE_EXPECTED_VERSION,
    });
  });
});

describe("child startup fail-closed", () => {
  it("does not execute a sentinel tool when the gate is syntactically broken", async () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    const gatePath = join(agentDir, "broken-gate.ts");
    writeFileSync(gatePath, "export default function ( { this is not valid TypeScript\n");

    const result = await runPiJson({
      cwd,
      agentDir,
      extensions: [gatePath, FAUX_PROVIDER],
      script: sentinelScript(cwd),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Failed to load extension");
    expect(existsSync(join(cwd, SENTINEL_NAME))).toBe(false);
    expect(toolEnds(result.stdout)).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);

  it("does not execute a sentinel tool when the gate throws during initialization", async () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    const gatePath = join(agentDir, "throwing-gate.ts");
    writeFileSync(gatePath, "export default function () { throw new Error(\"gate initialization failed\"); }\n");

    const result = await runPiJson({
      cwd,
      agentDir,
      extensions: [gatePath, FAUX_PROVIDER],
      script: sentinelScript(cwd),
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/Failed to load extension[\s\S]*gate initialization failed/);
    expect(existsSync(join(cwd, SENTINEL_NAME))).toBe(false);
    expect(toolEnds(result.stdout)).toEqual([]);
  }, INTEGRATION_TIMEOUT_MS);
});

describe("released permission-gate in JSON mode", () => {
  let releasedGatePath: string;

  beforeAll(() => {
    const gate = resolveReleasedGate();
    expect(gate.name).toBe(PERMISSION_GATE_EXPECTED_NAME);
    expect(gate.version).toBe(PERMISSION_GATE_EXPECTED_VERSION);
    releasedGatePath = gate.path;
  });

  it("allows representative workspace write/edit and ordinary test commands", async () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    writeJson(join(cwd, "package.json"), { name: "gate-fixture", private: true, scripts: { test: "node -e \"console.log('ok')\"" } });
    const sourcePath = join(cwd, "src", "new.ts");

    const result = await runPiJson({
      cwd,
      agentDir,
      extensions: [releasedGatePath, FAUX_PROVIDER],
      script: [
        { type: "tools", calls: [{ name: "write", arguments: { path: sourcePath, content: "export const value = 1;\n" } }] },
        {
          type: "tools",
          calls: [{ name: "edit", arguments: { path: sourcePath, edits: [{ oldText: "value = 1", newText: "value = 2" }] } }],
        },
        { type: "tools", calls: [{ name: "bash", arguments: { command: "npm test" } }] },
        { type: "text", text: "finished allowed work" },
      ],
    });

    expect(result.code).toBe(0);
    expect(toolEnd(result.stdout, "write").isError).toBe(false);
    expect(toolEnd(result.stdout, "edit").isError).toBe(false);
    expect(toolEnd(result.stdout, "bash").isError).toBe(false);
    expect(readFileSync(sourcePath, "utf8")).toBe("export const value = 2;\n");
    expect(eventText(toolEnd(result.stdout, "bash").result)).toContain("ok");
  }, INTEGRATION_TIMEOUT_MS);

  it("blocks synthetic privilege escalation, credential reads, and ordinary rm as confirmation_unavailable", async () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    const home = temporaryDirectory();
    const bin = temporaryDirectory();
    mkdirSync(join(home, ".ssh"), { recursive: true });
    const credentialPath = join(home, ".ssh", "id_rsa");
    writeFileSync(
      credentialPath,
      "-----BEGIN FAKE RSA PRIVATE KEY-----\nnot-a-real-key\n-----END FAKE RSA PRIVATE KEY-----\n",
    );
    const sudoSentinel = join(bin, "sudo-invoked");
    writeFileSync(
      join(bin, "sudo"),
      `#!/bin/sh\necho invoked > ${JSON.stringify(sudoSentinel)}\nexit 0\n`,
    );
    chmodSync(join(bin, "sudo"), 0o755);

    const result = await runPiJson({
      cwd,
      agentDir,
      extensions: [releasedGatePath, FAUX_PROVIDER],
      env: {
        HOME: home,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      },
      script: [
        {
          type: "tools",
          calls: [
            { name: "bash", arguments: { command: "sudo true" } },
            { name: "read", arguments: { path: credentialPath } },
            { name: "bash", arguments: { command: "rm cache/file" } },
          ],
        },
        { type: "text", text: "attempted blocked work" },
      ],
    });

    expect(result.code).toBe(0);
    const ends = toolEnds(result.stdout);
    expect(ends).toHaveLength(3);
    expect(ends.every((event) => event.isError === true)).toBe(true);
    const blocked = ends.map((event) => eventText(event.result)).join("\n");
    expect(blocked).toMatch(/Blocked by permission-gate/);
    expect(blocked).toMatch(/privilege escalation/i);
    expect(blocked).toMatch(/SSH private key/i);
    expect(blocked).toMatch(/confirmation required, but no UI is available/);
    expect(existsSync(sudoSentinel)).toBe(false);

    const classified = ends.map((event) => ({
      text: eventText(event.result),
      metadata: blockMetadata(event),
    }));
    const escalation = classified.find((event) => /privilege escalation/i.test(event.text));
    const credential = classified.find((event) => /SSH private key/i.test(event.text));
    const removal = classified.find((event) => /confirmation required, but no UI is available/.test(event.text));
    expect(escalation?.metadata?.disposition).toBe("denied_by_policy");
    expect(credential?.metadata?.disposition).toBe("denied_by_policy");
    expect(removal?.metadata?.disposition).toBe("confirmation_unavailable");
    for (const event of [escalation, credential, removal]) {
      expect(event?.metadata?.rules.length).toBeGreaterThan(0);
      expect(event?.metadata?.rules.every((rule) => /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/.test(rule))).toBe(true);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it("redacts supported read/bash results containing fake secrets", async () => {
    const cwd = temporaryDirectory();
    const agentDir = temporaryDirectory();
    const notesPath = join(cwd, "notes.txt");

    const result = await runPiJson({
      cwd,
      agentDir,
      extensions: [releasedGatePath, FAUX_PROVIDER],
      script: [
        { type: "tools", calls: [{ name: "write", arguments: { path: notesPath, content: `token ${FAKE_GITHUB_TOKEN}\n` } }] },
        { type: "tools", calls: [{ name: "read", arguments: { path: notesPath } }] },
        { type: "tools", calls: [{ name: "bash", arguments: { command: `printf '%s\\n' '${FAKE_GITHUB_TOKEN}'` } }] },
        { type: "text", text: "finished redaction checks" },
      ],
    });

    expect(result.code).toBe(0);
    const readResult = eventText(toolEnd(result.stdout, "read").result);
    const bashResult = eventText(toolEnd(result.stdout, "bash").result);
    expect(readResult).toContain("<redacted:github-token>");
    expect(readResult).toContain("[permission-gate redacted sensitive values]");
    expect(readResult).not.toContain(FAKE_GITHUB_TOKEN);
    expect(bashResult).toContain("<redacted:github-token>");
    expect(bashResult).toContain("[permission-gate redacted sensitive values]");
    expect(bashResult).not.toContain(FAKE_GITHUB_TOKEN);
  }, INTEGRATION_TIMEOUT_MS);
});
