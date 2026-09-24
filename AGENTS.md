## About

macOS dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/), organized as stow packages that symlink into `$HOME`.

## Key Commands

- `./install.sh <package>...` — stow the named packages (no arguments: changes nothing, prints this machine's package list)
- `./install.sh --dry <package>...` — preview without changes
- `./install.sh --delete <package>...` — remove symlinks
- `stow --no-folding --adopt --target=$HOME <package>` — first-time stow when target file already exists
- `./verify.sh [work|personal]` — read-only report of drift between this machine and the repo

## Conventions

- **Top level packages** `<package>` each top-level dir is a stow package
- **Stow packages** use `--no-folding` (file-level symlinks, not directory-level), so directories like `~/.config/zed/` can hold unversioned content alongside versioned files. The one exception is `karabiner`, which `stow_flags` in `packages.sh` stows as a directory link (see Karabiner below).
- **Adding a new config**: create `<package>/.config/app/file`, copy the original in, run `stow --no-folding --adopt --target=$HOME <package>`, then commit.
- **CRITICAL: no secrets in the repo.** See `.gitignore` for exclusion patterns. Never commit API keys, tokens, `.env` files, or `~/.claude.json`.
- **Profile package lists** live in `packages.sh`. When adding a package, add it to each profile that should get it; `bootstrap.sh` stows and `verify.sh` checks only the listed packages.
- **macOS defaults** live in `macos/defaults.list`, which both `macos/defaults.sh` and `verify.sh` read.
- **ZSH profiles** are mutually exclusive packages (`zsh-personal`, `zsh-work`). Only one should be stowed at a time — they both target `~/.zshrc`.
- **Commit messages** do not include AI co-author attribution.
- **Karabiner** only detects config changes when the whole `~/.config/karabiner` directory is a symlink; a symlinked `karabiner.json` gets replaced by a regular file on the next UI save. So `~/.config/karabiner` links to `karabiner/.config/karabiner/`, and Karabiner's `automatic_backups/` and `assets/` land in the repo (gitignored). It rewrites `karabiner.json` on every settings change — check `git diff` after modifying Karabiner settings.
- **App bundle IDs** for AeroSpace `on-window-detected` rules can be found with `mdls -name kMDItemCFBundleIdentifier -r /Applications/<App>.app`.
