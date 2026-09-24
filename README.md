# dotfiles

Personal macOS configuration managed with [GNU Stow](https://www.gnu.org/software/stow/).

## Packages

| Package | Description | Target |
|---------|-------------|--------|
| `agents` | Global agent instructions: one file shared by Codex and Pi, a separate one for Claude | `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/.claude/CLAUDE.md` |
| `claude` | [Claude Code](https://claude.com/claude-code) status line script | `~/.claude/statusline.sh` |
| `aerospace` | [AeroSpace](https://github.com/nikitabobko/AeroSpace) tiling window manager | `~/.config/aerospace/` |
| `git` | Git config, global ignore | `~/.gitconfig`, `~/.gitignore_global`, `~/.config/git/` |
| `ghostty` | [Ghostty](https://ghostty.org/) terminal emulator | `~/.config/ghostty/` |
| `herdr` | [Herdr](https://herdr.dev/) terminal workspace manager for coding agents | `~/.config/herdr/` |
| `karabiner` | [Karabiner-Elements](https://karabiner-elements.pqrs.org/) key remapping via [GokuRakuJo](https://github.com/yqrashawn/GokuRakuJo) | `~/.config/karabiner/` |
| `zed` | [Zed](https://zed.dev/) code editor | `~/.config/zed/` |
| `zsh-personal` | ZSH config (personal machine) | `~/.zshrc` |
| `zsh-work` | ZSH config (work machine) | `~/.zshrc` |

Beyond stow packages, the repo also carries:

- `Brewfile` — every CLI tool, app, font (`brew bundle`)
- `Brewfile.work` — work-only extras (Rider, DBeaver); applied only by
  `./bootstrap.sh work`
- `Brewfile.ignore` — Homebrew packages deliberately left unmanaged, so
  `verify.sh` doesn't report them as untracked
- `macos/` — system preferences (`defaults.sh`) and Dock layout (`dock.sh`)
- `bootstrap.sh` — one-shot new-machine setup
- `packages.sh` — the stow packages each profile uses (read by `bootstrap.sh`
  and `verify.sh`)
- `verify.sh` — read-only report of where this machine differs from the repo
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

## Checking a machine

```bash
./verify.sh              # profile detected from the ~/.zshrc symlink
./verify.sh personal     # or name it explicitly
```

Run it after pulling changes made on another machine. It reports, without
changing anything:

- commits on the remote that haven't been pulled, and uncommitted changes
- files from the profile's packages (`packages.sh`) that aren't symlinked, or
  that a real file is blocking
- Brewfile entries that aren't installed, or whose app exists in
  `/Applications` but isn't managed by Homebrew
- Homebrew packages installed here but missing from the Brewfiles, and
  available updates (warnings only)
- oh-my-zsh and its plugins, the fnm default Node version
- macOS preferences that differ from `macos/defaults.list`
- the machine-specific files and auth from MIGRATION.md

Each problem comes with the command that fixes it. It exits 1 when any check
fails.

## Prerequisites (stow-only setup)

- [Homebrew](https://brew.sh/)
- [GNU Stow](https://formulae.brew.sh/formula/stow) (`brew install stow`)

## Setup

```bash
# 1. Clone this repo
git clone <repo-url> ~/Code/dotfiles
cd ~/Code/dotfiles

# 2. Print this machine's package list, then run the command it shows
./install.sh
```

`install.sh` only stows the packages you name. Run with no arguments, it
changes nothing and prints the package list for this machine's profile (from
`packages.sh`) plus every package in the repo. Stowing everything would link
both zsh profiles, which conflict, and packages a machine doesn't use.

### Stow a specific package

```bash
./install.sh agents
./install.sh aerospace
./install.sh zsh-personal   # or zsh-work
```

### Preview changes without applying

```bash
./install.sh --dry aerospace
```

### Remove symlinks

```bash
./install.sh --delete aerospace
```

## How it works

Each top-level directory is a stow package. The internal structure mirrors `$HOME`:

```
dotfiles/
├── aerospace/
│   └── .config/aerospace/
│       ├── aerospace.toml                   → ~/.config/aerospace/aerospace.toml
│       └── toggle-split.sh                  → ~/.config/aerospace/toggle-split.sh
├── claude/
│   └── .claude/statusline.sh                → ~/.claude/statusline.sh
├── karabiner/
│   └── .config/
│       ├── karabiner.edn                    → ~/.config/karabiner.edn (GokuRakuJo source)
│       └── karabiner/                       → ~/.config/karabiner/ (whole directory)
├── ghostty/
│   └── .config/ghostty/config.ghostty       → ~/.config/ghostty/config.ghostty
├── herdr/
│   └── .config/herdr/config.toml            → ~/.config/herdr/config.toml
├── zed/
│   └── .config/zed/{settings,keymap}.json   → ~/.config/zed/
└── zsh-personal/
    └── .zshrc                               → ~/.zshrc
```

Stow runs with `--no-folding`, creating file-level symlinks. This keeps directories like `~/.config/zed/` intact while only symlinking the files we version.

The exception is `karabiner`: Karabiner only notices config changes when the whole `~/.config/karabiner` directory is a symlink, and it replaces a symlinked `karabiner.json` with a regular file when it saves. That package is stowed without `--no-folding` (see `stow_flags` in `packages.sh`), and Karabiner's `automatic_backups/` and `assets/` are gitignored inside it.

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

The `karabiner.edn` file is the [GokuRakuJo](https://github.com/yqrashawn/GokuRakuJo) source. Running `goku` compiles it into `karabiner.json`. Karabiner also rewrites its JSON on every UI settings change — since `~/.config/karabiner` links into the repo, changes appear directly in `git diff`.

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

## Claude Code status line

`claude/.claude/statusline.sh` renders a two-line status line from the JSON that Claude Code sends on stdin. It needs `jq`, `git`, and a [Nerd Font](https://www.nerdfonts.com/) for the pie icons.

`~/.claude/settings.json` is not versioned, so on a new machine add the entry by hand:

```json
"statusLine": {
  "type": "command",
  "command": "bash ~/.claude/statusline.sh"
}
```

Line 1 example:

```
Opus 5.5 [medium] | [==--------] 50k/200k (25%) | 󰪟 13% (4h30m) | ✗ main (+42, -10)
```

Each segment is dropped when its input field is missing, and `|` separators appear only between segments that are shown.

| Segment | Source | Rules |
|---------|--------|-------|
| Model | `.model.display_name` | Bold cyan |
| Effort | `.effort.level` | Blue, in brackets |
| Context | `.context_window.used_percentage`, `.context_window.context_window_size` | See below |
| 5h limit | `.rate_limits.five_hour.used_percentage`, `.rate_limits.five_hour.resets_at` | See below |
| Git | `git` in `.workspace.current_dir` | See below |

**Context.** A 10-slot bar where each `=` is 10% of the window, rounded down (9% shows no `=`). Tokens used are `used_percentage × context_window_size`, shown as `k`/`M`. The bar, count, and percentage are colored by absolute tokens used, so the colors mean the same thing across window sizes:

| Tokens used | Color |
|-------------|-------|
| under 30k | grey |
| 30k – 120k | green |
| 120k – 360k | yellow |
| 360k – 600k | orange |
| over 600k | red |

Without `context_window_size`, only the uncolored bar and percentage are shown.

**5h limit.** A pie icon (`nf-md-circle_slice_1`–`_8`, U+F0A9E–U+F0AA5) fills in eighths, rounded up; 0% still shows one slice. The countdown to `resets_at` (epoch seconds or ISO 8601) shows as `XhYm`. The whole segment is colored by usage:

| 5h usage | Color |
|----------|-------|
| under 50% | green |
| 50% – 74% | yellow |
| 75% – 89% | orange |
| 90% and up | red |

**Git.** Hidden outside a repo. A green `✓` means a clean tree; a red `✗` means any change, including untracked files. The branch is magenta. `(+N, -N)` counts staged and unstaged line changes against `HEAD` (untracked files are not counted), with `+` green and `-` red, and is hidden when both are zero.

Line 2 is a single black `·` that separates the status line from Claude Code's mode indicator. Claude Code trims blank lines, so the line needs visible content.

## ZSH profiles

Only one `zsh-*` package should be stowed at a time since they both target `~/.zshrc`:

```bash
# Switch from personal to work
./install.sh --delete zsh-personal
./install.sh zsh-work
```
