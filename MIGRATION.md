# Migration Checklist (new machine)

## Automated

```bash
# 1. Sign into iCloud, let MDM enrollment finish (Teams/Office/Defender arrive by themselves)
# 2. Then:
git clone https://github.com/ronalson/dotfiles ~/Code/dotfiles
cd ~/Code/dotfiles && ./bootstrap.sh
```

`bootstrap.sh` handles: Homebrew + all apps/CLIs (Brewfile), dotfile symlinks
(stow, work profile), oh-my-zsh + plugins, Node via fnm, macOS defaults, and
the Dock layout.

## Manual steps

### Auth & keys
- [ ] Generate a new SSH key and add it to GitHub:
  ```bash
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed_work -C "{EMAIL}"
  gh auth login   # also authenticates git over HTTPS
  gh ssh-key add ~/.ssh/id_ed_work.pub --title "work-macbook-$(date +%Y)"
  ```
- [ ] Recreate `~/.secrets` (sourced by `.zshrc`; never committed — copy values
  from vault or the old machine)
- [ ] Create `~/.gitconfig.local` (included by the tracked `.gitconfig`; holds
  identity and machine-specific includes, never committed):
  ```ini
  [user]
      name = Ronalson Filho
      email = <email>

  ; optional — chronogit aliases; requires cloning repo.
  ;[include]
  ;    path = ~/Code/<repo_path>/.gitconfig
  ```
- [ ] Sign in: Docker Desktop, Claude, Cursor, Figma, Postman

### App settings
- [ ] **Raycast** — on the old machine: `Raycast Settings → Advanced → Export`;
  import the `.rayconfig` on the new one
- [ ] **Browsers** — sign into Firefox/Chrome profiles (sync restores the rest)
- [ ] **Licenses** — Proxyman (retrieve from email/Proton Pass)
- [ ] **Shottr** — license + screenshot preferences

### Permissions (macOS will prompt on first launch)
- [ ] Karabiner-Elements — driver extension + input monitoring
- [ ] AeroSpace — accessibility
- [ ] Raycast, Shottr — screen recording / accessibility

### Optional
- [ ] [Goku](https://github.com/yqrashawn/GokuRakuJo) — only needed to
  regenerate `karabiner.json` from `karabiner.edn`:
  `brew install yqrashawn/goku/goku`
- [ ] Re-run `./macos/dock.sh` after MDM installs Teams/Edge so they get pinned
