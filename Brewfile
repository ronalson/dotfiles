# Brewfile — declarative package manifest, applied with `brew bundle`
# (bootstrap.sh runs this automatically on a new machine)

# Adopt apps that already exist in /Applications (e.g. installed manually or
# copied by Migration Assistant) instead of failing. If a version mismatch
# still fails one, use: brew install --cask --force <name>
cask_args adopt: true

tap "atlassian/acli", trusted: true
tap "docker/tap", trusted: true
tap "nikitabobko/tap"

# --- CLI tools -------------------------------------------------------------
brew "azure-cli"
brew "dockutil"
brew "fnm"
brew "gh"
brew "stow"
brew "atlassian/acli/acli"

# --- Fonts -------------------------------------------------------------------
cask "font-fira-code"

# --- Apps --------------------------------------------------------------------
cask "nikitabobko/tap/aerospace"
cask "choosy"
cask "claude"
cask "cursor"
cask "docker-desktop"
cask "figma"
cask "firefox"
cask "google-chrome"
cask "karabiner-elements"
cask "postman"
cask "proxyman"
cask "raycast"
cask "ghostty"
cask "docker/tap/sbx"
cask "shottr"
cask "zed"

# NOTE: MDM-managed apps (Teams, Office, Defender, Company Portal) are
# intentionally excluded — company IT pushes those.
