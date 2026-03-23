#!/usr/bin/env bash
# Install and enable the exocortex daemon as a systemd user service.
# Auto-detects the repo root and bun path — no hardcoded paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BUN_PATH="$(command -v bun)" || { echo "  ✗ bun not found in PATH"; exit 1; }

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/exocortex-daemon.service"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" << EOF
[Unit]
Description=Exocortex daemon (exocortexd)

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/daemon
ExecStart=$BUN_PATH run src/main.ts
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

echo "  Wrote $UNIT_FILE"

systemctl --user daemon-reload
echo "  Reloaded systemd user units"

systemctl --user enable --now exocortex-daemon
echo "  Enabled and started exocortex-daemon"
echo ""

systemctl --user status exocortex-daemon --no-pager
