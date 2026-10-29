#!/usr/bin/env bash
# resilience.sh — app API restart and billing-route check on a worktree's test
# daemon, with the Python reference client and small real Claude Haiku calls.
#
# Usage: scripts/dev/app-api-e2e/resilience.sh <worktree>
#
# Every Claude account is marked limited for routing (EXOCORTEX_DEV_CLAUDE_ROUTING),
# and the worktree's config gets the main config's API-credit fallback (keys are
# secret names), so every turn here runs on API credits: a few cents at most.
# Phase restart: a graceful restart of the TEST daemon while an ephemeral run's
# app tool call is pending, a temporary conversation streams, and a send is made
# while the daemon is down; everything completes after the restart. Phase
# credits: app turns fall back to credits and say so; route credits=never fails
# fast or waits. Phase crash: the test daemon (its recorded PID) is killed with
# SIGKILL mid-run; the one-shot run starts over, a multi-turn ephemeral
# conversation is reported lost. Restores the worktree config and stops the
# test daemon.

set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
COMMON_GIT_DIR="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)"
ROOT="$(dirname "$COMMON_GIT_DIR")"
NAME="${1:?Usage: resilience.sh <worktree>}"
WT="$ROOT/.worktrees/$NAME"
[[ -d "$WT/daemon" ]] || { echo "No worktree $WT" >&2; exit 2; }
TESTD="$ROOT/scripts/dev/testd"
SOCKET="$(cd "$WT" && bun -e 'import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath())')"
RUNTIME_DIR="$WT/config/runtime/$NAME"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/exocortex-app-resilience-XXXXXX")"
CONFIG="$WT/config/config.json"
CONFIG_BACKUP=""
ROUTING="$SCRATCH/routing.json"

cleanup() {
  "$TESTD" stop "$NAME" >/dev/null 2>&1 || true
  if [[ -n "$CONFIG_BACKUP" ]]; then mv "$CONFIG_BACKUP" "$CONFIG"; else rm -f "$CONFIG"; fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

if [[ -f "$CONFIG" ]]; then CONFIG_BACKUP="$SCRATCH/config.json.bak"; cp "$CONFIG" "$CONFIG_BACKUP"; fi
python3 - "$ROOT/config/config.json" "$CONFIG" <<'PY'
import json, os, sys
main, target = sys.argv[1], sys.argv[2]
fallback = json.load(open(main)).get("providers", {}).get("anthropic", {}).get("apiCreditFallback")
if not fallback:
    sys.exit("the main config has no providers.anthropic.apiCreditFallback")
config = json.load(open(target)) if os.path.exists(target) else {}
config.setdefault("providers", {}).setdefault("anthropic", {})["apiCreditFallback"] = fallback
json.dump(config, open(target, "w"), indent=2)
PY
printf '{"accounts":{"main":{"limitedForMs":86400000},"max2":{"limitedForMs":86400000}}}\n' > "$ROUTING"

start_daemon() {
  EXOCORTEX_DEV_CLAUDE_ROUTING="$ROUTING" "$TESTD" start "$NAME" >/dev/null
  for _ in $(seq 1 100); do [[ -S "$SOCKET" ]] && break; sleep 0.1; done
}

request_restart() {
  python3 - "$SOCKET" <<'PY'
import json, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(sys.argv[1])
s.sendall(json.dumps({"type": "restart_daemon", "reqId": "r"}).encode() + b"\n")
s.settimeout(10)
try:
    s.recv(65536)
except OSError:
    pass
PY
}

export SOCKET SCRATCH CLIENT_DIR="$WT/clients/python"
"$TESTD" stop "$NAME" >/dev/null 2>&1 || true
log="$RUNTIME_DIR/exocortex.log"
log_from=$(( $(wc -l < "$log" 2>/dev/null || echo 0) + 1 ))
start_daemon
status=0

echo "phase restart"
PHASE=restart timeout 900 python3 "$HERE/resilience.py" &
client=$!
if ! timeout 300 bash -c "until [[ -e '$SCRATCH/restart-now' ]]; do sleep 0.05; done"; then
  echo "  FAIL the run never reached its tool call"; status=1
else
  sleep 0.3  # the streaming turn starts
  pid="$(cat "$RUNTIME_DIR/exocortexd.pid")"
  request_restart
  for _ in $(seq 1 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  echo "  (test daemon $pid stopped for the restart; starting the next one)"
  sleep 1  # the client is away for a moment, as in a real restart
  start_daemon
  touch "$SCRATCH/restarted"
fi
wait "$client" || status=1
tail -n "+$log_from" "$log" | grep -E "app-api: (handed|took over)|restart-recovery: replaying|adopted the Claude Code process|session resumed" | sed 's/^/  log: /' || true
handoff="$(ls "${TMPDIR:-/tmp}"/exocortex-apps-*-"$NAME"/handoff.json 2>/dev/null || true)"
[[ -z "$handoff" ]] && echo "  ok   no handover file left behind" || { echo "  FAIL handover file left: $handoff"; status=1; }

echo "phase crash"
rm -f "$SCRATCH/restart-now" "$SCRATCH/restarted"
log_from=$(( $(wc -l < "$log") + 1 ))
PHASE=crash timeout 900 python3 "$HERE/resilience.py" &
client=$!
if ! timeout 300 bash -c "until [[ -e '$SCRATCH/restart-now' ]]; do sleep 0.05; done"; then
  echo "  FAIL the run never reached its tool call"; status=1
else
  pid="$(cat "$RUNTIME_DIR/exocortexd.pid")"
  kill -9 "$pid"  # the PID this test daemon recorded, never a pattern
  for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
  echo "  (test daemon $pid killed; starting the next one)"
  start_daemon
  touch "$SCRATCH/restarted"
fi
wait "$client" || status=1
tail -n "+$log_from" "$log" | grep -E "stopping a Claude Code process left|app-api: (took over|ended)|is app e2e-resilience" | sed 's/^/  log: /' || true

echo "phase credits"
log_from=$(( $(wc -l < "$log") + 1 ))
PHASE=credits timeout 600 python3 "$HERE/resilience.py" || status=1
tail -n "+$log_from" "$log" | grep -E "runs on API credits" | sed 's/^/  log: /' || true

echo
[[ $status -eq 0 ]] && echo "app API resilience e2e: ALL OK" || echo "app API resilience e2e: FAILURES (see above)"
exit $status
