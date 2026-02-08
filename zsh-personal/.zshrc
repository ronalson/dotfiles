# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="robbyrussell"

# Plugins
plugins=(git z zsh-autosuggestions zsh-syntax-highlighting)

source $ZSH/oh-my-zsh.sh

# -----------------------------
# User configuration
# -----------------------------

# Set Zed as default editor
export EDITOR="zed"
export VISUAL="zed"

alias n=pnpm
alias python=python3
alias pip=pip3
alias oc=opencode

# fnm (Node version manager)
if [[ -z "${FNM_MULTISHELL_PATH:-}" ]]; then
  eval "$(fnm env --use-on-cd)"
fi

# pnpm
export PNPM_HOME="$HOME/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end

# Lazy-load Docker Desktop config to enable Docker CLI completions (no compinit here; OMZ handles it)
if [[ -d "$HOME/.docker/completions" ]]; then
  fpath=("$HOME/.docker/completions" $fpath)
fi

# opencode
OPENCODE_BIN="$HOME/.opencode/bin"
case ":$PATH:" in
  *":$OPENCODE_BIN:"*) ;;
  *) export PATH="$OPENCODE_BIN:$PATH" ;;
esac

# -----------------------------
# Node version in RPROMPT (root-only, no cache)
# Updates on `cd` and after `fnm` commands.
# -----------------------------

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
add-zsh-hook chpwd __update_node_rprompt
add-zsh-hook precmd __update_node_rprompt

# Wrap fnm so prompt updates immediately after version changes
if command -v fnm >/dev/null 2>&1; then
  fnm() {
    command fnm "$@"
    __update_node_rprompt
    zle -I 2>/dev/null
  }
fi

setopt prompt_subst
RPROMPT='${NODE_RPROMPT}'

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
