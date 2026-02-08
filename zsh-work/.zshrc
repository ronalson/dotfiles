# Uncomment these lines to measure startup time
# zmodload zsh/zprof  # Add at the very top of .zshrc
# Path to your oh-my-zsh installation
export ZSH="$HOME/.oh-my-zsh"

# Theme
ZSH_THEME="robbyrussell"

# CRITICAL PERFORMANCE SETTINGS
# Skip the verification of insecure directories (massive speedup)
export ZSH_DISABLE_COMPFIX=true

# Only check for updates manually (not on every startup)
export DISABLE_AUTO_UPDATE=true

# Plugins (consider removing zsh-syntax-highlighting if still slow)
plugins=(git z zsh-autosuggestions zsh-syntax-highlighting)

# Add completions to fpath BEFORE oh-my-zsh loads
fpath+=${ZSH_CUSTOM:-${ZSH:-~/.oh-my-zsh}/custom}/plugins/zsh-completions/src

# Load Oh My Zsh
source $ZSH/oh-my-zsh.sh

# Speed up compinit by checking cache only once a day
autoload -Uz compinit
if [[ -n ${ZDOTDIR}/.zcompdump(#qNmh+24) ]]; then
  compinit -C  # Skip security check if dump exists and is less than 24 hours old
else
  compinit
fi

# Compile completion dump for faster loading
if [[ -s "$HOME/.zcompdump" && (! -s "$HOME/.zcompdump.zwc" || "$HOME/.zcompdump" -nt "$HOME/.zcompdump.zwc") ]]; then
  zcompile "$HOME/.zcompdump"
fi

# Disable yarn aliases
zstyle ':omz:plugins:yarn' aliases no

# ============================================================================
# PATH Configuration (consolidated and optimized)
# ============================================================================

# Build PATH more efficiently using a single export
typeset -U path  # Ensure unique paths

# Add all custom paths at once
path=(
    "$HOME/.local/bin"
    $path
)

export PATH

# ============================================================================
# fnm (Fast Node Manager)
# ============================================================================

# fnm - Node version manager with auto-switching based on .nvmrc files
# Adds ~20ms to startup but Node is immediately available (no lazy-load delay)
eval "$(fnm env --use-on-cd)"

# ============================================================================
# Zed as default editor
# ============================================================================

export EDITOR='zed -w'

# ============================================================================
# Aliases
# ============================================================================

alias n=npm
alias python=python3
alias pip=pip3
alias cc=claude
alias cch='claude --model haiku'
alias ccs='claude --model sonnet'
alias cco='claude --model opus'

# ============================================================================
# Secrets (API tokens, credentials, etc.)
# ============================================================================

if [[ -f "$HOME/.secrets" ]]; then
  source "$HOME/.secrets"
fi

# ============================================================================
# Node Version in RPROMPT (optimized with hooks)
# Updates on `cd` and after `fnm` commands.
# ============================================================================

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

## PERFORMANCE PROFILING
## Uncomment these lines to measure startup time
# zprof  # Add at the very bottom of .zshrc
