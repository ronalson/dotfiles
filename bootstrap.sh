#!/usr/bin/env bash
# ===========================================================================
# New Machine Bootstrap
# ===========================================================================
# One-shot setup for a fresh macOS machine. Idempotent — safe to re-run.
#
#   git clone https://github.com/ronalson/dotfiles ~/Code/dotfiles
#   cd ~/Code/dotfiles && ./bootstrap.sh <work|personal>
#
# work:     Brewfile + Brewfile.work (Rider, DBeaver) + Rosetta 2 + zsh-work
# personal: Brewfile only + zsh-personal
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
info "Installing Brewfile packages..."
brew bundle --file="$DOTFILES_DIR/Brewfile"

if [[ "$PROFILE" == "work" ]]; then
    info "Installing work-only packages (Brewfile.work)..."
    brew bundle --file="$DOTFILES_DIR/Brewfile.work"
fi

# --- 4. Dotfiles (zsh profile matches machine; no wezterm) ----------------------
info "Stowing dotfiles..."
"$DOTFILES_DIR/install.sh" aerospace git karabiner rio zed "zsh-$PROFILE"

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

# --- 6. Node (fnm) ----------------------------------------------------------------
info "Installing Node via fnm..."
eval "$(fnm env)"
fnm install --lts
fnm default lts-latest

# --- 7. macOS preferences + Dock --------------------------------------------------
info "Applying macOS defaults..."
"$DOTFILES_DIR/macos/defaults.sh"
"$DOTFILES_DIR/macos/dock.sh"

info "Bootstrap complete!"
echo "Next: work through the manual checklist in MIGRATION.md"
echo "(SSH key, gh auth, Raycast import, licenses, ~/.secrets)"
