#!/usr/bin/env bash
# ===========================================================================
# Dotfiles Installer (GNU Stow)
# ===========================================================================
# Symlinks dotfile packages from this repo into $HOME using GNU Stow.
#
# Usage:
#   ./install.sh              # Stow all packages
#   ./install.sh --dry        # Simulate (no changes)
#   ./install.sh --delete     # Unstow all packages
#   ./install.sh aerospace    # Stow specific package(s)
# ===========================================================================

set -euo pipefail

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"

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

# --- Parse flags -----------------------------------------------------------
STOW_FLAGS=("--no-folding" "--target=$HOME" "--dir=$DOTFILES_DIR")
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
        -*)
            echo "Unknown flag: $1"
            exit 1
            ;;
        *)
            break
            ;;
    esac
done

# --- Discover packages -----------------------------------------------------
# Packages are top-level directories that aren't excluded by .stow-local-ignore.
# If specific packages were passed as arguments, use those instead.
if [[ $# -gt 0 ]]; then
    PACKAGES=("$@")
else
    PACKAGES=()
    for dir in "$DOTFILES_DIR"/*/; do
        pkg="$(basename "$dir")"
        # Skip non-package directories
        case "$pkg" in
            docs) continue ;;
        esac
        PACKAGES+=("$pkg")
    done
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
    stow "${STOW_FLAGS[@]}" "$pkg"
done

echo ""
echo "Done."
