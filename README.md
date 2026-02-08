# dotfiles

Personal macOS configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Packages

| Package | Description | Target |
|---------|-------------|--------|
| `aerospace` | [AeroSpace](https://github.com/nikitabobko/AeroSpace) tiling window manager | `~/.config/aerospace/` |
| `karabiner` | [Karabiner-Elements](https://karabiner-elements.pqrs.org/) key remapping | `~/.config/karabiner/` |
| `zsh-personal` | ZSH config (personal machine) | `~/.zshrc` |
| `zsh-work` | ZSH config (work machine) | `~/.zshrc` |

## Prerequisites

- [Homebrew](https://brew.sh/)
- [GNU Stow](https://formulae.brew.sh/formula/stow) (`brew install stow`)

## Setup

```bash
# 1. Clone this repo
git clone <repo-url> ~/Code/dotfiles
cd ~/Code/dotfiles

# 2. Run the installer (stows all packages)
./install.sh
```

### Stow a specific package

```bash
./install.sh aerospace
./install.sh zsh-personal   # or zsh-work
```

### Preview changes without applying

```bash
./install.sh --dry
```

### Remove symlinks

```bash
./install.sh --delete
./install.sh --delete aerospace   # specific package
```

## How it works

Each top-level directory is a stow package. The internal structure mirrors `$HOME`:

```
dotfiles/
├── aerospace/
│   └── .config/aerospace/aerospace.toml   → ~/.config/aerospace/aerospace.toml
├── karabiner/
│   └── .config/karabiner/karabiner.json   → ~/.config/karabiner/karabiner.json
└── zsh-personal/
    └── .zshrc                             → ~/.zshrc
```

Stow runs with `--no-folding`, creating file-level symlinks. This keeps directories like `~/.config/karabiner/` intact while only symlinking the files we version.

## Adding a new config

```bash
# 1. Create the package directory mirroring the home path
mkdir -p new-package/.config/app/

# 2. Copy the config in
cp ~/.config/app/config.toml new-package/.config/app/

# 3. Stow it (--adopt replaces the original file with a symlink)
stow --no-folding --adopt --target=$HOME new-package

# 4. Commit
git add new-package/ && git commit -m "Add new-package config"
```

## ZSH profiles

Only one `zsh-*` package should be stowed at a time since they both target `~/.zshrc`:

```bash
# Switch from personal to work
./install.sh --delete zsh-personal
./install.sh zsh-work
```
