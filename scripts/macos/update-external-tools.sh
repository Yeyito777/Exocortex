#!/usr/bin/env bash
# update-external-tools.sh — bring each external-tools/*/ git repo current.
#
# external-tools/* are separate git repos, so `git pull` in the Exocortex
# checkout never touches them. For every one that is its own repo this fetches
# and fast-forwards it, but only when that is provably safe: on the default
# branch, clean working tree, strictly behind its upstream. Everything else is
# skipped with a one-line warning. Nothing is ever stashed, reset or discarded,
# and network failures only skip that repo. Always exits 0 (2 on bad usage).
#
# Usage: update-external-tools.sh [TOOLS_DIR]   (default: <repo>/external-tools)
# Plain bash 3.2 (macOS default): no associative arrays, no mapfile.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="${1:-$SCRIPT_DIR/../../external-tools}"
[[ -d "$TOOLS_DIR" ]] || { echo "  ✗ Not a directory: $TOOLS_DIR" >&2; exit 2; }
TOOLS_DIR="$(cd "$TOOLS_DIR" && pwd)"

# Never block on credentials or host-key prompts; give up on a stalled network.
export GIT_TERMINAL_PROMPT=0
: "${GIT_SSH_COMMAND:=ssh -o BatchMode=yes -o ConnectTimeout=15}"
export GIT_SSH_COMMAND
GIT_NET=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20)

UPDATED=""    # lines: "name (old..new)"
SKIPPED=""    # lines: "name: reason"
CURRENT=0

warn() { echo "  ⚠ $*" >&2; }
skip() { # name reason
  warn "external-tools/$1: skipped — $2"
  SKIPPED="${SKIPPED}$1: $2"$'\n'
}

# Re-run a tool's existing dependency setup for files its pull changed.
# $1 = repo dir, $2 = name, $3 = newline-separated changed paths
refresh_deps() {
  local dir="$1" name="$2" changed="$3" f py_req="" js=""
  while IFS= read -r f; do
    case "$f" in
      requirements.lock) py_req="requirements.lock" ;;
      requirements.txt) [[ "$py_req" == "requirements.lock" ]] || py_req="requirements.txt" ;;
      package.json|bun.lock|bun.lockb|package-lock.json) js="$f" ;;
    esac
  done <<< "$changed"

  if [[ -n "$py_req" ]]; then
    if [[ -x "$dir/.venv/bin/pip" ]]; then
      local flags="-r"
      [[ "$py_req" == "requirements.lock" ]] && flags="--require-hashes -r"
      echo "  • $name: $py_req changed, updating .venv"
      # shellcheck disable=SC2086
      (cd "$dir" && .venv/bin/pip install -q $flags "$py_req") \
        || warn "external-tools/$name: pip install failed; fix by hand: cd $dir && .venv/bin/pip install $flags $py_req"
    else
      warn "external-tools/$name: $py_req changed but there is no .venv; create it per the tool's README"
    fi
  fi
  if [[ -n "$js" ]]; then
    if [[ -f "$dir/bun.lock" ]] && command -v bun >/dev/null 2>&1; then
      echo "  • $name: $js changed, running bun install"
      (cd "$dir" && bun install --frozen-lockfile) \
        || warn "external-tools/$name: bun install failed; fix by hand: cd $dir && bun install"
    else
      warn "external-tools/$name: $js changed; run its dependency install by hand (cd $dir)"
    fi
  fi
}

update_repo() {
  local dir="$1" name branch want old new counts ahead behind changed out
  name="$(basename "$dir")"
  git -C "$dir" rev-parse --verify -q HEAD >/dev/null 2>&1 || { skip "$name" "no commits yet"; return; }
  branch="$(git -C "$dir" symbolic-ref -q --short HEAD 2>/dev/null)" || { skip "$name" "detached HEAD"; return; }
  want="$(git -C "$dir" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
  want="${want#origin/}"
  [[ -n "$want" ]] || want="main"
  [[ "$branch" == "$want" ]] || { skip "$name" "on branch '$branch', not '$want'"; return; }
  [[ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]] || { skip "$name" "working tree is dirty"; return; }
  git -C "$dir" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1 || { skip "$name" "no upstream configured for '$branch'"; return; }

  if ! out="$(git -C "$dir" "${GIT_NET[@]}" fetch --quiet 2>&1)"; then
    skip "$name" "fetch failed ($(printf '%s' "$out" | tail -n 1))"
    return
  fi
  counts="$(git -C "$dir" rev-list --left-right --count 'HEAD...@{upstream}' 2>/dev/null)" || { skip "$name" "cannot compare with upstream"; return; }
  ahead="${counts%%[[:space:]]*}"
  behind="${counts##*[[:space:]]}"

  if ((ahead > 0 && behind > 0)); then skip "$name" "diverged ($ahead ahead, $behind behind)"; return; fi
  if ((ahead > 0)); then skip "$name" "$ahead unpushed local commit(s) ahead of origin"; return; fi
  if ((behind == 0)); then CURRENT=$((CURRENT + 1)); return; fi

  old="$(git -C "$dir" rev-parse --short HEAD)"
  if ! out="$(git -C "$dir" merge --ff-only --quiet '@{upstream}' 2>&1)"; then
    skip "$name" "fast-forward failed ($(printf '%s' "$out" | tail -n 1))"
    return
  fi
  new="$(git -C "$dir" rev-parse --short HEAD)"
  UPDATED="${UPDATED}$name ($old..$new, $behind commit(s))"$'\n'
  changed="$(git -C "$dir" diff --name-only "$old" "$new" 2>/dev/null)"
  refresh_deps "$dir" "$name" "$changed"
}

for dir in "$TOOLS_DIR"/*/; do
  dir="${dir%/}"
  [[ -e "$dir/.git" ]] || continue   # not its own repo
  update_repo "$dir"
done

# ── Summary ──────────────────────────────────────────────────────────
n_up=0; n_skip=0
[[ -n "$UPDATED" ]] && n_up="$(printf '%s' "$UPDATED" | grep -c '')"
[[ -n "$SKIPPED" ]] && n_skip="$(printf '%s' "$SKIPPED" | grep -c '')"
echo "  ✓ External tools: updated $n_up, skipped $n_skip, already current $CURRENT"
if [[ -n "$UPDATED" ]]; then
  while IFS= read -r l; do echo "      updated  $l"; done <<< "${UPDATED%$'\n'}"
fi
if [[ -n "$SKIPPED" ]]; then
  while IFS= read -r l; do echo "      skipped  $l"; done <<< "${SKIPPED%$'\n'}"
fi
exit 0
