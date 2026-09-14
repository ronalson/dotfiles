# Minimal Pi Subagents Extension — Specification and Implementation Plan

Status: proposed v1

Target: `~/.pi/agent/extensions/subagents/` after stowing the `pi` package

Tool name: `subagent`

## 1. Executive decision

Build a small, foreground-only Pi extension that exposes one LLM-facing tool:

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the authentication flow and cite the relevant files." },
  ],
})
```

The same shape handles parallel work:

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the persistence layer." },
    { agent: "reviewer", task: "Review error handling in the API layer." },
  ],
})
```

Each task runs in an isolated, ephemeral child `pi` process. The extension streams concise progress, propagates cancellation, aggregates nested model usage, and returns results in input order. A process-wide semaphore limits all child processes to four, including children started by simultaneous `subagent` tool calls. Children load no extensions except the explicitly approved `radius-web-search` extension when the selected role declares `radius_web_search`.

V1 intentionally does not implement background runs, status polling, steering, resume, nested delegation, chains, schedules, worktrees, memory, agent management, project-local agent discovery, or arbitrary extension loading. Those features are useful in larger products, but they would turn the extension into an orchestration platform instead of a minimal delegation tool.

## 2. Design objective

The extension should feel like a native Pi tool while remaining understandable in one sitting.

The external seam is the single `subagent` tool. Callers learn only:

- one parameter, `tasks`;
- each task has `agent` and `task`;
- one item means a single run, multiple items run concurrently;
- subagents start with fresh conversation context;
- cancellation of the parent tool cancels its children.

Everything else belongs behind that seam: agent discovery and validation, model selection, prompt assembly, Pi binary resolution, process creation, JSONL parsing, concurrency, cancellation, output budgeting, usage aggregation, failures, and rendering.

This is a deep module: a small interface provides substantial behavior and concentrates future fixes in one implementation.

## 3. Goals

V1 must:

1. Register exactly one tool named `subagent`.
2. Support one to four tasks per call with a single parameter shape.
3. Run tasks in isolated child Pi processes with no inherited conversation transcript.
4. Discover role definitions from Markdown files owned by this extension.
5. Give every role an explicit tool allowlist, limited to Pi built-ins plus `radius_web_search` for approved roles.
6. Inherit the parent model and thinking level when a role does not pin a model and the model is independently available to the child process.
7. Stream useful progress without flooding the parent session.
8. Enforce a global maximum of four live child processes.
9. Abort queued and running children when the tool's `AbortSignal` fires.
10. Report child token and cost usage through the tool result's top-level `usage` field.
11. Bound all model-visible output to Pi's documented tool-output limits.
12. Work in interactive, print, and JSON modes; custom rendering is an interactive enhancement only.
13. Be installed by GNU Stow as part of the existing `pi` dotfiles package.
14. Have focused tests for discovery, invocation, JSON parsing, concurrency, cancellation, error handling, and usage aggregation.

## 4. Non-goals

The following are explicitly out of scope for v1:

- Background agents or detached jobs.
- Run IDs, polling, fleet views, persistent widgets, or notifications.
- Steering a running child or resuming a completed child.
- Persistent child sessions or transcript files.
- Parent-session forks or automatic conversation inheritance.
- Nested subagents. Child Pi processes must not load this extension.
- Sequential chain syntax or `{previous}` interpolation.
- Dynamic workflows or JavaScript workflow evaluation.
- Git worktree isolation or automatic commits.
- Per-agent memory, skills, schedules, missions, acceptance gates, or budgets.
- Agent creation, editing, disabling, aliases, packages, or refinement overlays.
- Project-local `.pi/agents` or `.agents/agents` discovery.
- Arbitrary custom tools or custom extension paths in agent frontmatter. V1 has one hard-coded exception: the installed `@earendil-works/pi-radius` web-search extension may provide `radius_web_search` to approved roles.
- A `config.json`; the v1 limits are constants.
- A security sandbox. Pi and its children retain the invoking user's OS permissions.

These exclusions are part of the product contract, not missing implementation work.

## 5. Research basis

### 5.1 Official Pi behavior to follow

The official local documentation and example establish the supported mechanics:

- Extensions in `~/.pi/agent/extensions/<name>/index.ts` are auto-discovered and reloadable with `/reload`.
- `pi.registerTool()` is the correct extension interface.
- A tool receives an `AbortSignal`, an `onUpdate` callback, and `ExtensionContext`.
- Child Pi can emit newline-delimited structured events with `--mode json`.
- `message_end` is the authoritative completed message event.
- `--tools` is a strict tool allowlist; `--no-tools` disables every tool.
- `--no-extensions`, `--no-skills`, and `--no-prompt-templates` allow a controlled child environment.
- `--no-session` creates an ephemeral child.
- `--no-approve` ignores project-local resources in a non-interactive child.
- `--model`, singular, selects the child model. `--models`, plural, only scopes model cycling and must not be used for selection.
- Tool implementations that perform nested model calls should return combined `Usage` as top-level `usage`.
- A tool signals a failed execution by throwing. Returning an `isError` field does not mark a current Pi tool result as failed.
- Tool output must be truncated to 50 KB and 2,000 lines or less.
- Current imports use `@earendil-works/*`, not the older `@mariozechner/*` names used by the Amos reference.

