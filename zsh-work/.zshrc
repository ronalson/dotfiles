# Uncomment these lines to measure startup time
# zmodload zsh/zprof  # Add at the very top of .zshrc

# Work machine. Shared setup (oh-my-zsh, editor, prompt) lives in
# ~/.config/zsh/common.zsh, from the zsh package.

# Only check for oh-my-zsh updates manually (not on every startup)
export DISABLE_AUTO_UPDATE=true

# Completion dirs must join fpath BEFORE oh-my-zsh loads, because OMZ runs the
# only compinit.
fpath+=${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/zsh-completions/src

source "$HOME/.config/zsh/common.zsh"

# ============================================================================
# Vite+ bin (https://viteplus.dev)
# ============================================================================

# Sourced before fnm below so fnm's shim dir is prepended last and wins on
# PATH — otherwise Vite+'s bundled node shadows whatever fnm switches to.
[[ -f "$HOME/.vite-plus/env" ]] && . "$HOME/.vite-plus/env"

# ============================================================================
# fnm (Fast Node Manager)
# ============================================================================

# fnm - Node version manager with auto-switching based on .nvmrc files
# Adds ~20ms to startup but Node is immediately available (no lazy-load delay)
eval "$(fnm env --use-on-cd)"

# ============================================================================
# mise (Go and other tool versions, per project via mise.toml)
# ============================================================================

# Switches tool versions on `cd` from a project's mise.toml. Node stays with
# fnm: mise only manages the tools a project's mise.toml lists.
eval "$(mise activate zsh)"

# ============================================================================
# Aliases
# ============================================================================

alias n=npm
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

## PERFORMANCE PROFILING
## Uncomment these lines to measure startup time
# zprof  # Add at the very bottom of .zshrc
