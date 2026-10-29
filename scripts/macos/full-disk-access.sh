#!/usr/bin/env bash
# full-disk-access.sh — one-time Full Disk Access for "Exocortex Daemon.app".
#
# macOS asks separately for Desktop, Documents, Downloads, other apps' data,
# removable and network volumes, ...; Full Disk Access is the one grant that
# covers them all, and only the user can give it (System Settings). This
# checks the launcher app's access without prompting and, when it is missing,
# opens Privacy & Security › Full Disk Access and says what to switch on.
# See README.md › macOS › Daemon launcher.
#
#   full-disk-access.sh [--app PATH] check   print granted|missing|unknown (exit 0|1|2)
#   full-disk-access.sh [--app PATH] setup   check; if missing, open System Settings,
#                                            explain, and on a terminal wait for the switch
set -euo pipefail

APP="$HOME/Applications/Exocortex Daemon.app"
EXECUTABLE_NAME="exocortex-daemon"
SETTINGS_URL="x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
WAIT_SECONDS="${EXOCORTEX_FDA_WAIT_SECONDS:-300}"
MODE=""
OPEN=1

usage() {
  sed -n '2,13s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
  echo "  Options: --app PATH, --no-open (print the steps only), --no-wait"
}

while (($# > 0)); do
  case "$1" in
    --app) APP="${2:?--app needs a path}"; shift ;;
    --no-open) OPEN=0 ;;
    --no-wait) WAIT_SECONDS=0 ;;
    check|setup) MODE="$1" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "  ✗ Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[[ -n "$MODE" ]] || { usage >&2; exit 2; }

APP="${APP%/}"
EXECUTABLE="$APP/Contents/MacOS/$EXECUTABLE_NAME"

check() {
  if [[ ! -x "$EXECUTABLE" ]]; then
    echo "  ✗ $APP is not installed; run scripts/macos/build-launcher.sh first" >&2
    echo unknown
    return 2
  fi
  local status=0
  "$EXECUTABLE" --check-full-disk-access || status=$?
  return "$status"
}

if [[ "$MODE" == check ]]; then
  check
  exit $?
fi

status=0
check >/dev/null || status=$?
case "$status" in
  0) echo "  ✓ Exocortex Daemon has Full Disk Access"; exit 0 ;;
  2) echo "  ⚠ Could not tell whether Exocortex Daemon has Full Disk Access" >&2; exit 2 ;;
esac

cat <<EOF

  One-time step: give "Exocortex Daemon" Full Disk Access, so macOS stops
  asking about Desktop, Documents, Downloads and other apps' data.

    1. System Settings › Privacy & Security › Full Disk Access
    2. Switch on "Exocortex Daemon". If it is not listed, click + and choose
       $APP
       (in the file dialog, ⌘⇧G and paste the path).
    3. If System Settings offers "Quit & Reopen", choose "Later". The daemon
       has the access from its next restart (exocortexd restart).

EOF

if ((OPEN == 1)) && command -v open >/dev/null 2>&1; then
  open "$SETTINGS_URL" 2>/dev/null && echo "  • Opened System Settings at Full Disk Access" || true
fi

if ((WAIT_SECONDS > 0)) && [[ -t 0 && -t 1 ]]; then
  echo "  • Waiting for the switch (up to $((WAIT_SECONDS / 60)) min; Ctrl+C to skip)…"
  for ((waited = 0; waited < WAIT_SECONDS; waited += 2)); do
    if check >/dev/null 2>&1; then
      echo "  ✓ Exocortex Daemon has Full Disk Access"
      exit 0
    fi
    sleep 2
  done
  echo "  ⚠ Still not granted; re-check later with: $0 check" >&2
fi
exit 1
