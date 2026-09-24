# ===========================================================================
# Stow packages per machine profile
# ===========================================================================
# bootstrap.sh stows these lists and verify.sh checks them. A package that
# isn't listed for a profile is left alone on that machine.

profile_packages() {
    case "$1" in
        work)     echo aerospace agents claude ghostty git herdr karabiner zed zsh-work ;;
        personal) echo aerospace agents claude ghostty git herdr karabiner zed zsh-personal ;;
    esac
}

# Profile of this machine, read from the zsh-* package ~/.zshrc links into.
# Prints nothing when ~/.zshrc isn't stowed.
current_profile() {
    { readlink "$HOME/.zshrc" 2>/dev/null || true; } | sed -nE 's#.*/zsh-(work|personal)/.*#\1#p'
}

# Stow flags for a package. Everything uses --no-folding (file-level links),
# except karabiner: Karabiner only notices config changes, and keeps the link
# intact when it saves, if the whole ~/.config/karabiner directory is the link.
stow_flags() {
    [[ "$1" == karabiner ]] || echo --no-folding
}
