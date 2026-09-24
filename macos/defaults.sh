#!/usr/bin/env bash
# ===========================================================================
# macOS system preferences
# ===========================================================================
# Applies the values in defaults.list. Re-run anytime; idempotent.

set -euo pipefail

echo "Applying macOS defaults..."

while read -r domain key type value; do
    [[ -z "$domain" || "$domain" == \#* ]] && continue
    defaults write "$domain" "$key" "-$type" "$value"
done < "$(dirname "$0")/defaults.list"

killall Dock 2>/dev/null || true

echo "Done. Some settings need logout/restart to take effect."
