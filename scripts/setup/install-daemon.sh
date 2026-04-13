#!/usr/bin/env bash
# Install and enable the exocortex daemon as a systemd user service.
# Auto-detects the repo root and bun path — no hardcoded paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
command -v bun >/dev/null 2>&1 || { echo "  ✗ bun not found in PATH"; exit 1; }

# UNIT_NAME is passed by the Makefile; abort if missing.
: "${UNIT_NAME:?UNIT_NAME must be set (e.g. exocortex-daemon.service)}"
UNIT_STEM="${UNIT_NAME%.service}"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" << EOF
[Unit]
Description=Exocortex daemon (exocortexd)

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/daemon
Environment=PATH=$HOME/.local/bin:$HOME/.local/bun/bin:$HOME/.local/rust/cargo/bin:/usr/local/bin:/usr/bin
ExecStart=$REPO_DIR/bin/exocortexd
Restart=on-failure
RestartSec=2
TimeoutStopSec=10

[Install]
WantedBy=default.target
EOF

echo "  Wrote $UNIT_FILE"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_STEM"
echo "  ✓ Installed and enabled $UNIT_NAME"

if ! systemctl --user is-active --quiet "$UNIT_STEM"; then
  systemctl --user start "$UNIT_STEM"
  echo "  ✓ Started $UNIT_NAME"
else
  echo "  • $UNIT_NAME is already running (restart with: systemctl --user restart $UNIT_STEM)"
fi
