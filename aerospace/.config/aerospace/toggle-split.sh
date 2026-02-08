#!/usr/bin/env bash
# Toggle between balanced (50/50) and 2/3 + 1/3 layout.
# The focused window gets the 2/3 portion.
# Works across monitors of different sizes and tracks state per workspace.

STATE_DIR="/tmp/aerospace-split"
mkdir -p "$STATE_DIR"

WORKSPACE=$(aerospace list-workspaces --focused)
STATE_FILE="$STATE_DIR/$WORKSPACE"

if [[ -f "$STATE_FILE" ]]; then
  aerospace balance-sizes
  rm "$STATE_FILE"
else
  # Get logical width of the focused monitor
  WIDTH=$(osascript -l JavaScript -e '
    ObjC.import("AppKit");
    $.NSScreen.mainScreen.frame.size.width;
  ')
  # Delta from 1/2 to 2/3 = width/6, minus gaps (inner gap split between windows)
  DELTA=$(python3 -c "print(int(${WIDTH} / 6))")
  aerospace balance-sizes
  aerospace resize width +"$DELTA"
  touch "$STATE_FILE"
fi
