# Pi

Global [Pi](https://github.com/earendil-works/pi-mono) configuration and extensions, stowed into `~/.pi/agent/`.

## Install

From the repository root:

```sh
./install.sh pi
```

If `~/.pi/agent/settings.json` already exists as a regular file, move it aside first; stow won't replace it.

## Settings

`settings.json` holds the enabled models and the installed packages. Pi rewrites some fields, such as `lastChangelogVersion`, through the link, so check `git diff` after a Pi update.

The permission gate package stays installed with `"extensions": []`, so normal Pi sessions don't load it. `agent-role` (in the `agents` package) loads it explicitly from `~/.pi/agent/git/github.com/ronalson/pi-permission-gate/index.ts`. Don't `pi remove` it: that deletes the checkout `agent-role` needs.

To install the packages `settings.json` lists on a new machine:

```sh
pi update --extensions
```

## Extensions

Stow excludes `node_modules`. Local extensions in this package (`ask-now`, `exit.ts`) manage their own development dependencies.

## Verify

```sh
pi --list-models   # prints no "No models match" warnings
```
