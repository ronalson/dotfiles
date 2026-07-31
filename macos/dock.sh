#!/usr/bin/env bash
# ===========================================================================
# Dock layout (via dockutil)
# ===========================================================================
# Rebuilds the pinned-apps section of the Dock. Apps not yet installed
# (e.g. MDM-managed ones) are skipped with a warning — re-run later.

set -euo pipefail

if ! command -v dockutil &>/dev/null; then
    echo "Error: dockutil not found. Install it first: brew install dockutil"
    exit 1
fi

APPS=(
    "/System/Applications/Calendar.app"
    "/System/Applications/System Settings.app"
    "/System/Applications/Apps.app"
    "/Applications/Microsoft Teams.app"
    "/Applications/Firefox.app"
    "/Applications/Microsoft Edge.app"
    "/Applications/Google Chrome.app"
    "/Applications/Claude.app"
    "/Applications/Ghostty.app"
    "/Applications/Cursor.app"
    "/Applications/Zed.app"
    "/Applications/Postman.app"
)

echo "Rebuilding Dock..."
dockutil --remove all --no-restart >/dev/null

for app in "${APPS[@]}"; do
    if [[ -d "$app" ]]; then
        dockutil --add "$app" --no-restart >/dev/null
        echo "  [ADD]  $(basename "$app")"
    else
        echo "  [SKIP] $(basename "$app") — not installed"
    fi
done

killall Dock
echo "Done."