Primary local sources:

- `/Users/ronalson/Code/oss/pi/packages/coding-agent/docs/extensions.md`
- `/Users/ronalson/Code/oss/pi/packages/coding-agent/docs/json.md`
- `/Users/ronalson/Code/oss/pi/packages/coding-agent/docs/usage.md`
- `/Users/ronalson/Code/oss/pi/packages/coding-agent/docs/security.md`
- `/Users/ronalson/Code/oss/pi/packages/coding-agent/docs/packages.md`
- `/Users/ronalson/Code/oss/pi/packages/coding-agent/examples/extensions/subagent/`

### 5.2 What to borrow from Amos

Borrow:

- A single delegation tool.
- Markdown role definitions with frontmatter and a system-prompt body.
- Fresh child processes using Pi JSON mode.
- Single and parallel execution presented through one UI.
- Bounded concurrency, progress updates, abort propagation, usage display, and compact/expanded rendering.
- Small default role set.

Do not borrow:

- Hard-coded model versions; inherit the parent by default.
- `--models` for model selection; use `--model`.
- The `globalThis.__pi_subagents` registration bridge.
- A hard-coded custom-tool-to-extension map.
- Loading custom extensions into children.
- Returning `isError`; current Pi requires throwing.
- A mutable global agent registry when static extension-local discovery suffices.
- A `config.json` for a single concurrency value.

Reference:

- `/Users/ronalson/Code/oss/pi-references/amosblomqvist-pi-subagents/`

### 5.3 What to learn from the larger implementations

The Tintin and Nicobailon implementations demonstrate real needs at larger scale: robust Pi executable resolution, global concurrency control, cancellation cleanup, strict agent resolution, bounded logs, malformed-agent recovery, and explicit capability ceilings. V1 should adopt those reliability lessons.

Their background managers, status protocols, sessions, steering, worktrees, nested agents, scheduling, memory, RPC, missions, workflow engines, and fleet UIs are intentionally deferred. Pulling those modules into v1 would multiply the interface and state space before the basic delegation path is proven.

References:

- `/Users/ronalson/Code/oss/pi-references/tintinweb-pi-subagents/`
- `/Users/ronalson/Code/oss/pi-references/nicobailon-pi-subagents/`

## 6. User experience contract

### 6.1 Tool interface

The only accepted request shape is:

```ts
interface SubagentParams {
  tasks: Array<{
    agent: AgentName;
    task: string;
  }>;
}
```

Constraints:

- `tasks` has `minItems: 1` and `maxItems: 4`.
- The root object and each task object set `additionalProperties: false`.
- `agent` is a `StringEnum` built from the discovered role names for Google-provider compatibility.
- `task` has `minLength: 1`, `maxLength: 65_536`, and a documented expectation that all necessary conversation context be included. Preflight also rejects a UTF-8 task larger than 64 KiB because JSON Schema string length is not a byte limit.
- No `cwd` parameter is exposed. Every child runs in `ctx.cwd`.
- No separate single/parallel mode fields exist.
- Results always preserve task input order, regardless of completion order.

The tool description must list every available role and say plainly:

- subagents receive no parent conversation transcript;
- tasks must be self-contained;
- one task is a normal single delegation;
- multiple independent tasks run concurrently;
- use direct Pi tools for simple file reads or shell commands;
- use subagents for independent reasoning, review, exploration, or an isolated implementation slice.

### 6.2 Default roles

Ship four extension-local roles:

| Role | Tools | Model behavior | Purpose |
|---|---|---|---|
| `advisor` | `read` | `openai-codex/gpt-6-astra`, thinking `high` | Independent consult for a difficult decision, architectural trade-off, or consequential review. Requires a prepared evidence packet. |
| `scout` | `read, grep, find, ls, radius_web_search` | `openrouter/z-ai/glm-5.3-flash` | Fast codebase reconnaissance, optional current web research, and compressed handoff context |
| `reviewer` | `read, grep, find, ls, radius_web_search` | `openai-codex/gpt-5.6-sol` | Read-only correctness, test, security, and maintainability review with access to current external sources |
| `worker` | `read, grep, find, ls, bash, edit, write` | `xai/grok-4.6`, thinking `high` | A narrowly scoped implementation task with verification |

Pinned models are still resolved through the child CLI. Unpinned roles continue to inherit the parent. `radius/claude-fable-5-1` is enabled as a possible later advisor substitute; do not pin it now.

The scout and reviewer may use `radius_web_search` only when the task explicitly requires web research or truly current information; local repository inspection remains their default.

The reviewer deliberately has no `bash`. This makes its enforced local tool surface read-only, at the cost of not running `git diff` or tests itself. The parent should include the relevant files or diff location in the task. If a future reviewer needs command execution, that should be an explicit role with a clearly documented capability increase.

The worker is mutation-capable. Its prompt must require targeted edits, existing-file inspection, relevant checks, and a final report of files changed and verification performed.

