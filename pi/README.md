# Pi

Global [Pi](https://github.com/earendil-works/pi-mono) configuration and extensions, stowed into `~/.pi/agent/`.

## Install

From the repository root:

```sh
./install.sh pi
```

## Extensions

Stow excludes `node_modules`. Extensions kept in this repository manage their own development dependencies, while packages installed with `pi install` manage runtime dependencies through Pi.

## Verify

```sh
pi --list-models
```
