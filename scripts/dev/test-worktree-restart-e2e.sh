#!/usr/bin/env bash
# End-to-end regression: Ctrl+Shift+R in an exotest TUI must restart only the
# worktree daemon and must leave the user's main systemd daemon untouched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
WORKTREE_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
GIT_DIR="$(git -C "$WORKTREE_DIR" rev-parse --git-dir)"
COMMON_DIR="$(git -C "$WORKTREE_DIR" rev-parse --git-common-dir)"

if [[ "$(readlink -f "$GIT_DIR")" == "$(readlink -f "$COMMON_DIR")" ]]; then
  printf 'error: run this regression from a linked Exocortex worktree\n' >&2
  exit 2
fi

WT_NAME="$(basename "$GIT_DIR")"
RUNTIME_DIR="$WORKTREE_DIR/config/runtime/$WT_NAME"
PID_FILE="$RUNTIME_DIR/exocortexd.pid"
SOCKET="$RUNTIME_DIR/exocortexd.sock"
XENV_NAME="exo-restart-e2e-$$"
TERMINAL_PID=""
EXOTEST_PID=""
TEST_DAEMON_PIDS=()

main_pid() {
  systemctl --user show exocortex-daemon.service --property MainPID --value
}

record_test_pid() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  TEST_DAEMON_PIDS+=("$pid")
}

kill_test_daemon_if_owned() {
  local pid="$1" cwd=""
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$cwd" == "$WORKTREE_DIR"/* ]]; then
    kill "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  [[ -n "$EXOTEST_PID" ]] && kill "$EXOTEST_PID" 2>/dev/null
  sleep 0.2
  for pid in "${TEST_DAEMON_PIDS[@]}"; do kill_test_daemon_if_owned "$pid"; done
  if [[ -f "$PID_FILE" ]]; then kill_test_daemon_if_owned "$(cat "$PID_FILE" 2>/dev/null)"; fi
  [[ -n "$TERMINAL_PID" ]] && kill "$TERMINAL_PID" 2>/dev/null
  xenv stop "$XENV_NAME" >/dev/null 2>&1
  exit "$status"
}
trap cleanup EXIT INT TERM

before_main_pid="$(main_pid)"
if [[ ! "$before_main_pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$before_main_pid" 2>/dev/null; then
  printf 'error: the main exocortex-daemon.service must be running for this regression\n' >&2
  exit 2
fi

if [[ -f "$PID_FILE" ]]; then
  existing_test_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$existing_test_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$existing_test_pid" 2>/dev/null; then
    printf 'error: worktree daemon is already running (pid=%s); stop its exotest session first\n' "$existing_test_pid" >&2
    exit 2
  fi
fi
rm -f "$SOCKET" "$PID_FILE"
xenv start "$XENV_NAME" >/dev/null
printf -v launch_command 'exec %q %q' "$WORKTREE_DIR/scripts/dev/exotest" "$WORKTREE_DIR"
printf -v terminal_command 'exec st -e bash -lc %q' "$launch_command"
# Put st's own -e option behind a shell so xenv cannot mistake it for another
# xenv instance selector.
launch_output="$(XENV_INSTANCE="$XENV_NAME" xenv run sh -c "$terminal_command")"
TERMINAL_PID="$(sed -n 's/.*(PID \([0-9][0-9]*\)).*/\1/p' <<<"$launch_output" | tail -n 1)"
[[ -n "$TERMINAL_PID" ]] || { printf 'error: could not determine nested terminal PID\n%s\n' "$launch_output" >&2; exit 1; }

for _ in $(seq 1 100); do
  EXOTEST_PID="$(pgrep -P "$TERMINAL_PID" | head -n 1 || true)"
  [[ -n "$EXOTEST_PID" ]] && break
  sleep 0.1
done
[[ -n "$EXOTEST_PID" ]] || { echo 'error: exotest did not start' >&2; exit 1; }

old_test_pid=""
for _ in $(seq 1 200); do
  if [[ -f "$PID_FILE" && -S "$SOCKET" ]]; then
    old_test_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$old_test_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_test_pid" 2>/dev/null; then
      break
    fi
  fi
  sleep 0.1
done
[[ -n "$old_test_pid" ]] || { echo 'error: worktree daemon did not become ready' >&2; exit 1; }
record_test_pid "$old_test_pid"

# Give the nested terminal enough time to enter the TUI and enable CSI-u input.
sleep 0.5
xenv key -e "$XENV_NAME" ctrl+shift+r >/dev/null

new_test_pid=""
for _ in $(seq 1 300); do
  if [[ -f "$PID_FILE" && -S "$SOCKET" ]]; then
    candidate="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ "$candidate" =~ ^[1-9][0-9]*$ && "$candidate" != "$old_test_pid" ]] && kill -0 "$candidate" 2>/dev/null; then
      new_test_pid="$candidate"
      break
    fi
  fi
  sleep 0.1
done
[[ -n "$new_test_pid" ]] || { echo 'error: Ctrl+Shift+R did not relaunch the worktree daemon' >&2; exit 1; }
record_test_pid "$new_test_pid"

after_main_pid="$(main_pid)"
if [[ "$after_main_pid" != "$before_main_pid" ]] || ! kill -0 "$before_main_pid" 2>/dev/null; then
  printf 'error: main daemon changed during worktree restart (before=%s after=%s)\n' "$before_main_pid" "$after_main_pid" >&2
  exit 1
fi

if kill -0 "$old_test_pid" 2>/dev/null; then
  printf 'error: old worktree daemon is still alive (pid=%s)\n' "$old_test_pid" >&2
  exit 1
fi

printf 'ok: worktree daemon restarted %s -> %s; main daemon stayed %s\n' \
  "$old_test_pid" "$new_test_pid" "$before_main_pid"
