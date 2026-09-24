#!/usr/bin/env bash
# ===========================================================================
# Setup Verification
# ===========================================================================
# Reports where this machine differs from the repo. Read-only: it prints the
# command that fixes each problem but never runs it.
#
# Usage:
#   ./verify.sh                  # profile detected from the ~/.zshrc symlink
#   ./verify.sh <work|personal>
#
# Exits 1 when any check fails. Warnings (updates available, apps missing
# from the Brewfile, uncommitted changes) don't affect the exit code.
# ===========================================================================

set -uo pipefail   # no -e: run every check instead of stopping at the first failure

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DOTFILES_DIR/packages.sh"

FAILURES=0
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }
pass()    { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn()    { printf "  \033[33m!\033[0m %s\n" "$1"; }
fail()    { printf "  \033[31m✗\033[0m %s\n" "$1"; FAILURES=$((FAILURES + 1)); }
hint()    { printf "      → %s\n" "$1"; }
detail()  { printf "      %s\n" "$1"; }

# --- Profile ----------------------------------------------------------------
PROFILE="${1:-$(current_profile)}"
case "$PROFILE" in
    work|personal) ;;
    *)
        echo "Couldn't detect the profile from ~/.zshrc."
        echo "Usage: ./verify.sh <work|personal>"
        exit 2
        ;;
esac
PACKAGES=($(profile_packages "$PROFILE"))
echo "Verifying the '$PROFILE' profile"

# --- Repository -------------------------------------------------------------
# Catches changes pushed from another machine that haven't been pulled here.
section "Repository"
if ! git -C "$DOTFILES_DIR" rev-parse --abbrev-ref '@{upstream}' &>/dev/null; then
    warn "Current branch has no upstream; skipped the comparison"
elif ! git -C "$DOTFILES_DIR" fetch --quiet 2>/dev/null; then
    warn "Couldn't fetch from the remote; skipped the comparison"
else
    read -r behind ahead <<< "$(git -C "$DOTFILES_DIR" rev-list --left-right --count '@{upstream}...HEAD')"
    if (( behind > 0 )); then
        fail "$behind commit(s) behind upstream"
        hint "git pull, then run ./verify.sh again"
    else
        pass "Up to date with upstream"
    fi
    (( ahead > 0 )) && warn "$ahead local commit(s) not pushed"
fi
changes="$(git -C "$DOTFILES_DIR" status --porcelain)"
if [[ -n "$changes" ]]; then
    warn "Uncommitted changes"
    while IFS= read -r line; do detail "$line"; done <<< "$changes"
fi

# --- Symlinks ---------------------------------------------------------------
# A stow dry run prints nothing when every file of a package is already linked.
section "Symlinks"
if ! command -v stow &>/dev/null; then
    fail "GNU Stow is not installed"
    hint "brew install stow"
else
    for pkg in "${PACKAGES[@]}"; do
        out="$(stow $(stow_flags "$pkg") --simulate --verbose --dir="$DOTFILES_DIR" --target="$HOME" "$pkg" 2>&1 \
            | grep -v 'in simulation mode')"
        if [[ -z "$out" ]]; then
            pass "$pkg"
            continue
        fi
        fail "$pkg"
        conflict=0
        while IFS= read -r line; do
            case "$line" in
                LINK:*)
                    detail "not linked: ~/$(sed -E 's/^LINK: ([^ ]+) =>.*/\1/' <<< "$line")" ;;
                *"over existing target"*)
                    detail "real file in the way: ~/$(sed -E 's/.*over existing target ([^ ]+) since.*/\1/' <<< "$line")"
                    conflict=1 ;;
                *"stowed to a different package"*)
                    detail "linked from another package: ~/$(sed -E 's/.*package: (.*)/\1/' <<< "$line")"
                    conflict=1 ;;
                MKDIR:*|WARNING!*|"All operations aborted.") ;;
                *)
                    detail "${line#"${line%%[![:space:]]*}"}"
                    conflict=1 ;;
            esac
        done <<< "$out"
        if (( conflict )); then
            hint "resolve the conflicts above, then: ./install.sh $pkg"
        else
            hint "./install.sh $pkg"
        fi
    done
fi

# --- Homebrew ---------------------------------------------------------------
section "Homebrew"
export HOMEBREW_NO_AUTO_UPDATE=1
brewfiles=("$DOTFILES_DIR/Brewfile")
[[ "$PROFILE" == work ]] && brewfiles+=("$DOTFILES_DIR/Brewfile.work")

brewfile_entries() { for f in "${brewfiles[@]}"; do brew bundle list "$1" --file="$f"; done | sort -u; }
# brew list prints names without the tap prefix (aerospace, not nikitabobko/tap/aerospace)
strip_tap() { sed 's|.*/||' | sort -u; }

wanted_taps="$(brewfile_entries --tap)"
wanted_formulae="$(brewfile_entries --formula)"
wanted_casks="$(brewfile_entries --cask)"
wanted_names="$(printf "%s\n%s\n" "$wanted_formulae" "$wanted_casks" | strip_tap)"
installed_taps="$(brew tap)"
installed_formulae="$(brew list --formula -1 | strip_tap)"
installed_casks="$(brew list --cask -1 | strip_tap)"

brew_problems=0
for tap in $wanted_taps; do
    grep -qxF "$tap" <<< "$installed_taps" && continue
    fail "tap $tap is missing"
    hint "brew tap $tap"
    brew_problems=$((brew_problems + 1))
