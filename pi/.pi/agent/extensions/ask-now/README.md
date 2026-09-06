# Ask Now

A global Pi extension that lets the model ask one blocking clarification or decision question through Pi's native UI.

The `ask_now` tool accepts a question and, optionally, two to five mutually exclusive choices. Without choices it opens a single-line input dialog. With choices it opens a selection dialog and adds `Other (type an answer)` for custom text. Tool calls run sequentially so sibling calls cannot open overlapping dialogs.

Answers are returned in the tool result and therefore become part of the session and are visible to the model. Do not use this tool to request passwords, tokens, private keys, or other secrets. Text answers larger than 16 KiB are rejected rather than truncated or recorded.

## Modes and cancellation

- TUI and RPC modes use Pi's native `select` and `input` dialogs.
- Escape or a blank answer returns an explicit no-answer result.
- Aborting the agent turn dismisses the dialog and returns an abort-specific result.
- Print and JSON modes return immediately and tell the model to ask in a normal assistant response.

The extension stores no settings, answer queue, or other state outside Pi's normal tool call and result entries.

## Install

From the dotfiles repository:

```sh
./install.sh --dry pi
./install.sh pi
```

Reload an active Pi session with `/reload`. Pi supplies all runtime packages, so loading the extension does not require `npm install`.

## Development

Node 22.19 or newer is required. Install test-only dependencies and run the checks from the repository copy:

```sh
cd pi/.pi/agent/extensions/ask-now
npm ci
npm run check
```

For a direct smoke test:

```sh
pi -e "$PWD/index.ts"
```

Check free text, a listed choice, Other, Escape, agent-turn abort, RPC dialogs, and print or JSON no-UI behavior.
