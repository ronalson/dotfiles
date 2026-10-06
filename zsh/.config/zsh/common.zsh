# Shared zsh setup, sourced by both profiles' ~/.zshrc (zsh-personal, zsh-work).
# It loads oh-my-zsh, so a profile sets anything OMZ reads (DISABLE_AUTO_UPDATE,
# extra completion dirs on fpath) before sourcing this file, and adds its own
# PATH entries and tools after it.

export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git z zsh-autosuggestions zsh-syntax-highlighting)

# Skip OMZ's check for group/world-writable completion dirs. It runs on every
# startup and only matters on multi-user machines.
export ZSH_DISABLE_COMPFIX=true

# OMZ runs the only compinit; don't add a second one, it doubles the cost.
source "$ZSH/oh-my-zsh.sh"

export EDITOR="zed --wait"
export VISUAL="$EDITOR"

alias python=python3
alias pip=pip3

typeset -U path
path=("$HOME/.local/bin" $path)
export PATH

# Node version in RPROMPT, shown only in a directory with package.json.
# precmd runs before every prompt, which also covers `cd` and version switches.
typeset -g NODE_RPROMPT=""

__update_node_rprompt() {
  # Do nothing if ZLE isn't active (e.g. zsh -i -c exit benchmarks)
  [[ -o zle ]] || return

  if [[ -f "$PWD/package.json" ]]; then
    local v
    v="$(command node -v 2>/dev/null)" || v=""
    NODE_RPROMPT="${v:+v${v#v}}"
  else
    NODE_RPROMPT=""
  fi
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __update_node_rprompt

setopt prompt_subst
RPROMPT='${NODE_RPROMPT}'
