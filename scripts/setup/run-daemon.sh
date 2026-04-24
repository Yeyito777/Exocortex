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
      systemctl --user restart exocortex-daemon.service

EOF
  exit 78
}

install_dependencies

cd "$PROJECT_DIR/daemon"
exec bun run src/main.ts "$@"
