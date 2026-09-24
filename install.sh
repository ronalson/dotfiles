#!/usr/bin/env bash
# ===========================================================================
# Dotfiles Installer (GNU Stow)
# ===========================================================================
# Symlinks dotfile packages from this repo into $HOME using GNU Stow.
#
# Usage:
#   ./install.sh aerospace git          # Stow specific package(s)
#   ./install.sh --dry aerospace        # Simulate (no changes)
#   ./install.sh --delete aerospace     # Unstow package(s)
#
# Packages must be named: stowing everything would link both zsh profiles
# and packages a machine doesn't use. Run with no arguments to see this
# machine's list from packages.sh.
# ===========================================================================

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DOTFILES_DIR/packages.sh"

usage() {
    local profile all=""
    profile="$(current_profile)"
    for dir in "$DOTFILES_DIR"/*/; do
        case "$(basename "$dir")" in
            docs|macos) ;;  # not stow packages
            *) all+=" $(basename "$dir")" ;;
        esac
    done

    echo "Usage: ./install.sh [--dry] [--delete] [--verbose] <package>..."
    echo ""
    if [[ -n "$profile" ]]; then
        echo "This machine uses the '$profile' profile. To stow its packages (from packages.sh):"
        echo "  ./install.sh $(profile_packages "$profile")"
    else
        echo "~/.zshrc isn't stowed yet, so the profile is unknown. Packages per profile (from packages.sh):"
        echo "  work:     $(profile_packages work)"
        echo "  personal: $(profile_packages personal)"
    fi
    echo ""
    echo "All packages in the repo:"
    echo " $all"
}

# --- Parse flags -----------------------------------------------------------
# --no-folding is added per package (see stow_flags in packages.sh)
STOW_FLAGS=("--target=$HOME" "--dir=$DOTFILES_DIR")
ACTION="stow"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry|--dry-run|--simulate)
            STOW_FLAGS+=("--simulate" "--verbose")
            shift
            ;;
        --delete|--unstow)
            ACTION="unstow"
            STOW_FLAGS+=("-D")
            shift
            ;;
        --verbose|-v)
            STOW_FLAGS+=("--verbose")
            shift
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        -*)
            echo "Unknown flag: $1"
            echo ""
            usage
            exit 1
            ;;
        *)
            break
            ;;
    esac
done

# --- Require package names -------------------------------------------------
if [[ $# -eq 0 ]]; then
    echo "No packages given, so nothing was changed."
    echo "Name the packages to stow or unstow. Stowing every package would link both"
    echo "zsh profiles, which conflict, and packages this machine doesn't use."
    echo ""
    usage
    exit 1
fi
PACKAGES=("$@")

# --- Ensure stow is available ----------------------------------------------
if ! command -v stow &>/dev/null; then
    echo "GNU Stow not found. Installing via Homebrew..."
    if command -v brew &>/dev/null; then
        brew install stow
    else
        echo "Error: Homebrew not found. Install stow manually: https://www.gnu.org/software/stow/"
        exit 1
    fi
fi

# --- Run stow --------------------------------------------------------------
if [[ "$ACTION" == "unstow" ]]; then
    echo "Unstowing packages from $HOME..."
else
    echo "Stowing packages to $HOME..."
fi

for pkg in "${PACKAGES[@]}"; do
    if [[ ! -d "$DOTFILES_DIR/$pkg" ]]; then
        echo "  [SKIP] Package not found: $pkg"
        continue
    fi
    echo "  -> $pkg"
    stow "${STOW_FLAGS[@]}" $(stow_flags "$pkg") "$pkg"
done

echo ""
echo "Done."
