# Pi subagents

A small foreground-only Pi extension for delegating focused work to isolated child Pi processes.

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the authentication flow and cite the relevant files." },
  ],
})
```

Pass multiple independent tasks to run them concurrently:

```ts
subagent({
  tasks: [
    { agent: "scout", task: "Map the persistence layer." },
    { agent: "reviewer", task: "Review API error handling." },
  ],
})
```

Subagents receive no parent conversation transcript. Every task must include all context needed to complete it. Use direct Pi tools for simple reads and shell commands; delegate independent exploration, review, reasoning, or a narrow implementation slice.

## Installation

From the dotfiles repository root:

```sh
(cd pi/.pi/agent/extensions/subagents && npm install)
./install.sh pi
```

Pi discovers the extension at `~/.pi/agent/extensions/subagents/index.ts`. Restart Pi after installation, or run `/reload` after changing the extension or a role file.

The read-only roles declare Radius web search. Install and authenticate the Radius package before using either role:

```sh
pi install npm:@earendil-works/pi-radius
```

Then run `/login radius` in Pi. `radius_web_search` works with other model providers selected, but still requires Radius authentication and is a slow, paid external request.

## Roles

| Role | Tools | Model | Purpose |
| --- | --- | --- | --- |
| `advisor` | `read` | `openai-codex/gpt-6-astra`, thinking `high` | Independent consult for a difficult decision, architectural trade-off, or consequential review |
| `scout` | `read`, `grep`, `find`, `ls`, `radius_web_search` | `openrouter/z-ai/glm-5.3-flash` | Fast reconnaissance and compressed handoff context |
| `reviewer` | `read`, `grep`, `find`, `ls`, `radius_web_search` | `openai-codex/gpt-5.6-sol` | Read-only correctness, test, security, and maintainability review |
| `worker` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` | `xai/grok-4.6`, thinking `high` | Narrow implementation work with verification |

Scout and reviewer use web search only when a task explicitly requests web research or requires current external information. The reviewer intentionally cannot run shell commands. Give it exact files or a diff location to inspect.

The worker can modify the current repository. Its task should define a narrow scope and the checks it should run.

The advisor answers a prepared question from supplied evidence. It can only read files or ranges named in the packet. Do not use it for routine implementation, debugging, search, or checks. Send a self-contained packet: the precise question, outcome, constraints, options or review scope, excerpts with paths and line numbers, and known unknowns. After a high-value consult, the parent saves notes under `<repo-root>/context/advisor/`, never `context/astra/`.

## Execution behavior

- Each task starts a fresh, ephemeral child Pi process in the parent's working directory.
- Children do not inherit the parent conversation.
- One call accepts one to four tasks.
- Results remain in input order even when tasks finish in a different order.
- A process-wide FIFO limit permits at most four live children across simultaneous tool calls.
- Pressing Escape aborts queued and running children. Running children receive `SIGTERM`, followed by `SIGKILL` after five seconds if needed.
- Children load no discovered extensions, skills, prompt templates, project settings, or persistent sessions.
- Scout and reviewer explicitly load only the installed Radius web-search extension.
- Repository context files such as `AGENTS.md` remain enabled.
- Roles inherit the parent model by default. They inherit parent thinking with that model unless they pin thinking; a pinned model without pinned thinking uses Pi's default for that model.
- Child token and cost usage is included in the parent session totals.
- Combined model-visible output is limited to 50 KiB and 2,000 lines.

A model registered only by a parent extension is unavailable to children because extension discovery is disabled. Use a model independently available to the Pi CLI.

## Authoring roles

Role files live in `agents/*.md` and are loaded in filename order during extension initialization:

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

Rules:

- `name`, `description`, `tools`, and a non-empty prompt body are required.
- Names must match `^[a-z][a-z0-9-]*$` and must be unique.
- Tools may be a YAML array or comma-separated string.
- Allowed built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`.
- `radius_web_search` is the only custom tool and is restricted to the bundled `scout` and `reviewer` roles.
- `thinking` may be `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- Invalid or unreadable files are skipped with a path-specific warning.

V1 discovers only this extension's role directory. It does not load project-local roles or role-supplied extension paths.

## Security and limitations

Tool restrictions narrow what Pi presents to a role; they are not an operating-system sandbox. The extension and every child process retain the invoking user's filesystem, process, network, and credential permissions. In particular, `worker` has `bash` and can perform any action available to the user.

Repository context and source files can contain prompt injection. Project Pi resources are declined, but context files load independently of project trust. Run the parent Pi inside a container, VM, or other OS sandbox when working with untrusted repositories or unattended mutation tasks.

V1 is foreground-only. It has no background jobs, polling, resume, steering, persistent child sessions, nested delegation, chains, schedules, worktrees, memory, or arbitrary extension loading.

## Development

```sh
npm run typecheck
npm test
```

Tests use fake child processes and recorded JSONL events, so they require no model credentials.