The advisor is not a reviewer and not an explorer. Call it only when a difficult decision, architectural trade-off, or consequential independent review warrants a second model. Routine implementation, debugging, search, and checks stay with the parent or with `scout` / `worker`. The parent-facing frontmatter description must state that restriction. The only tool is `read`, so the parent has to assemble the packet; the advisor must not survey the repository.

The parent sends a self-contained packet: the precise question, desired outcome, acceptance criteria, constraints, and either viable options plus the unresolved trade-off or a review scope without steering the verdict. Include excerpts or a diff with paths and line numbers, plus known unknowns. Prefer excerpts over whole files and conversation history.

The advisor answers from that packet. It may `read` only files or ranges the packet explicitly scopes. If missing evidence could change the answer, it returns a focused request to the parent and stops. It does not implement, verify, write files, or search. A second `advisor` call with the prior conclusion and new evidence replaces resume.

The parent, not the advisor, preserves high-value consultations in `<repo-root>/context/advisor/YYYY-MM-DD-topic.md`. Create the directory when needed and add a suffix rather than overwriting. Never write these notes to `context/astra/`. Do not commit `context/` files unless explicitly requested. For a small clarification without durable value, keep the answer in the conversation.

### 6.3 Agent file format

Agent files live under `agents/*.md` beside the extension:

```md
---
name: scout
description: Fast read-only codebase reconnaissance
tools: [read, grep, find, ls, radius_web_search]
# model: provider/model-id       # optional
# thinking: high                # optional
---

You are a scout operating in a fresh Pi session...
```

Rules:

- `name`, `description`, and `tools` are required.
- `name` must match `^[a-z][a-z0-9-]*$`.
- `tools` accepts a YAML string or string array during parsing, then normalizes to a unique, non-empty array. Empty tool lists are invalid rather than falling through to Pi's default tools.
- Every tool must be one of Pi's built-ins (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) or the single approved custom tool `radius_web_search`.
- `radius_web_search` is the only valid custom tool name and may be declared only by the bundled `scout` and `reviewer` roles. Before launching a requested role that declares it, preflight must resolve the installed `@earendil-works/pi-radius` web-search extension from Pi's user package directory. The extension path is implementation-owned and cannot be supplied through frontmatter.
- `model` is optional. When absent, inherit the exact parent `provider/id`.
- `thinking` is optional and must be one of Pi's supported levels.
- If both `model` and `thinking` are absent, inherit parent model and thinking.
- If `model` is pinned and `thinking` is absent, let that model use Pi's default thinking level.
- The Markdown body is required and becomes the role-specific appended system prompt.
- Resolve the extension directory with `fileURLToPath(import.meta.url)`, not URL pathname parsing, so spaces and other encoded path characters work correctly.
- Files are loaded in stable filename order at extension initialization. Regular files and symbolic links that resolve to files are accepted because GNU Stow installs these entries as symlinks. Editing them requires `/reload`.
- Invalid, dangling, or unreadable files are skipped with a path-specific warning. Duplicate names are rejected rather than silently overridden.
- The tool is not registered if no valid agents remain.

V1 discovers only this extension's `agents/` directory. This avoids project-agent trust, precedence, and prompt-injection policy becoming part of the public interface.

## 7. Architecture

```text
Parent Pi
  |
  | subagent({ tasks })
  v
index.ts — validate request, acquire slots, aggregate results
  |                    |                      |
  v                    v                      v
agents.ts          runner.ts              render.ts
discover roles     child lifecycle        TUI-only presentation
validate config    JSONL + usage
                    cancellation
  |
  | spawn with controlled flags, cwd = parent cwd
  v
Child Pi process (fresh context, no session, no discovered extensions; optional approved Radius search extension)
```

### 7.1 Module seams

`index.ts` is the Pi adapter. It owns the external seam and should contain only registration, request-level orchestration, and result policy.

`agents.ts` is a deep discovery module:

```ts
discoverAgents(agentDir: string): AgentDiscovery
```

It hides directory reading, frontmatter parsing, normalization, validation, duplicate handling, ordering, and diagnostics.

`runner.ts` is the deepest module:

```ts
runAgent(request: RunRequest, options: RunOptions): Promise<RunResult>
```

It hides invocation construction, Pi executable resolution, secure prompt handling, process I/O, JSONL parsing, progress state, usage aggregation, truncation, cancellation, termination escalation, and cleanup.

`render.ts` translates stable tool details into interactive components. It must not own execution state or mutate results.

Do not create separate files for trivial helpers or shared types. Keep types with the module that owns their invariants; export only types used across the three real seams.

## 8. Planned file layout

```text
pi/.pi/agent/extensions/subagents/
├── SPEC.md
├── README.md
├── index.ts
├── agents.ts
├── runner.ts
├── render.ts
├── package.json
├── tsconfig.json
├── agents/
│   ├── advisor.md
│   ├── reviewer.md
│   ├── scout.md
│   └── worker.md
└── test/
    ├── agents.test.ts
    ├── runner.test.ts
    └── extension.test.ts
```

After `./install.sh pi`, the runtime path is:

```text
~/.pi/agent/extensions/subagents/index.ts
```

