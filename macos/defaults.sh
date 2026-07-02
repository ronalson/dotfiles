#!/usr/bin/env bash
# ===========================================================================
# macOS system preferences
# ===========================================================================
# Values captured from the previous machine. Re-run anytime; idempotent.

set -euo pipefail

echo "Applying macOS defaults..."

# --- Dock -------------------------------------------------------------------
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock orientation -string "left"
defaults write com.apple.dock tilesize -int 21
defaults write com.apple.dock magnification -bool true
defaults write com.apple.dock largesize -int 67
defaults write com.apple.dock show-recents -bool false

# --- Keyboard -----------------------------------------------------------------
# Fast key repeat (lower = faster)
defaults write -g KeyRepeat -int 5
defaults write -g InitialKeyRepeat -int 25

# --- Scroll & pointer -----------------------------------------------------------
# Disable "natural" scrolling
defaults write -g com.apple.swipescrolldirection -bool false
# Mouse tracking speed
defaults write -g com.apple.mouse.scaling -float 2

killall Dock 2>/dev/null || true

echo "Done. Some settings need logout/restart to take effect."
