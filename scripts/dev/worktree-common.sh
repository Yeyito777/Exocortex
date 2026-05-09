#!/usr/bin/env bash
# Shared helpers for Exocortex worktree scripts.

WORKTREE_SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
EXOCORTEX_ROOT="$(dirname "$(dirname "$WORKTREE_SCRIPT_DIR")")"

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

sync_dependency_artifacts() {
  local worktree_dir="$1"

  # bun.lock is intentionally ignored by git, so `git worktree add` does not
  # populate it. Keep a local copy in each worktree before any `bun install` so
  # Bun uses the resolved lockfile instead of doing a fresh network resolution.
  local lock
  for lock in bun.lock bun.lockb; do
    if [[ -f "$EXOCORTEX_ROOT/$lock" && ! -e "$worktree_dir/$lock" ]]; then
      cp "$EXOCORTEX_ROOT/$lock" "$worktree_dir/$lock"
    fi
  done

  # Bun's workspace install can be slow or hang when each worktree starts with
  # empty node_modules. Seed the ignored dependency layout from the main checkout:
  # - share the global content-addressed .bun cache via symlink
  # - copy workspace node_modules directories so their relative workspace links
  #   (e.g. @exocortex/shared -> ../../../shared) point at this worktree.
  if [[ -d "$EXOCORTEX_ROOT/node_modules/.bun" ]]; then
    mkdir -p "$worktree_dir/node_modules"
    local wt_bun_cache="$worktree_dir/node_modules/.bun"
    if [[ ! -L "$wt_bun_cache" || "$(readlink "$wt_bun_cache" 2>/dev/null || true)" != "$EXOCORTEX_ROOT/node_modules/.bun" ]]; then
      rm -rf "$wt_bun_cache"
      ln -s "$EXOCORTEX_ROOT/node_modules/.bun" "$wt_bun_cache"
    fi
  fi

  local workspace
  for workspace in shared daemon tui; do
    if [[ -d "$EXOCORTEX_ROOT/$workspace/node_modules" && ! -e "$worktree_dir/$workspace/node_modules" ]]; then
      cp -a "$EXOCORTEX_ROOT/$workspace/node_modules" "$worktree_dir/$workspace/node_modules"
    fi
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
