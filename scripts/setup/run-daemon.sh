#!/usr/bin/env bash
# Shared daemon launcher for direct CLI runs and the systemd user service.
# Keeping dependency hydration here avoids service crash loops after pulling
# new code that adds workspace dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

cd "$PROJECT_DIR"

install_dependencies() {
  if bun install --frozen-lockfile; then
    return 0
  fi

  cat >&2 <<EOF
  ✗ Dependency install failed during daemon startup.

    The daemon will not be restarted automatically for this configuration error.

    To repair:
      cd $PROJECT_DIR
      bun install
      exocortexd restart

EOF
  exit 78
}

install_dependencies

cd "$PROJECT_DIR/daemon"
if (($# > 0)); then
  exec bun run src/main.ts "$@"
fi

# The daemon itself is labelled so a pattern kill aimed at a test daemon
# (`pkill -f "bun run src/main.ts"`) can't match it: argv[0] names the instance,
# the entry point is absolute and `--instance` repeats it. A linked worktree's
# daemon is `exocortexd-test:<worktree>`; the primary checkout's is
# `exocortexd-main`. Stop daemons by PID, never by pattern (docs/dev-daemons.md).
if [[ -f "$PROJECT_DIR/.git" ]]; then
  INSTANCE="$(basename "$PROJECT_DIR")"
  exec -a "exocortexd-test:$INSTANCE" bun run "$PROJECT_DIR/daemon/src/main.ts" --instance "$INSTANCE"
fi
exec -a exocortexd-main bun run "$PROJECT_DIR/daemon/src/main.ts" --instance main
