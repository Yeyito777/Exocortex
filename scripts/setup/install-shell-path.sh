#!/usr/bin/env bash
# Make Exocortex and Bun available to interactive shells and to commands run by
# SSH, including the `exocortexd proxy` command used by `/ssh` in the TUI.
set -euo pipefail

: "${HOME:?HOME must be set}"

BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BUN_BIN="${BUN_BIN:-$(command -v bun)}"
LOGIN_SHELL="${EXOCORTEX_LOGIN_SHELL:-${SHELL:-}}"
MARKER="# exocortex: managed non-interactive PATH"

if [[ -z "$LOGIN_SHELL" ]] && command -v getent >/dev/null 2>&1; then
  LOGIN_SHELL="$(getent passwd "$(id -un)" | cut -d: -f7)"
fi

case "${LOGIN_SHELL##*/}" in
  zsh)
    PROFILE="${ZDOTDIR:-$HOME}/.zshenv"
    ;;
  bash)
    # Bash reads .bashrc when sshd starts a non-interactive remote command.
    # The managed line is kept at the top, before common interactive-only
    # early returns.
    PROFILE="$HOME/.bashrc"
    ;;
  *)
    printf '  ⚠ Could not configure PATH for unsupported login shell: %s\n' \
      "${LOGIN_SHELL:-unknown}"
    printf "    Add %s and %s to that shell's non-interactive PATH.\n" \
      "$BIN_DIR" "$(dirname "$BUN_BIN")"
    exit 0
    ;;
esac

# Render paths inside a double-quoted shell assignment. Paths below HOME use a
# literal $HOME so the profile remains valid if the home directory is mounted
# at a different location later.
shell_path_literal() {
  local path="$1"
  if [[ "$path" == "$HOME/"* ]]; then
    path="\$HOME/${path#"$HOME/"}"
  fi
  path="${path//\\/\\\\}"
  path="${path//\"/\\\"}"
  path="${path//\`/\\\`}"
  # Preserve the intentional $HOME above while protecting any other dollar
  # signs in an unusual installation path.
  path="${path//\$/\\\$}"
  path="${path/#\\\$HOME/\$HOME}"
  printf '%s' "$path"
}

EXOCORTEX_PATH="$(shell_path_literal "$BIN_DIR")"
BUN_PATH="$(shell_path_literal "$(dirname "$BUN_BIN")")"
MANAGED_LINE="export PATH=\"$EXOCORTEX_PATH:$BUN_PATH:\$PATH\" $MARKER"

mkdir -p "$(dirname "$PROFILE")"
touch "$PROFILE"

temporary="$(mktemp "${PROFILE}.tmp.XXXXXX")"
trap 'rm -f "$temporary"' EXIT

if grep -Fq "$MARKER" "$PROFILE"; then
  awk -v marker="$MARKER" -v replacement="$MANAGED_LINE" '
    index($0, marker) {
      if (!replaced) print replacement
      replaced = 1
      next
    }
    { print }
  ' "$PROFILE" > "$temporary"
else
  {
    printf '%s\n' "$MANAGED_LINE"
    cat "$PROFILE"
  } > "$temporary"
fi

# Writing through the original file preserves its ownership and permissions.
cat "$temporary" > "$PROFILE"
printf '  ✓ Configured interactive and SSH command PATH in %s\n' "$PROFILE"
