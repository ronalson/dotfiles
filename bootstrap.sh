#!/usr/bin/env bash
# ===========================================================================
# New Machine Bootstrap
# ===========================================================================
# One-shot setup for a fresh macOS machine. Idempotent — safe to re-run.
#
#   git clone https://github.com/ronalson/dotfiles ~/Code/dotfiles
#   cd ~/Code/dotfiles && ./bootstrap.sh <work|personal>
#
# work:     Brewfile.work + Rosetta 2 + zsh-work + Node via fnm
# personal: Brewfile.personal + zsh-personal + Node via Vite+
#
# Manual steps (auth, keys, licenses) are listed in MIGRATION.md.
# ===========================================================================

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"

info() { printf "\n\033[1;34m==> %s\033[0m\n" "$1"; }

# --- Profile ------------------------------------------------------------------
PROFILE="${1:-}"
if [[ "$PROFILE" != "work" && "$PROFILE" != "personal" ]]; then
    echo "Usage: ./bootstrap.sh <work|personal>"
    exit 1
fi
info "Bootstrapping with the '$PROFILE' profile"

# --- 1. Homebrew -------------------------------------------------------------
if ! command -v brew &>/dev/null; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)"

# --- 2. Rosetta 2 (needed by some work x86 tools) --------------------------------
if [[ "$PROFILE" == "work" && "$(uname -m)" == "arm64" ]] && ! /usr/bin/pgrep -q oahd; then
    info "Installing Rosetta 2..."
    softwareupdate --install-rosetta --agree-to-license
fi

# --- 3. Packages & apps --------------------------------------------------------
info "Installing Brewfile.$PROFILE packages..."
brew bundle --file="$DOTFILES_DIR/Brewfile.$PROFILE"

# --- 4. Dotfiles (package list per profile lives in packages.sh) ------------------
info "Stowing dotfiles..."
source "$DOTFILES_DIR/packages.sh"
"$DOTFILES_DIR/install.sh" $(profile_packages "$PROFILE")

# Scan staged changes for secrets before each commit (betterleaks)
git -C "$DOTFILES_DIR" config core.hooksPath .githooks

# --- 5. oh-my-zsh + custom plugins ---------------------------------------------
if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
    info "Installing oh-my-zsh..."
    RUNZSH=no KEEP_ZSHRC=yes sh -c \
        "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
fi

ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
for plugin in zsh-autosuggestions zsh-syntax-highlighting zsh-completions; do
    if [[ ! -d "$ZSH_CUSTOM/plugins/$plugin" ]]; then
        info "Installing zsh plugin: $plugin"
        git clone --depth=1 "https://github.com/zsh-users/$plugin" "$ZSH_CUSTOM/plugins/$plugin"
    fi
done

# --- 6. Node --------------------------------------------------------------------
if [[ "$PROFILE" == "work" ]]; then
    info "Installing Node via fnm..."
    eval "$(fnm env)"
    fnm install --lts
    fnm default lts-latest
else
    # Vite+ manages Node, npm, pnpm and Yarn; bun stays on its own installer.
    # Re-running the installer upgrades in place. It finds the env source line
    # already in the stowed ~/.zshrc and leaves that file alone, but adds one to
    # ~/.zshenv for GUI apps. With no pinned default, Node is the latest LTS.
    info "Installing Node via Vite+..."
    curl -fsSL https://vite.plus |
        VP_NODE_MANAGER=yes VP_PM_MANAGER=yes VP_BUN_MANAGER=no bash
fi

# --- 7. macOS preferences + Dock --------------------------------------------------
info "Applying macOS defaults..."
"$DOTFILES_DIR/macos/defaults.sh"
"$DOTFILES_DIR/macos/dock.sh"

info "Bootstrap complete!"
echo "Next: work through the manual checklist in MIGRATION.md"
echo "(SSH key, gh auth, Raycast import, licenses, ~/.secrets),"
echo "then run ./verify.sh to confirm the machine matches the repo."
