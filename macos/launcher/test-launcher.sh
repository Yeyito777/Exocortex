#!/usr/bin/env bash
# Behavioural test for launcher.c; runs on Linux and macOS.
# Builds the launcher against a fake repo whose run-daemon.sh execs a fake
# daemon, then checks exit-status passthrough, signal forwarding and the
# environment handed to the daemon.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CC="${CC:-cc}"
LAUNCHER="$WORK/exocortex-daemon"
"$CC" -std=c11 -D_DARWIN_C_SOURCE -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 \
  "$SRC_DIR/launcher.c" -o "$LAUNCHER"

REPO="$WORK/repo"
mkdir -p "$REPO/scripts/setup" "$WORK/bunbin"
printf '#!/bin/sh\nexit 0\n' > "$WORK/bunbin/bun"
chmod +x "$WORK/bunbin/bun"

# Like the real run-daemon.sh: hydrate, then exec the daemon in place.
cat > "$REPO/scripts/setup/run-daemon.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
bun install >/dev/null
out="$FAKE_OUT"
{
  echo "pid=$$"
  echo "ppid=$PPID"
  echo "launcher=${EXOCORTEX_LAUNCHER_PID:-}"
  echo "launcher_path=${EXOCORTEX_LAUNCHER:-}"
  echo "bun=$(command -v bun)"
  echo "args=$*"
} > "$out.tmp"
mv "$out.tmp" "$out"
case "${FAKE_MODE:-}" in
  exit) exit "$FAKE_STATUS" ;;
  # The daemon handles SIGTERM/SIGINT/SIGHUP by shutting down with status 0.
  serve) exec /bin/bash -c 'trap "echo got-\$1 >> \"$FAKE_OUT.sig\"; exit 0" TERM; trap "echo got-INT >> \"$FAKE_OUT.sig\"; exit 0" INT; trap "echo got-HUP >> \"$FAKE_OUT.sig\"; exit 0" HUP; while :; do sleep 0.05; done' daemon TERM ;;
  killed) exec /bin/bash -c 'kill -KILL $$' ;;
esac
EOF
chmod +x "$REPO/scripts/setup/run-daemon.sh"

failures=0
check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  fi
}

run_status() {
  local status=0
  "$@" || status=$?
  printf '%s' "$status"
}

export PATH="$WORK/bunbin:/usr/bin:/bin"
export FAKE_OUT="$WORK/out"

# Exit status passthrough, including the daemon's restart code.
for code in 0 1 75 78; do
  check "exit $code passes through" "$code" \
    "$(FAKE_MODE=exit FAKE_STATUS=$code run_status "$LAUNCHER" --repo "$REPO")"
done

# Environment and argv handed to the daemon.
FAKE_MODE=exit FAKE_STATUS=0 "$LAUNCHER" --repo "$REPO" -- --flag value
check "args forwarded" "args=--flag value" "$(grep '^args=' "$FAKE_OUT")"
launcher_pid="$(sed -n 's/^launcher=//p' "$FAKE_OUT")"
check "daemon is the launcher's direct child" "ppid=$launcher_pid" "$(grep '^ppid=' "$FAKE_OUT")"
check "launcher path exported" "launcher_path=$LAUNCHER" "$(grep '^launcher_path=' "$FAKE_OUT")"

# Signals are forwarded to the daemon; the launcher exits with its status.
for sig in TERM INT HUP; do
  rm -f "$FAKE_OUT" "$FAKE_OUT.sig"
  FAKE_MODE=serve "$LAUNCHER" --repo "$REPO" &
  pid=$!
  for _ in $(seq 1 100); do [[ -f "$FAKE_OUT" ]] && break; sleep 0.05; done
  kill "-$sig" "$pid"
  status=0
  wait "$pid" || status=$?
  check "SIG$sig forwarded, clean exit" "0 got-$sig" "$status $(cat "$FAKE_OUT.sig" 2>/dev/null)"
done

# A daemon killed by a signal kills the launcher the same way.
check "signal death mirrored" "$((128 + 9))" "$(FAKE_MODE=killed run_status "$LAUNCHER" --repo "$REPO")"

# Configuration errors exit 78 like run-daemon.sh.
check "missing repo" 78 "$(run_status "$LAUNCHER" 2>/dev/null)"
check "bad repo" 78 "$(run_status "$LAUNCHER" --repo "$WORK/nope" 2>/dev/null)"
check "bun not found" 78 "$(PATH=/usr/bin:/bin HOME="$WORK" EXOCORTEX_BUN="$WORK/missing" run_status "$LAUNCHER" --repo "$REPO" 2>/dev/null)"
check "EXOCORTEX_BUN override" 0 "$(PATH=/usr/bin:/bin EXOCORTEX_BUN="$WORK/bunbin/bun" FAKE_MODE=exit FAKE_STATUS=0 run_status "$LAUNCHER" --repo "$REPO")"
check "bun's dir prepended to PATH" "bun=$WORK/bunbin/bun" "$(grep '^bun=' "$FAKE_OUT")"

# --exec runs any job the same way: exit status, signals, PATH lookup.
check "exec exit passes through" 75 "$(run_status "$LAUNCHER" --exec sh -c 'exit 75')"
check "exec args forwarded" "a b" "$("$LAUNCHER" --exec sh -c 'echo "$0 $1"' a b)"
check "exec needs a program" 78 "$(run_status "$LAUNCHER" --exec 2>/dev/null)"
check "exec program not found" 127 "$(run_status "$LAUNCHER" --exec "$WORK/missing" 2>/dev/null)"
rm -f "$FAKE_OUT.sig"
"$LAUNCHER" --exec /bin/bash -c 'trap "echo got-TERM >> \"$FAKE_OUT.sig\"; exit 0" TERM; touch "$FAKE_OUT.ready"; while :; do sleep 0.05; done' &
pid=$!
for _ in $(seq 1 100); do [[ -f "$FAKE_OUT.ready" ]] && break; sleep 0.05; done
kill -TERM "$pid"
status=0
wait "$pid" || status=$?
check "exec SIGTERM forwarded, clean exit" "0 got-TERM" "$status $(cat "$FAKE_OUT.sig" 2>/dev/null)"

# Full Disk Access check: granted when the probed file opens, missing when
# permission is denied (macOS's silent TCC denial), unknown otherwise.
fda() {
  local status=0 out
  out="$(EXOCORTEX_FDA_PROBE_PATH="$1" "$LAUNCHER" --check-full-disk-access 2>/dev/null)" || status=$?
  printf '%s %s' "$status" "$out"
}
probe="$WORK/TCC.db"
echo db > "$probe"
check "full disk access granted" "0 granted" "$(fda "$probe")"
chmod 000 "$probe"
if [[ "$(id -u)" != 0 ]]; then
  check "full disk access missing" "1 missing" "$(fda "$probe")"
fi
check "full disk access unknown" "2 unknown" "$(fda "$WORK/nope/TCC.db")"

if ((failures > 0)); then
  echo "  ✗ $failures launcher check(s) failed" >&2
  exit 1
fi
echo "  ✓ launcher behaves"
