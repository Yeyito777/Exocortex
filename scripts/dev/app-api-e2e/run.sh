#!/usr/bin/env bash
# run.sh — app API end-to-end check on a worktree's test daemon, with real
# (small: Claude Haiku, gpt-5.4-mini) model calls on anthropic and openai.
#
# Usage: scripts/dev/app-api-e2e/run.sh <worktree>
#
# It restarts the worktree's test daemon with its Claude Code binary and
# OpenAI base URLs pointed at local logging proxies (wire-proxy.ts), so the
# checks see the real requests: base none/agent carry no global instructions,
# CLAUDE.md or memory, unselected tools are unavailable. Canaries: a line in
# the worktree's config/system.md (restored afterwards) and a CLAUDE.md in a
# scratch app cwd. Then: app tool round trips, timeout, abort, ownership,
# lifetimes, nothing of an ephemeral conversation on disk, expiry across a
# restart, and a turn interrupted by a restart while an app tool call waits.
# Stops the test daemon at the end.

set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
COMMON_GIT_DIR="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)"
ROOT="$(dirname "$COMMON_GIT_DIR")"
NAME="${1:?Usage: run.sh <worktree>}"
WT="$ROOT/.worktrees/$NAME"
[[ -d "$WT/daemon" ]] || { echo "No worktree $WT" >&2; exit 2; }
TESTD="$ROOT/scripts/dev/testd"
SOCKET="$(cd "$WT" && bun -e 'import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath())')"
DATA_DIR="$WT/config/data/instances/$NAME"
RUNTIME_DIR="$WT/config/runtime/$NAME"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/exocortex-app-e2e-XXXXXX")"
CLAUDE_BIN="${CLAUDE_CODE_BIN:-$(readlink -f "$HOME/.local/bin/claude" 2>/dev/null || command -v claude)}"
PORT_A=18941 PORT_C=18942 PORT_K=18943
PROXY_PIDS=()
SYSTEM_MD="$WT/config/system.md"
SYSTEM_BACKUP=""

cleanup() {
  for pid in "${PROXY_PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  "$TESTD" stop "$NAME" >/dev/null 2>&1 || true
  if [[ -n "$SYSTEM_BACKUP" ]]; then mv "$SYSTEM_BACKUP" "$SYSTEM_MD"; else rm -f "$SYSTEM_MD"; fi
  # Claude Code's project for the scratch app cwd (base full keeps its auto-memory on).
  rm -rf "$HOME/.claude/projects/$(printf '%s' "$SCRATCH/appcwd" | sed 's/[^a-zA-Z0-9]/-/g')"
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [[ -f "$SYSTEM_MD" ]]; then SYSTEM_BACKUP="$SCRATCH/system.md.bak"; cp "$SYSTEM_MD" "$SYSTEM_BACKUP"; fi
printf '\nGLOBAL_CANARY_9431: test daemon global instructions canary.\n' >> "$SYSTEM_MD"
mkdir -p "$SCRATCH/appcwd" && printf 'CLAUDEMD_CANARY_5512 project instructions canary.\n' > "$SCRATCH/appcwd/CLAUDE.md"
printf '#!/bin/sh\nexport ANTHROPIC_BASE_URL=http://127.0.0.1:%s\nexec "%s" "$@"\n' "$PORT_A" "$CLAUDE_BIN" > "$SCRATCH/claude"
chmod +x "$SCRATCH/claude"

for spec in "$PORT_A https://api.anthropic.com" "$PORT_C https://chatgpt.com" "$PORT_K https://api.openai.com"; do
  read -r port upstream <<<"$spec"
  bun "$HERE/wire-proxy.ts" "$port" "$SCRATCH/wire.jsonl" "$upstream" >"$SCRATCH/proxy-$port.log" 2>&1 &
  PROXY_PIDS+=("$!")
done
sleep 1

start_daemon() {
  CLAUDE_CODE_BIN="$SCRATCH/claude" OPENAI_CHATGPT_BASE_URL="http://127.0.0.1:$PORT_C" OPENAI_API_BASE_URL="http://127.0.0.1:$PORT_K/v1" \
    "$TESTD" start "$NAME" >/dev/null
  sleep 2
}

export SOCKET DATA_DIR RUNTIME_DIR WIRE_LOG="$SCRATCH/wire.jsonl" APP_CWD="$SCRATCH/appcwd" STATE="$SCRATCH/state.json"
"$TESTD" stop "$NAME" >/dev/null 2>&1 || true
start_daemon
status=0
PHASE=main timeout 900 bun "$HERE/e2e.ts" || status=1
"$TESTD" stop "$NAME" >/dev/null
start_daemon
PHASE=after-restart timeout 300 bun "$HERE/e2e.ts" || status=1

# A turn interrupted by a restart (restart_daemon: interrupted turns replay) while an app tool call waits.
pid="$(cat "$RUNTIME_DIR/exocortexd.pid")"
STATE="$SCRATCH/restart-state.json" PHASE=before timeout 300 bun "$HERE/restart-e2e.ts" || status=1
for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
start_daemon
STATE="$SCRATCH/restart-state.json" PHASE=after timeout 400 bun "$HERE/restart-e2e.ts" || status=1

echo
[[ $status -eq 0 ]] && echo "app API e2e: ALL OK" || echo "app API e2e: FAILURES (see above)"
exit $status
