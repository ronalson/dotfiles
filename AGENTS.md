## About

macOS dotfiles managed with [GNU Stow](https://www.gnu.org/software/stow/), organized as stow packages that symlink into `$HOME`.

## Key Commands

- `./install.sh` — stow all packages
- `./install.sh <package>` — stow specific package
- `./install.sh --dry` — preview without changes
- `./install.sh --delete [package]` — remove symlinks
- `stow --no-folding --adopt --target=$HOME <package>` — first-time stow when target file already exists

## Conventions

- **Top level packages** `<package>` each top-level dir is a stow package
- **Stow packages** use `--no-folding` (file-level symlinks, not directory-level). This is critical for directories like `~/.config/karabiner/` that contain unversioned content alongside versioned files.
- **Adding a new config**: create `<package>/.config/app/file`, copy the original in, run `stow --no-folding --adopt --target=$HOME <package>`, then commit.
- **CRITICAL: no secrets in the repo.** See `.gitignore` for exclusion patterns. Never commit API keys, tokens, `.env` files, or `~/.claude.json`.
- **ZSH profiles** are mutually exclusive packages (`zsh-personal`, `zsh-work`). Only one should be stowed at a time — they both target `~/.zshrc`.
- **Commit messages** do not include AI co-author attribution.
- **Karabiner** rewrites its JSON on every settings change via the UI. Since the file is symlinked, changes appear directly in the repo — check `git diff` after modifying Karabiner settings.
- **App bundle IDs** for AeroSpace `on-window-detected` rules can be found with `mdls -name kMDItemCFBundleIdentifier -r /Applications/<App>.app`.