done
for formula in $wanted_formulae; do
    grep -qxF "${formula##*/}" <<< "$installed_formulae" && continue
    fail "$formula is not installed"
    hint "brew install $formula"
    brew_problems=$((brew_problems + 1))
done
for cask in $wanted_casks; do
    grep -qxF "${cask##*/}" <<< "$installed_casks" && continue
    app="$(brew info --cask "$cask" 2>/dev/null | sed -n 's/ (App)$//p' | head -1)"
    if [[ -n "$app" && -d "/Applications/$app" ]]; then
        fail "$cask: /Applications/$app is installed, but not through Homebrew"
        hint "brew install --cask --adopt $cask"
    else
        fail "$cask is not installed"
        hint "brew install --cask $cask"
    fi
    brew_problems=$((brew_problems + 1))
done
(( brew_problems == 0 )) && pass "Everything in the Brewfile is installed"

# Formulae and casks get separate hints: a bare name can resolve to the wrong
# kind (codexbar is a cask here, but steipete/tap also has a codexbar formula).
outdated_formulae=""
for name in $(brew outdated --formula --quiet); do
    grep -qxF "${name##*/}" <<< "$wanted_names" && outdated_formulae+=" $name"
done
outdated_casks=""
for name in $(brew outdated --cask --quiet); do
    grep -qxF "${name##*/}" <<< "$wanted_names" && outdated_casks+=" $name"
done
if [[ -n "$outdated_formulae$outdated_casks" ]]; then
    warn "Updates available:$outdated_formulae$outdated_casks"
    [[ -n "$outdated_formulae" ]] && hint "brew upgrade --formula$outdated_formulae"
    [[ -n "$outdated_casks" ]] && hint "brew upgrade --cask$outdated_casks"
fi

# Installed by hand on this machine and never added to a Brewfile.
# Brewfile.ignore lists the ones deliberately left out.
ignored_names="$(grep -v '^#' "$DOTFILES_DIR/Brewfile.ignore" 2>/dev/null)"
untracked=""
for name in $(brew leaves --installed-on-request | strip_tap) $installed_casks; do
    grep -qxF "$name" <<< "$wanted_names"$'\n'"$ignored_names" || untracked+=" $name"
done
if [[ -n "$untracked" ]]; then
    warn "Installed but not in a Brewfile:$untracked"
    hint "add them to Brewfile or Brewfile.work, list them in Brewfile.ignore, or uninstall them"
fi

# --- Shell ------------------------------------------------------------------
section "Shell"
if [[ -d "$HOME/.oh-my-zsh" ]]; then
    pass "oh-my-zsh"
else
    fail "oh-my-zsh is not installed"
    hint "see step 5 in bootstrap.sh"
fi
ZSH_CUSTOM="${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}"
for plugin in zsh-autosuggestions zsh-syntax-highlighting zsh-completions; do
    if [[ -d "$ZSH_CUSTOM/plugins/$plugin" ]]; then
        pass "$plugin"
    else
        fail "$plugin is not installed"
        hint "git clone --depth=1 https://github.com/zsh-users/$plugin $ZSH_CUSTOM/plugins/$plugin"
    fi
done
if node_version="$(fnm default 2>/dev/null)" && [[ -n "$node_version" ]]; then
    pass "Node $node_version (fnm default)"
else
    fail "fnm has no default Node version"
    hint "fnm install --lts && fnm default lts-latest"
fi

# --- macOS defaults ---------------------------------------------------------
section "macOS defaults"
defaults_problems=0
while read -r domain key type value; do
    [[ -z "$domain" || "$domain" == \#* ]] && continue
    expected="$value"
    # defaults read prints booleans as 1/0
    if [[ "$type" == bool ]]; then
        [[ "$value" == true ]] && expected=1 || expected=0
    fi
    actual="$(defaults read "$domain" "$key" 2>/dev/null || echo "<unset>")"
    if [[ "$actual" != "$expected" ]]; then
        fail "$domain $key is $actual, expected $value"
        defaults_problems=$((defaults_problems + 1))
    fi
done < "$DOTFILES_DIR/macos/defaults.list"
if (( defaults_problems == 0 )); then
    pass "All values in macos/defaults.list are applied"
else
    hint "./macos/defaults.sh"
fi

# --- Machine-specific setup (MIGRATION.md) ----------------------------------
section "Machine-specific setup"
if grep -q '\.secrets' "$HOME/.zshrc" 2>/dev/null; then
    [[ -f "$HOME/.secrets" ]] && pass "~/.secrets" || { fail "~/.secrets is missing (sourced by ~/.zshrc)"; hint "see MIGRATION.md"; }
fi
if [[ -f "$HOME/.gitconfig.local" ]] && git config --global --includes user.email &>/dev/null; then
    pass "~/.gitconfig.local sets the git identity"
else
    fail "~/.gitconfig.local is missing or doesn't set user.email"
    hint "see MIGRATION.md"
fi
if compgen -G "$HOME/.ssh/id_*.pub" >/dev/null; then
    pass "SSH key"
else
    fail "No SSH key in ~/.ssh"
    hint "see MIGRATION.md"
fi
if gh auth status &>/dev/null; then
    pass "GitHub CLI is authenticated"
else
    fail "GitHub CLI is not authenticated"
    hint "gh auth login"
fi

# --- Summary ----------------------------------------------------------------
echo ""
if (( FAILURES == 0 )); then
    echo "This machine matches the repo."
else
    echo "$FAILURES problem(s) found. Nothing was changed."
    exit 1
fi
