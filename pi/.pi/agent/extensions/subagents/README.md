# Pi subagents

One tool, `subagent`, delegates work to isolated child Pi processes. Children get a fresh conversation and only the tools their role allows. Pass one task, or up to four independent tasks to run concurrently.

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the authentication flow and cite the relevant files." },
  ],
})
```

Every task must include the context the child needs. Use direct Pi tools for simple reads and shell commands.

## Installation

From the dotfiles repository root:

```sh
(cd pi/.pi/agent/extensions/subagents && npm install)
./install.sh pi
```

Restart Pi, or `/reload` after changing the extension or a role file.

Every child loads permission-gate `v0.4.0` explicitly. Install it before delegating:

```sh
pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0
```

Scout and reviewer need Radius web search:

```sh
pi install npm:@earendil-works/pi-radius
```

Then `/login radius`. Search is slow, paid, and requires that login even when another model is selected.

## Roles

| Role | Tools | Model | Purpose |
| --- | --- | --- | --- |
| `advisor` | `read` | `openai-codex/gpt-6-astra`, thinking `high` | Difficult decision, architectural trade-off, or consequential review |
| `scout` | `read`, `grep`, `find`, `ls`, `radius_web_search` | `openrouter/z-ai/glm-5.3-flash` | Reconnaissance and compressed handoff context |
| `reviewer` | `read`, `grep`, `find`, `ls`, `radius_web_search` | `openai-codex/gpt-5.6-sol` | Read-only correctness, test, security, and maintainability review |
| `worker` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | `xai/grok-4.6`, thinking `high` | Narrow implementation with verification |

`radius_web_search` is allowed only on scout and reviewer, and only when the task needs current external information.

Advisor answers a prepared packet; it must not survey the repo. Do not use it for routine work. After a high-value consult, the parent saves notes under `<repo-root>/context/advisor/`, never `context/astra/`. Reviewer has no shell. Worker can modify the repo.

## Behavior

- Children run in the parent working directory with no session, no discovered extensions, skills, or prompt templates, and no project Pi settings. Repository context files still load. Children cannot load this extension.
- Every child is started with `--no-extensions --extension <permission-gate/index.ts>`. Scout and reviewer add a second `--extension` for Radius. Extension discovery stays off.
- Permission-gate still allows routine workspace `write`/`edit` and ordinary test commands. In JSON/headless children there is no approval UI, so confirmation-required actions such as ordinary `rm` are blocked with `confirmation_unavailable`. Deny rules still block. Valid block metadata is spoofable display telemetry only; it is never authorization, replay, or proof of enforcement.
- Supported `read` and `bash` results are redacted for common secrets. `grep`, `find`, `ls`, Radius, and other custom tools stay unguarded and unredacted.
- At most four live children at once. Results stay in input order. Escape aborts queued and running children.
- A role without `model` inherits the parent model. It inherits parent thinking only with that model; a pinned model without `thinking` uses Pi's default for that model. The child CLI must already know the model.
- Child usage is included in parent totals. Combined model-visible output is capped at 50 KiB and 2,000 lines.

## Authoring roles

Files in `agents/*.md` only; no project-local role directories. Loaded in filename order.

```md
---
name: example
description: Short purpose shown to the parent model
tools: [read, grep, find, ls]
# model: provider/model-id
# thinking: high
---

Instructions for the role.
```

`name`, `description`, `tools`, and a non-empty body are required. Names match `^[a-z][a-z0-9-]*$`. Allowed tools are the Pi built-ins plus `radius_web_search` for scout and reviewer. Invalid files are skipped with a warning.

## Security

Tool allowlists and permission-gate are heuristic guardrails, not a sandbox. Children run with the user's full permissions. `worker` has `bash`. The gate currently inspects `bash`, `read`, `write`, and `edit` only; unsupported tools are not blocked or redacted through this integration. Allowed programs still run as the user. Interpreters and nested processes can bypass heuristic recognition, and context files can contain prompt injection. Sandbox the parent Pi for untrusted repos or unattended mutation.

## Development

Default checks do not require an installed permission-gate:

```sh
npm run check
```

The actual-Pi released-gate suite needs the installed v0.4.0 pin:

```sh
pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0
npm run check:integration
```

During development, integration can instead load a worktree gate while still requiring that package's name and exact `0.4.0` version:

```sh
PERMISSION_GATE_INTEGRATION_PATH=/path/to/pi-permission-gate/index.ts npm run test:integration
```
