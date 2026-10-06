# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# See https://github.com/ohmyzsh/ohmyzsh/wiki/Themes
ZSH_THEME="robbyrussell"

# Plugins
plugins=(git z zsh-autosuggestions zsh-syntax-highlighting)

# Completion dirs must join fpath BEFORE oh-my-zsh loads, because OMZ runs the
# only compinit. Added after it, they are missed until the dump is rebuilt.
if [[ -d "$HOME/.docker/completions" ]]; then
  fpath=("$HOME/.docker/completions" $fpath)
fi
if [[ -d "$HOME/.grok/completions/zsh" ]]; then
  fpath=("$HOME/.grok/completions/zsh" $fpath)
fi

source $ZSH/oh-my-zsh.sh

# -----------------------------
# User configuration
# -----------------------------

# Set Zed as default editor
export EDITOR="zed"
export VISUAL="zed"

alias python=python3
alias pip=pip3

# -----------------------------
# Node version in RPROMPT (root-only, no cache)
# Updates on `cd` and before each prompt.
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

setopt prompt_subst
RPROMPT='${NODE_RPROMPT}'

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
typeset -U path
path=("$HOME/.local/bin" "$BUN_INSTALL/bin" $path)
export PATH

# Vite+ bin (https://viteplus.dev)
# Manages Node, npm, pnpm and Yarn per project. Sourced after the PATH edits
# above so its shims come first. Vite+ 1.0 installs into ~/.vite-plus; newer
# installers default to ~/.config/vite-plus on a fresh machine. The installer
# only appends its own source line when this file mentions neither path.
for __vp_env in "$HOME/.vite-plus/env" "$HOME/.config/vite-plus/env"; do
  [[ -f "$__vp_env" ]] && { . "$__vp_env"; break; }
done
unset __vp_env

# Global packages belong to Vite+ (vp install -g / remove -g / update -g /
# list -g), which keeps them across Node versions. `npm -g` and `pnpm -g`
# would install into one Node version's directory instead, so refuse them.
# Only catches commands typed here; scripts calling npm directly bypass it.
__refuse_global_flag() {
  local tool=$1 arg
  shift
  for arg in "$@"; do
    case "$arg" in
      --) break ;;
      -g|--global|--location=global)
        print -u2 "$tool: global installs go through Vite+, e.g. vp install -g <pkg>"
        return 1
        ;;
    esac
  done
}
npm() { __refuse_global_flag npm "$@" && command npm "$@"; }
pnpm() { __refuse_global_flag pnpm "$@" && command pnpm "$@"; }

# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
# <<< grok installer <<<