The extension directory style is required so Pi auto-discovers `index.ts` and `/reload` works. The package manifest exists for local type-checking and tests; runtime imports remain Pi-provided peer dependencies.

Repository integration note: `pi/.stow-local-ignore` currently excludes the complete extension path with `^/\.pi/agent/extensions/subagents$`. Remove that draft exclusion when implementation starts; otherwise none of these files will be stowed. Verify the changed rule with `./install.sh --dry pi` before installation.

## 9. Runtime contracts

### 9.1 Stable details model

The tool result uses a versioned, compact details object:

```ts
type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface RunProgress {
  status: RunStatus;
  activeTools: Array<{ id: string; name: string; preview: string }>;
  activeToolOverflow: number;
  recentTools: Array<{ name: string; preview: string }>;
  lastTextPreview?: string;
  toolCalls: number;
  turns: number;
  durationMs: number;
}

interface RunResult {
  agent: string;
  taskPreview: string;
  status: RunStatus;
  output: string;
  error?: string;
  model?: string;
  usage: Usage;
  progress: RunProgress;
}

interface SubagentDetails {
  kind: "subagents";
  version: 1;
  runs: RunResult[];
}
```

Only bounded task/tool/text previews and bounded final output are stored. Retain at most 16 active tool entries, recording any additional count in `activeToolOverflow`, and at most five completed entries. Full task text remains in the original tool-call arguments and is not duplicated in `details`; full child transcripts are not retained. Interactive rendering reads execution state from `SubagentDetails` and may read the original delegated task from `renderResult`'s `context.args`, as recommended by Pi's rendering API.

### 9.2 Child command

Construct child arguments as discrete array elements and spawn with `shell: false`:

```text
pi
  --mode json
  -p
  --no-session
  --no-extensions
  --no-skills
  --no-prompt-templates
  --no-approve
  --tools <comma-separated role tools>
  --extension <resolved radius-web-search.ts>  # only for roles declaring radius_web_search
  --model <resolved model>            # when available
  --thinking <resolved thinking>      # according to inheritance rules
  --append-system-prompt <temp file>
```

Important details:

- Use the official example's verified resolution strategy: prefer the currently running Pi entry script with `process.execPath`, handle standalone Pi executables, then fall back to `pi` on `PATH`.
- Never invoke a shell to launch Pi.
- Pass `--model`, not `--models`.
- Always use `--no-extensions` to disable extension discovery. When a role declares `radius_web_search`, additionally pass exactly one implementation-resolved `--extension` path for `@earendil-works/pi-radius/extensions/radius-web-search.ts`; no agent-controlled extension path is accepted.
- Keep `--tools` as the final capability allowlist across built-in and explicitly loaded extension tools.
- Resolve the Radius extension beneath `getAgentDir()/npm/node_modules/@earendil-works/pi-radius/` and verify that it is a readable file before any task launches. If a requested role needs it but the package is absent, fail the entire call during preflight with the installation command `pi install npm:@earendil-works/pi-radius`.
- Keep context files enabled. `AGENTS.md`/`CLAUDE.md` contain repository conventions and load independently of project trust.
- Use `--no-approve` to ignore project `.pi` settings and executable resources in the non-interactive child.
- Write the role prompt to a mode-`0600` temporary file and pass its path to `--append-system-prompt`.
- Send the task through child stdin and close stdin. Pi print/JSON mode officially merges piped stdin into the initial prompt. This avoids command-line length limits and exposing the task in process arguments.
- Prefix stdin with a short stable envelope: `Delegated task:\n<task>`.
- Delete the temporary directory in `finally`, on success, failure, spawn error, and cancellation.

### 9.3 Model resolution

At tool execution time, capture parent defaults:

```ts
const parentModel = ctx.model
  ? `${ctx.model.provider}/${ctx.model.id}`
  : undefined;
const parentThinking = ctx.thinkingLevel;
```

For each agent:

1. If `agent.model` exists, pass it through `--model`.
2. Otherwise, pass the exact parent model when present.
3. If `agent.thinking` exists, pass it through `--thinking`.
4. Otherwise, inherit parent thinking only when the model is also inherited.
5. If neither parent nor role selects a model, omit `--model` and let the child use Pi's configured default.

Do not implement fuzzy model matching in the extension. Pi already owns CLI model resolution and produces the authoritative error.

This inheritance contract applies only to models independently available in the child CLI through Pi core and normal model configuration. A model or provider registered solely by a parent extension is unavailable because children disable extension discovery. V1 must report that limitation as an actionable child startup failure; loading arbitrary provider extensions or forwarding parent runtime credentials is out of scope.

### 9.4 JSON event processing

Read stdout as UTF-8 JSONL using `StringDecoder`, not `Buffer.toString()` per chunk, so a multi-byte character split across chunks is not corrupted. Limit any pending JSONL record to 1 MiB; exceeding that bound fails the child without retaining the full record.

For each complete line:

