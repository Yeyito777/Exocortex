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

# A worktree reads the main checkout's credentials but must never write them
# (docs/dev-daemons.md): its config/secrets is a directory of per-file symlinks
# to the main ones, marked as borrowed. The daemon (daemon/src/store.ts) keeps
# its own credential changes in memory there, and an atomic save by older
# daemon code can only replace a link in this directory, never the real file;
# the next sync restores the link. A worktree whose config/secrets is a private
# directory without the marker (a test with its own fake keys) is left alone.
BORROWED_SECRETS_MARKER=".borrowed-from-main"

sync_shared_secrets() {
  local worktree_dir="$1"
  local main_secrets="$EXOCORTEX_ROOT/config/secrets"
  local wt_secrets="$worktree_dir/config/secrets"
  [[ -d "$main_secrets" ]] || return 0

  # Older worktrees linked the whole directory, so their writes landed in the main store.
  if [[ -L "$wt_secrets" && -d "$wt_secrets" && "$(cd "$wt_secrets" && pwd -P)" == "$(cd "$main_secrets" && pwd -P)" ]]; then
    rm "$wt_secrets"
  fi
  if [[ -e "$wt_secrets" && ! -f "$wt_secrets/$BORROWED_SECRETS_MARKER" ]]; then
    return 0
  fi
  mkdir -p "$wt_secrets"
  chmod 700 "$wt_secrets"
  printf 'Symlinks to %s: this worktree reads the main credentials and never writes them.\n' "$main_secrets" > "$wt_secrets/$BORROWED_SECRETS_MARKER"
  local file name
  for file in "$main_secrets"/*; do
    [[ -f "$file" ]] || continue
    name="$(basename "$file")"
    # A regular file here is a copy an older daemon saved over its link: stale, and never the owner's.
    if [[ -e "$wt_secrets/$name" && ! -L "$wt_secrets/$name" ]]; then rm -f "$wt_secrets/$name"; fi
    [[ -L "$wt_secrets/$name" ]] || ln -s "$file" "$wt_secrets/$name"
  done
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

  # bun.lock is tracked, so `git worktree add` checks it out; a branch from
  # before it was tracked lacks it. Copy main's then, before any `bun install`,
  # so Bun uses the resolved lockfile instead of a fresh network resolution.
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
