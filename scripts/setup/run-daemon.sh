#!/usr/bin/env bash
# Shared daemon launcher for direct CLI runs and the systemd user service.
# Keeping dependency hydration here avoids service crash loops after pulling
# new code that adds workspace dependencies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

cd "$PROJECT_DIR"
bun install --frozen-lockfile

cd "$PROJECT_DIR/daemon"
exec bun run src/main.ts "$@"
