import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const BUILTIN_AGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const RADIUS_WEB_SEARCH_TOOL = "radius_web_search";
export const RADIUS_INSTALL_COMMAND = "pi install npm:@earendil-works/pi-radius";

const ALLOWED_TOOLS = new Set<string>([...BUILTIN_AGENT_TOOLS, RADIUS_WEB_SEARCH_TOOL]);
const RADIUS_ROLES = new Set(["scout", "reviewer"]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  thinking?: ThinkingLevel;
  systemPrompt: string;
  filePath: string;
}

export interface AgentDiagnostic {
  filePath: string;
  message: string;
}

export interface AgentDiscovery {
  agents: AgentConfig[];
  diagnostics: AgentDiagnostic[];
}

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinking?: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`frontmatter '${field}' must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`frontmatter '${field}' must be a non-empty string when provided`);
  }
  return value.trim();
}

function parseTools(value: unknown): string[] {
  let raw: unknown[];
  if (typeof value === "string") {
    raw = value.split(",");
  } else if (Array.isArray(value)) {
    raw = value;
  } else {
    throw new Error("frontmatter 'tools' must be a string or string array");
  }

  if (raw.some((tool) => typeof tool !== "string")) {
    throw new Error("frontmatter 'tools' must contain only strings");
  }

  const tools = [...new Set((raw as string[]).map((tool) => tool.trim()).filter(Boolean))];
  if (tools.length === 0) {
    throw new Error("frontmatter 'tools' must contain at least one tool");
  }
  return tools;
}

function validateTools(name: string, tools: string[]): void {
  for (const tool of tools) {
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new Error(`unknown tool '${tool}'`);
    }
    if (tool === RADIUS_WEB_SEARCH_TOOL && !RADIUS_ROLES.has(name)) {
      throw new Error(`'${RADIUS_WEB_SEARCH_TOOL}' is allowed only for scout and reviewer`);
    }
  }
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
  const thinking = optionalString(value, "thinking");
  if (thinking === undefined) return undefined;
  if (!THINKING_LEVELS.has(thinking as ThinkingLevel)) {
    throw new Error(`frontmatter 'thinking' must be one of: ${[...THINKING_LEVELS].join(", ")}`);
  }
  return thinking as ThinkingLevel;
}

function loadAgent(filePath: string): AgentConfig {
  const content = readFileSync(filePath, "utf8");
  const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
  const name = requiredString(frontmatter.name, "name");

  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error("frontmatter 'name' must match ^[a-z][a-z0-9-]*$");
  }

  const tools = parseTools(frontmatter.tools);
  validateTools(name, tools);

  const systemPrompt = body.trim();
  if (systemPrompt === "") {
    throw new Error("agent prompt body must not be empty");
  }

  return {
    name,
    description: requiredString(frontmatter.description, "description"),
    tools,
    model: optionalString(frontmatter.model, "model"),
    thinking: parseThinking(frontmatter.thinking),
    systemPrompt,
    filePath,
  };
}

export function getSubagentsExtensionDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function getBundledAgentsDir(): string {
  return join(getSubagentsExtensionDir(), "agents");
}

export function discoverAgents(agentDir = getBundledAgentsDir()): AgentDiscovery {
  const diagnostics: AgentDiagnostic[] = [];
  const candidates: AgentConfig[] = [];

  let entries;
  try {
    entries = readdirSync(agentDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch (error) {
    return {
      agents: [],
      diagnostics: [{ filePath: agentDir, message: `cannot read agents directory: ${errorMessage(error)}` }],
    };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(agentDir, entry.name);
    try {
      if (!statSync(filePath).isFile()) {
        throw new Error("path does not resolve to a file");
      }
      candidates.push(loadAgent(filePath));
    } catch (error) {
      diagnostics.push({ filePath, message: errorMessage(error) });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const candidate of candidates) {
    nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
  }

  const agents: AgentConfig[] = [];
  for (const candidate of candidates) {
    if ((nameCounts.get(candidate.name) ?? 0) > 1) {
      diagnostics.push({
        filePath: candidate.filePath,
        message: `duplicate agent name '${candidate.name}'`,
      });
    } else {
      agents.push(candidate);
    }
  }

  return { agents, diagnostics };
}

export function resolveRadiusWebSearchExtension(agentDir = getAgentDir()): string {
  const extensionPath = join(
    agentDir,
    "npm",
    "node_modules",
    "@earendil-works",
    "pi-radius",
    "extensions",
    "radius-web-search.ts",
  );

  try {
    if (!statSync(extensionPath).isFile()) {
      throw new Error("path does not resolve to a file");
    }
    accessSync(extensionPath, constants.R_OK);
  } catch {
    throw new Error(
      `The '${RADIUS_WEB_SEARCH_TOOL}' tool requires @earendil-works/pi-radius. Install it with: ${RADIUS_INSTALL_COMMAND}`,
    );
  }

  return extensionPath;
}
