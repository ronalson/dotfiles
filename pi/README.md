# Pi

Global [Pi](https://github.com/earendil-works/pi-mono) configuration and extensions, stowed into `~/.pi/agent/`.

## Install

From the repository root:

```sh
./install.sh pi
```

## Extensions

Stow excludes `node_modules`. Local extensions in this package (`ask-now`, `exit.ts`) manage their own development dependencies.

Shareable extensions are installed with `pi install`:

```sh
pi install git:git@github.com:ronalson/pi-permission-gate@v0.4.0
pi install git:git@github.com:ronalson/pi-subagents@v0.1.0
```

## Verify

```sh
pi --list-models
```