- Ignore blank lines.
- Parse JSON; count malformed lines and retain only a small diagnostic count/sample.
- `tool_execution_start`: increment tool-call count and add an active entry keyed by `toolCallId`, retaining at most 16 entries and counting overflow.
- `tool_execution_end`: remove the matching active entry by `toolCallId` and add it to a ring buffer of the last five completed calls.
- Never represent active child tools with a single mutable slot: Pi may run sibling tool calls concurrently and complete them out of order.
- `message_end` with assistant role:
  - increment turn count;
  - aggregate the complete `Usage` shape;
  - update the resolved model;
  - capture `stopReason` and `errorMessage`;
  - replace final output when the message has non-empty text content;
  - update the bounded last-text preview.

`message_end` is authoritative. Streaming `message_update` deltas are unnecessary for v1; tool activity plus completed assistant text gives useful progress with much less parsing and repainting.

Stderr is diagnostic only. Retain at most the last 64 KiB so a noisy child cannot grow parent memory without bound.

### 9.5 Usage aggregation

Use Pi's full `Usage` shape:

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

Sum every numeric field across assistant turns and across child runs. Preserve optional fields when any child reports them.

The final tool result must set:

```ts
return {
  content,
  details,
  usage: aggregateUsage(results.map((result) => result.usage)),
};
```

This is required for accurate Pi footer, `/session`, and RPC totals. Usage shown in custom rendering comes from the same aggregated data, not a second calculation.

### 9.6 Global concurrency

Create one extension-scoped FIFO semaphore with capacity four.

Properties:

- Every child must acquire a permit immediately before spawn.
- Every permit is released in `finally`.
- Queued acquisition accepts the task's `AbortSignal` and rejects immediately when aborted.
- Fairness is FIFO.
- A single call with four tasks uses all four slots.
- Two simultaneous `subagent` calls still produce no more than four child processes total.
- Completion order does not change returned result order.

Do not expose concurrency in the public tool schema or a config file in v1.

### 9.7 Cancellation and shutdown

When the tool signal aborts:

1. Remove queued tasks from the semaphore queue and mark them cancelled.
2. Send `SIGTERM` to every running child.
3. Start a five-second escalation timer.
4. If a process still has `exitCode === null` after the grace period, send `SIGKILL`.
5. Remove abort listeners and timers when the process closes.
6. Await child settlement and temporary-file cleanup.
7. Throw one concise cancellation error from the tool execution.

Do not test `child.killed` to determine whether the process exited; Node sets it when a signal was successfully sent, not when the process is gone.

The extension starts no resources at factory load or `session_start`, so it needs no long-lived `session_shutdown` handler.

### 9.8 Output budgeting

The combined model-visible result must stay below Pi's documented 50 KiB and 2,000-line limits.

Budgeting algorithm:

1. Reserve space for headings, statuses, and truncation notices.
2. Divide the remaining byte and line budget evenly across the requested tasks.
3. Truncate each result independently with Pi's exported truncation utilities.
4. State exactly when output was truncated.
5. Run one final combined-output truncation as a safety net.
6. Store only the bounded output in `details`; do not hide an unbounded transcript there.

For one task, nearly the full budget is available. Four tasks each receive roughly one quarter. This is more useful than a fixed small per-task cap while still protecting the parent context.

## 10. Result and failure policy

### 10.1 Successful single run

Return the child's final assistant text directly as model-visible content, plus details and usage.

### 10.2 Successful parallel run

Return one section per task in input order:

```md
Parallel: 2/2 succeeded

## scout — succeeded

...

---

## reviewer — succeeded

...
```

### 10.3 Preflight failures

Throw before starting any child when:

- parameters violate the schema;
- an agent is unknown;
- agent discovery produced no valid roles;
- the working directory is unavailable;
- any requested role declares `radius_web_search` but the approved Radius extension file cannot be resolved;

Validate every parallel task before acquiring permits so a typo never causes a partial launch.

### 10.4 Child failures

A child is failed when any of these holds:

- process exit code is non-zero;
- assistant `stopReason` is `error` or `aborted`;
- the assistant reports `errorMessage`;
- the process exits without a usable final assistant output;
- stdout contains no valid `session` record before process close, or an individual JSONL record exceeds the runner's bounded line buffer. Isolated malformed nonblank lines are counted and sampled for diagnostics but do not invalidate an otherwise usable stream.

For a single task, throw a concise error containing role, exit code/stop reason, and bounded stderr or provider error.

For multiple tasks with at least one success, retain partial value: return all task sections and mark failures prominently. Do not throw after some children have produced useful results, because current Pi thrown tool errors cannot preserve the structured partial details. The content must begin with `Parallel: N/M succeeded` so the parent cannot mistake partial success for complete success.

If every parallel task fails, throw one bounded aggregate error after all children settle; there is no successful partial value to preserve. If cancellation occurs, cancellation wins over either result policy and the tool throws after cleanup.

### 10.5 Spawn errors

Preserve the original cause in logs/details where available, but show a short actionable message to the model:

- `ENOENT`: Pi executable could not be resolved.
- `EACCES`: resolved executable is not runnable.
- Other spawn errors: name the role and error code/message.

Never include environment variables or entire process arguments in errors.

## 11. Interactive rendering

Custom rendering should be useful but deliberately small.

### 11.1 Call rendering

