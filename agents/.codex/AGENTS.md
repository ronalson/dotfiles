## Intent and Authorization

- Questions asking for an explanation, opinion, estimate, or recommendation are read-only. Answer them without changing files.
- A request to perform work is actionable even when phrased as a question, such as “Can you fix this?”
- When intent is unclear, assume the user is asking a question. Answer first and ask before making changes.
- Act after the user explicitly requests the change.

## Safety and Blast Radius

- Be careful with destructive or difficult-to-reverse actions.
- Never touch production or a live database unless explicitly instructed.
- Before touching production or a live database, state exactly what you are about to change.

## Coding Preferences

- Keep things simple. Apply YAGNI unless told otherwise.
- Use type safety where it provides value.
- Write tests for meaningful behavior and likely failure modes.
- Prefer focused tests related to the change. Do not add redundant tests merely to increase coverage.
- When intentionally removing a feature, remove tests that only cover the deleted behavior.
- Do not add tests whose sole purpose is to prove that an intentionally deleted feature remains deleted. Test remaining or replacement behavior only when it has independent value.
- Use comments to explain non-obvious behavior, constraints, and usage. Avoid comments that merely repeat the code.
- Keep comments and documentation focused on the current behavior. Do not leave comments describing what the code previously did or narrating the change; version control preserves that history.
- Preserve historical context only when it explains an enduring, non-obvious constraint or design decision.
- Keep comments synchronized with the implementation.

## Verification

- After code changes, run the relevant type-check and focused tests when available.
- Report any checks you could not run or any failures that remain.

## Delegation

- Do not use multiple agents for work a single agent can finish in one pass.
- Use fast, cost-efficient agents for bounded mechanical work.
- Use stronger reasoning agents for independent architectural or adversarial analysis.
- Delegate only when the work can proceed independently and delegation provides real value.

## Commits and Pull Requests

- Do not commit unless requested.
- When asked to commit, commit locally and do not push unless separately instructed.
- Do not amend an existing commit unless explicitly requested.
- If it is unclear whether a file belongs in the commit, ask.
- Commit subjects and pull request titles should follow the repository’s conventions and be easy to understand.
- In repositories using Conventional Commits, use forms such as `fix(web): prevent new threads from spiking CPU`.
- Commit bodies are optional. Include one when the motivation or important tradeoffs are not clear from the subject and diff.
- Do not open a pull request unless explicitly requested.
- Keep pull request descriptions simple: briefly describe the problem, then explain how it was solved.
