#!/usr/bin/env bash
# Shared helpers for Exocortex worktree scripts.

WORKTREE_SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
EXOCORTEX_ROOT="$(dirname "$WORKTREE_SCRIPT_DIR")"

worktree_die() {
  printf "\n  ✗ %s\n\n" "$1" >&2
  exit 1
}

resolve_worktree_dir() {
  local input="${1:-}"
  [[ -n "$input" ]] || worktree_die "Usage: <worktree-name|path>"

  if [[ "$input" == /* ]]; then
    printf '%s\n' "$input"
  elif [[ "$input" == .worktrees/* ]]; then
    printf '%s\n' "$EXOCORTEX_ROOT/$input"
  else
    printf '%s\n' "$EXOCORTEX_ROOT/.worktrees/$input"
  fi
}

sync_shared_secrets() {
  local worktree_dir="$1"
  local main_secrets="$EXOCORTEX_ROOT/config/secrets"
  local wt_secrets="$worktree_dir/config/secrets"

  if [[ -d "$main_secrets" && ! -e "$wt_secrets" ]]; then
    mkdir -p "$(dirname "$wt_secrets")"
    ln -s "$main_secrets" "$wt_secrets"
  fi
}

sync_external_tools() {
  local worktree_dir="$1"
  local main_tools="$EXOCORTEX_ROOT/external-tools"
  local wt_tools="$worktree_dir/external-tools"

  [[ -d "$main_tools" ]] || return 0
  mkdir -p "$wt_tools"

  local entry base target
  for entry in "$main_tools"/*; do
    [[ -e "$entry" ]] || continue
    base="$(basename "$entry")"
    case "$base" in
      TOOL_STANDARD.md|PORT_PROMPT.md)
        continue
        ;;
    esac
    [[ -d "$entry" ]] || continue
    target="$wt_tools/$base"
    [[ -e "$target" ]] || ln -s "$entry" "$target"
  done
}

cleanup_worktree_config() {
  local worktree_dir="$1"
  local wt_name="$(basename "$worktree_dir")"

  rm -rf "$worktree_dir/config/runtime/$wt_name"
  rm -rf "$worktree_dir/config/data/instances/$wt_name"
  rm -rf "$HOME/.config/exocortex/runtime/$wt_name"
  rm -rf "$HOME/.config/exocortex/data/instances/$wt_name"
}