One task:

```text
subagent scout  Map the authentication flow…
```

Multiple tasks:

```text
subagent parallel ×3  scout, reviewer, scout
```

### 11.2 Collapsed result

For every run show:

- status icon;
- role name;
- task preview;
- every currently active tool, bounded and keyed internally by tool-call ID;
- at most five recent completed tool calls;
- last assistant-text preview;
- turns, tool calls, tokens, elapsed time, cost, and model when known.

Do not create a persistent widget or footer status. The normal tool result is sufficient for foreground work.

### 11.3 Expanded result

Show:

- full delegated task;
- final output rendered as Markdown;
- failure diagnostic when applicable;
- usage breakdown.

Rendering consumes execution state only from `SubagentDetails`; it may use `context.args` to show the original task without duplicating it into details. Print, JSON, and RPC modes continue to receive ordinary tool content/details without relying on terminal UI methods.

Throttle progress rendering to at most once every 150 ms per tool call. Flush immediately when a child completes so the final state is never delayed behind the throttle timer.

## 12. Security model

The extension narrows capability but does not create a sandbox.

- Extension code and child Pi processes run with the current user's full OS permissions.
- The role tool allowlist limits tools presented to the model, but any role with `bash` can potentially perform any action available to the user.
- Only `worker` receives `bash`, `edit`, and `write` in the default set.
- Extension discovery is disabled. A scout or reviewer may load exactly the resolved `@earendil-works/pi-radius` web-search extension; no other child extension and no recursive delegation tool is loaded.
- Radius web search is a slow, paid external request and requires Radius authentication. Role prompts must reserve it for explicit web research or truly current information.
- Project-local Pi resources are declined with `--no-approve`.
- Repository context files remain enabled and can contain prompt injection. This is normal Pi local-agent risk and must be documented.
- The child cwd is fixed to the parent cwd; the model cannot request a different directory through the tool schema.
- Spawn uses `shell: false` and an argument array.
- Role prompts use mode-`0600` temporary files.
- Tasks travel over stdin rather than process arguments.
- Output, stderr, previews, and tool arguments are bounded before persistence.
- No credentials, environment values, or full command environment are added to details or logs.

For untrusted repositories or unattended mutation work, the user must run the parent Pi inside an OS/container sandbox. This extension must not imply otherwise.

## 13. Package and dependency plan

Use a private local package manifest for developer tooling:

