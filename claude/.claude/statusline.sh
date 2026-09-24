#!/bin/bash
# Claude Code statusLine script.
# Format: <model> [<effort>] | [bar] <used>/<size> (<pct>%) | <pie icon> <pct>% (<reset>) | <✓|✗> <branch> (+<ins>, -<del>)
# Segments are omitted when their source field is absent from the JSON input.

input=$(cat)

GREEN=$'\e[32m' RED=$'\e[31m' MAGENTA=$'\e[35m' RESET=$'\e[0m'
YELLOW=$'\e[33m' ORANGE=$'\e[38;5;208m' GREY=$'\e[90m' BLUE=$'\e[34m' BOLD_CYAN=$'\e[1;36m'

IFS=$'\x1f' read -r model effort cwd ctx_pct ctx_size rate_5h reset_at < <(
  echo "$input" | jq -r '[
    (.model.display_name // ""),
    (.effort.level // ""),
    (.workspace.current_dir // .cwd // ""),
    (.context_window.used_percentage // ""),
    (.context_window.context_window_size // ""),
    (.rate_limits.five_hour.used_percentage // ""),
    # resets_at may be epoch seconds or an ISO 8601 string; normalize to epoch.
    (.rate_limits.five_hour.resets_at // "" |
      if type == "number" then floor
      elif . == "" then ""
      else (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | try fromdateiso8601 catch "")
      end)
  ] | map(tostring) | join("\u001f")'
)

# 1234 -> 1k, 200000 -> 200k, 1000000 -> 1M
fmt_tokens() {
  awk -v n="$1" 'BEGIN {
    if (n >= 1000000) printf "%gM", int(n / 100000) / 10
    else if (n >= 1000) printf "%dk", n / 1000
    else printf "%d", n
  }'
}

parts=()

head="${BOLD_CYAN}${model}${RESET}"
[ -n "$effort" ] && head="$head ${BLUE}[$effort]${RESET}"
parts+=("$head")

if [ -n "$ctx_pct" ]; then
  pct=$(printf '%.0f' "$ctx_pct")
  width=10
  filled=$(( pct * width / 100 ))
  (( filled > width )) && filled=$width
  bar=$(printf '%*s' "$filled" '' | tr ' ' '=')$(printf '%*s' "$(( width - filled ))" '' | tr ' ' '-')
  if [ -n "$ctx_size" ]; then
    used=$(awk -v p="$ctx_pct" -v s="$ctx_size" 'BEGIN { printf "%d", p * s / 100 }')
    # Color by absolute tokens used, not percentage, so it reads the same across window sizes.
    if   (( used < 30000 ));  then color=$GREY
    elif (( used <= 120000 )); then color=$GREEN
    elif (( used <= 360000 )); then color=$YELLOW
    elif (( used <= 600000 )); then color=$ORANGE
    else color=$RED
    fi
    parts+=("${color}[$bar] $(fmt_tokens "$used")/$(fmt_tokens "$ctx_size") ($pct%)${RESET}")
  else
    parts+=("[$bar] ($pct%)")
  fi
fi

if [ -n "$rate_5h" ]; then
  rate_pct=$(printf '%.0f' "$rate_5h")
  # Pie icon fills in eighths: nf-md-circle_slice_1 (U+F0A9E) through _8 (U+F0AA5).
  slices=(󰪞 󰪟 󰪠 󰪡 󰪢 󰪣 󰪤 󰪥)
  slice=$(( (rate_pct * 8 + 99) / 100 ))
  (( slice < 1 )) && slice=1
  (( slice > 8 )) && slice=8
  if   (( rate_pct < 50 )); then color=$GREEN
  elif (( rate_pct < 75 )); then color=$YELLOW
  elif (( rate_pct < 90 )); then color=$ORANGE
  else color=$RED
  fi
  rate="${slices[slice - 1]} $rate_pct%"
  if [ -n "$reset_at" ]; then
    left=$(( reset_at - $(date +%s) ))
    (( left < 0 )) && left=0
    rate="$rate ($(( left / 3600 ))h$(( left % 3600 / 60 ))m)"
  fi
  parts+=("${color}${rate}${RESET}")
fi

if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  if [ -n "$branch" ]; then
    if [ -z "$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)" ]; then
      git_part="${GREEN}✓${RESET} ${MAGENTA}${branch}${RESET}"
    else
      git_part="${RED}✗${RESET} ${MAGENTA}${branch}${RESET}"
    fi
    # Staged + unstaged line changes against HEAD; untracked files are not counted.
    read -r ins del < <(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null |
      awk '{ i += $1; d += $2 } END { printf "%d %d", i, d }')
    (( ins + del > 0 )) && git_part="$git_part (${GREEN}+$ins${RESET}, ${RED}-$del${RESET})"
    parts+=("$git_part")
  fi
fi

output=""
for p in "${parts[@]}"; do
  output="${output:+$output | }$p"
done

echo "$output"
# Spacer line before Claude Code's mode indicator. A blank line gets trimmed,
# so print a black dot that is nearly invisible on a dark background.
printf '\e[30m·\e[0m\n'
