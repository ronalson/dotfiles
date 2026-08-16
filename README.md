# dotfiles

Personal macOS configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Packages

| Package | Description | Target |
|---------|-------------|--------|
| `agents` | Shared global instructions for Codex, Pi, and Claude | `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/.claude/CLAUDE.md` |
| `aerospace` | [AeroSpace](https://github.com/nikitabobko/AeroSpace) tiling window manager | `~/.config/aerospace/` |
| `git` | Git config, global ignore | `~/.gitconfig`, `~/.gitignore_global`, `~/.config/git/` |
| `ghostty` | [Ghostty](https://ghostty.org/) terminal emulator | `~/.config/ghostty/` |
| `karabiner` | [Karabiner-Elements](https://karabiner-elements.pqrs.org/) key remapping via [GokuRakuJo](https://github.com/yqrashawn/GokuRakuJo) | `~/.config/karabiner/` |
| `zed` | [Zed](https://zed.dev/) code editor | `~/.config/zed/` |
| `zsh-personal` | ZSH config (personal machine) | `~/.zshrc` |
| `zsh-work` | ZSH config (work machine) | `~/.zshrc` |

Beyond stow packages, the repo also carries:

- `Brewfile` — every CLI tool, app, font (`brew bundle`)
- `Brewfile.work` — work-only extras (Rider, DBeaver); applied only by
  `./bootstrap.sh work`
- `macos/` — system preferences (`defaults.sh`) and Dock layout (`dock.sh`)
- `bootstrap.sh` — one-shot new-machine setup
- `MIGRATION.md` — manual checklist for what automation can't cover (keys, auth, licenses)

## New machine setup

```bash
git clone https://github.com/ronalson/dotfiles ~/Code/dotfiles
cd ~/Code/dotfiles
./bootstrap.sh work       # or: ./bootstrap.sh personal
```

Both profiles run: Homebrew → Brewfile → stow → oh-my-zsh → Node (fnm) → macOS
defaults + Dock. The `work` profile additionally installs Rosetta 2 and
`Brewfile.work`, and stows `zsh-work` instead of `zsh-personal`.

Then follow [MIGRATION.md](MIGRATION.md) for the manual steps.

## Prerequisites (stow-only setup)

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
./install.sh agents
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
│   └── .config/aerospace/
│       ├── aerospace.toml                   → ~/.config/aerospace/aerospace.toml
│       └── toggle-split.sh                  → ~/.config/aerospace/toggle-split.sh
├── karabiner/
│   └── .config/
│       ├── karabiner.edn                    → ~/.config/karabiner.edn (GokuRakuJo source)
│       └── karabiner/karabiner.json         → ~/.config/karabiner/karabiner.json
├── ghostty/
│   └── .config/ghostty/config.ghostty       → ~/.config/ghostty/config.ghostty
├── zed/
│   └── .config/zed/{settings,keymap}.json   → ~/.config/zed/
└── zsh-personal/
    └── .zshrc                               → ~/.zshrc
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

## Karabiner key mappings

The `karabiner.edn` file is the [GokuRakuJo](https://github.com/yqrashawn/GokuRakuJo) source. Running `goku` compiles it into `karabiner.json`. Karabiner also rewrites its JSON on every UI settings change — since the file is symlinked, changes appear directly in the repo.

| Trigger | Action |
|---------|--------|
| Caps Lock (held) | Activates hyper-mode layer |
| Caps Lock (tap) | Escape |
| Hyper + `h` `j` `k` `l` | Arrow keys (vim-style) |
| Hyper + `=` | Fn+F12 |

**Home-row chords** (minimal, typing-safe):

| Left hand | Right hand | Modifier |
|-----------|------------|----------|
| `f+d` | `j+k` | Option |
| `f+s` | `j+l` | Option+Shift |

Notes:
- Single-key home-row mod-tap mappings were removed due repeat/drop issues under fast rolling typing in Karabiner.
- These are explicit simultaneous chords only; normal home-row letters remain untouched.
- Chords send original letters if chorded keys are released without being used as modifiers.

## ZSH profiles

Only one `zsh-*` package should be stowed at a time since they both target `~/.zshrc`:

```bash
# Switch from personal to work
./install.sh --delete zsh-personal
./install.sh zsh-work
```
