## Intent and Authorization

- Questions asking for an explanation, opinion, estimate, or recommendation are read-only. Answer them without changing files.
- A request to perform work is actionable even when phrased as a question, such as “Can you fix this?”
- When intent is unclear, assume the user is asking a question. Answer first and ask before making changes.
- Once the user requests work, carry it through implementation and appropriate verification. Make routine decisions within scope without asking again. Ask when ambiguity materially affects the outcome or requires expanding scope.

## Safety and Blast Radius

- Be careful with destructive or difficult-to-reverse actions.
- Never access production or a live database unless explicitly instructed.
- Before modifying production or a live database, state exactly what you are about to change.

## Coding Preferences

- Keep things simple. Apply YAGNI unless told otherwise.
- Use type safety where it provides value.

## Tests

- Add tests for meaningful behavior and likely failure modes. Avoid tests that merely mirror the implementation or add redundant coverage.
- Do not add tests for reversible, low-impact changes unless they address a meaningful risk.
- Remove obsolete tests when deleting features. Do not add tests merely to assert their absence.

## Comments and Documentation

- Keep comments and documentation accurate and focused on current behavior.
- Explain non-obvious behavior, constraints, and decisions. Avoid comments that merely repeat the code.
- Retain history only when it explains a current constraint or decision.

## Writing Style

- Lead with the main point. Use clear, concise paragraphs, each developing one idea.
- Use plain language, concrete examples, and active voice. Include technical details when they help the reader understand the result or reasoning.
- Use lists for steps or parallel information. Avoid unnecessary nesting.
- State actions and findings directly. Avoid filler, canned conclusions, rhetorical questions, and unsolicited contrasts.
- Avoid jargon and invented compound labels. Prefer familiar words and precise verbs.

## Verification

- Run checks appropriate to the change and complete required checks.
- Fix failures caused by your changes and rerun affected checks.
- Once checks pass, broaden or repeat verification only when new changes, failures, or unresolved concerns justify it.
- Report checks you could not run and failures that remain.

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
- Commit bodies are optional. Include one when the motivation or important tradeoffs are not clear from the subject and diff.
- Do not open a pull request unless explicitly requested.
- Keep pull request descriptions simple: briefly describe the problem, then explain how it was solved.