```json
{
  "name": "@ronalson/pi-subagents-local",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

Add current compatible packages, TypeScript, Vitest, and Node types as development dependencies when implementation starts. Runtime Pi packages must remain peers, matching official package guidance and avoiding duplicate Pi module roots.

The extension code has no imported runtime dependency beyond Node built-ins and Pi-provided packages. The bundled scout and reviewer additionally require the user-installed `@earendil-works/pi-radius` Pi package at runtime because their child processes explicitly load its `radius-web-search.ts` extension. Document and verify this prerequisite rather than vendoring or dynamically installing it.

## 14. Test plan

### 14.1 Agent discovery tests

- Loads all four valid bundled roles in stable filename order: advisor, reviewer, scout, worker.
- Asserts pinned models and thinking: advisor `openai-codex/gpt-6-astra` / `high`; reviewer `openai-codex/gpt-5.6-sol`; scout `openrouter/z-ai/glm-5.3-flash`; worker `xai/grok-4.6` / `high`.
- Loads the same roles when the agent entries are symbolic links, and diagnoses dangling symlinks.
- Resolves the extension directory through `fileURLToPath(import.meta.url)`.
- Accepts `tools` as YAML array and comma-separated string.
- Trims and deduplicates tools.
- Rejects a missing name, description, tools list, prompt body, or normalized empty tool list.
- Accepts `radius_web_search` for scout and reviewer, rejects it for worker or any other role, and rejects every other non-built-in tool.
- Rejects invalid names and unknown tools.
- Rejects duplicate names without silent override.
- Validates model and thinking scalars.
- Skips one malformed file while returning a path-specific diagnostic for it.
- Refuses to produce a usable discovery result when every file is invalid.

### 14.2 Invocation tests

- Uses `--model`, never `--models`.
- Includes JSON, print, ephemeral-session, no-extension, no-skill, no-template, and no-approve flags.
- Uses the exact normalized tool allowlist.
- Resolves and loads only `radius-web-search.ts` for roles declaring `radius_web_search`, and fails preflight when the installed package is missing.
- Never accepts an extension path from role frontmatter or tool parameters.
- Inherits parent model/thinking according to the decision table.
- Honors role-pinned model/thinking.
- Omits optional model flags when neither role nor parent supplies them.
- Uses `shell: false`, the requested cwd, piped stdin, and a mode-`0600` prompt file.
- Resolves current Pi entry, standalone Pi, and `PATH` fallback cases.
- Cleans temporary files on every terminal path.

### 14.3 JSONL parser tests

- Parses several events in one chunk.
- Parses one event split across many chunks.
- Preserves a multi-byte Unicode character split across buffer boundaries.
- Ignores blank lines.
- Bounds both the pending line buffer and malformed-line diagnostics.
- Requires a valid `session` record but tolerates isolated malformed lines when a usable stream follows.
- Tracks multiple active tools by ID, including interleaved starts, overflow beyond 16 retained entries, and out-of-order ends, and keeps a bounded recent-completion ring.
- Uses the latest non-empty assistant text as final output.
- Captures provider errors and stop reasons.
- Bounds stderr tail.

### 14.4 Usage tests

- Sums every standard usage and cost field.
- Preserves and sums `cacheWrite1h` only when reported.
- Preserves and sums `reasoning` only when reported.
- Aggregates across turns and across parallel children.
- Returns aggregate usage at the top level of the final tool result.

### 14.5 Concurrency tests

- Never exceeds four running fake children in one call.
- Never exceeds four across two simultaneous calls.
- Starts queued work FIFO.
- Releases permits after success, spawn failure, parse failure, and cancellation.
- Keeps returned results in input order when completion order differs.

### 14.6 Cancellation tests

- Aborted queued work never spawns.
- Running work receives `SIGTERM` once.
- A child that exits during grace is not sent `SIGKILL`.
- A child still alive after five seconds receives `SIGKILL`.
- Abort listeners and timers are removed after close.
- The tool throws cancellation only after all cleanup completes.

Use fake child scripts/process adapters for deterministic tests; do not require API credentials or live model calls.

### 14.7 Output and failure tests

- Single success returns direct output.
- Parallel results include every role and preserve order.
- Unknown agents fail preflight before any spawn.
- Single child failure throws a bounded diagnostic.
- Mixed parallel results return partial successes with explicit failure labels.
- An all-failed parallel run throws a bounded aggregate error after every child settles.
- Cancellation does not return misleading partial success.
- Per-task and combined byte/line budgets are enforced.
- Stored details contain no unbounded transcript.

### 14.8 Rendering tests

- Single and parallel call headers are concise.
- Queued, running, succeeded, failed, and cancelled states render distinctly.
- Collapsed mode caps recent events.
- Expanded mode includes full bounded task/output and usage.
- Rendering handles missing optional fields without throwing.

### 14.9 Manual smoke tests

After unit tests and type-check pass:

1. Confirm the subagents draft exclusion has been removed, then run `./install.sh --dry pi` and verify only intended `~/.pi/agent/extensions/subagents/` files are targeted.
2. Confirm `@earendil-works/pi-radius` is installed and Radius authentication is configured.
3. Stow `pi` explicitly.
4. Start Pi and confirm the extension appears in the startup header.
5. Ask scout and reviewer for current web research; verify `radius_web_search` works and no other extension tool is available.
6. Ask for one scout task and verify live progress, final output, and `/session` usage totals.
7. Ask for four parallel scout/reviewer tasks and verify at most four child processes.
8. Start a long worker and press Escape; confirm all children exit and no temporary directories remain.
9. Run a child in print/JSON parent mode and confirm there is no UI dependency.
10. Temporarily give a role an invalid or parent-extension-only model and confirm the error is actionable and bounded.
11. Ask for an `advisor` consult with a prepared packet; confirm it uses Astra, does not search the tree, and that parent instructions name `context/advisor/`.

## 15. Implementation sequence

### Phase 1 — Scaffold and contracts

Remove the subagents draft exclusion from `pi/.stow-local-ignore`, then create the runtime files, package manifest, TypeScript config, test setup, README skeleton, shared result contracts, and three role files.

Exit criteria:

- `npm run typecheck` can resolve current Pi types.
- The agent schema and result-details version are fixed in tests.
- A Stow dry run includes the extension path rather than excluding it.

### Phase 2 — Agent discovery

Implement `discoverAgents()` with strict normalization, stable ordering, diagnostics, duplicate detection, approved-tool validation, symlink-aware file handling, and prompt parsing.

Exit criteria:

- All discovery tests pass.
- The three bundled agents load exactly as specified.

### Phase 3 — Child runner

Implement Pi executable resolution, command construction, temporary prompt handling, stdin task delivery, JSONL parsing with `StringDecoder`, bounded stderr, usage aggregation, result classification, output budgeting, and cleanup.

Exit criteria:

- Invocation, parser, usage, output, and spawn-failure tests pass against fake children.

### Phase 4 — Concurrency and cancellation

Add the extension-scoped FIFO semaphore and complete signal handling with TERM/KILL escalation.

Exit criteria:

- Global concurrency never exceeds four under stress tests.
- All cancellation and permit-leak tests pass.

### Phase 5 — Tool adapter

Register `subagent`, generate its strict `StringEnum` schema and role description, validate all tasks before launch, orchestrate runs, format model-visible results, return top-level usage, and apply the single-versus-parallel failure policy.

Exit criteria:

- Tool-level tests cover one task, four tasks, mixed failure, all failure, and cancellation.
- The public interface contains only `tasks[].agent` and `tasks[].task`.

### Phase 6 — Native rendering

Implement call rendering and compact/expanded result rendering from `SubagentDetails`, with throttled progress snapshots.

Exit criteria:

- Rendering tests pass.
- TUI output stays readable at narrow terminal widths.

### Phase 7 — Integration and documentation

Write the user README, run the complete automated suite, perform manual smoke tests, and verify the Stow target layout.

Exit criteria:

- Type-check and tests pass.
- Dry-run Stow output is correct.
- Single, parallel, abort, error, and headless smoke tests pass.
- README documents capabilities, limitations, role authoring, security, and `/reload`.

### Phase 8 — Advisor role

Add the bundled `advisor` role, parent Delegation instructions, and discovery-test updates. Details and locked choices live in `PLAN.md` Phase 8.

Exit criteria:

- `advisor.md` pins `openai-codex/gpt-6-astra`, thinking `high`, and tools `[read]`.
- Parent AGENTS.md sends high-value notes to `context/advisor/`, never `context/astra/`.
- Discovery tests load four bundled roles in filename order and assert pinned models.
- No `subagent` schema or runner changes.

## 16. Acceptance criteria

V1 is complete only when all of the following are true:

- [ ] Pi auto-discovers the extension from the stowed global path.
- [ ] The parent model sees exactly one new tool, `subagent`.
- [ ] The tool schema has only `tasks[].agent` and `tasks[].task`.
- [ ] The schema accepts one to four tasks, rejects additional properties, enforces task size limits, and uses `StringEnum` for roles.
- [ ] `advisor`, `scout`, `reviewer`, and `worker` load from Markdown files.
- [ ] `advisor` is pinned to `openai-codex/gpt-6-astra` with thinking `high` and tools `[read]` only.
- [ ] Parent Delegation instructions consult `advisor` only for high-value packets and save notes under `context/advisor/`, never `context/astra/`.
- [ ] Each role receives only its declared tools; custom tools are limited to `radius_web_search` for scout and reviewer.
- [ ] Children load no discovered extensions, skills, prompt templates, project settings, or persistent sessions; only the resolved Radius web-search extension is loaded when declared.
- [ ] Children retain repository context files.
- [ ] Role prompts are appended through secure temporary files.
- [ ] Task text is delivered through stdin.
- [ ] Parent model/thinking inheritance works as specified.
- [ ] Single and parallel runs stream bounded progress.
- [ ] No more than four children run globally.
- [ ] Escape/abort terminates queued and running work and leaves no leaked permits or temp files.
- [ ] Process launch never uses a shell.
- [ ] JSON parsing is Unicode-safe and chunk-safe.
- [ ] Results preserve input order.
- [ ] Single and all-failed parallel executions throw; mixed parallel failures preserve partial results and are unmistakably labeled.
- [ ] Combined output stays within 50 KiB and 2,000 lines.
- [ ] Full nested `Usage` is returned at the tool-result top level.
- [ ] Interactive rendering has useful collapsed and expanded views.
- [ ] Print and JSON parent modes work without UI calls.
- [ ] Automated tests and type-check pass.
- [ ] The subagents draft exclusion has been removed from `pi/.stow-local-ignore`.
- [ ] `./install.sh --dry pi` shows the intended target tree only.
- [ ] Missing Radius package/authentication errors are actionable, and scout/reviewer can successfully invoke `radius_web_search` when configured.
- [ ] Documentation states clearly that tool restrictions are not an OS sandbox.

## 17. Deferred evolution rules

Do not add a deferred feature merely because another reference supports it. Revisit scope only after v1 usage demonstrates a concrete problem.

Preferred order if expansion becomes necessary:

1. Project/user agent discovery with explicit trust and precedence.
2. Optional extension allowlists for custom tools.
3. Persistent foreground child sessions and explicit resume.
4. Background execution plus status and cancellation.
5. Worktree isolation.
6. Steering and richer observability.
7. Nested delegation, schedules, workflows, and memory only with strong evidence.

Each addition must either deepen the existing `subagent` tool without enlarging its interface materially or justify a new seam with at least two real adapters/use cases. Avoid compatibility fields until an actual released schema needs migration support.

## 18. Decisions locked for v1

- Extension folder: `subagents`; tool name: `subagent`.
- One task-array interface; no dual single/parallel shapes.
- Foreground only.
- Fresh context only.
- Parent cwd only.
- Extension-local agents only.
- Four roles: advisor, scout, reviewer, worker.
- `advisor` is read-only (`read` only), pinned to `openai-codex/gpt-6-astra` with thinking `high`, and is consulted only with a prepared evidence packet.
- High-value advisor notes are saved by the parent to `<repo-root>/context/advisor/`. Never `context/astra/`. The advisor does not write files.
- Built-in child tools plus the explicitly resolved `radius_web_search` tool for scout and reviewer only.
- No nested delegation or arbitrary extension loading.
- Parent model inheritance by default when a role does not pin a model and the model is independently available to the child CLI.
- Four globally concurrent children.
- Ephemeral child sessions.
- Context files enabled; project Pi resources declined.
- Task through stdin; role prompt through a `0600` temporary file.
- Full usage accounting.
- Bounded details and model-visible output.
- Single failure throws; parallel execution preserves partial value.

These defaults make the implementation small enough to audit while still solving the core job: delegate focused work into isolated Pi contexts and bring useful, observable results back.
