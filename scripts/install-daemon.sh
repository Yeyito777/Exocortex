#!/usr/bin/env bash
# Install and enable the exocortex daemon as a systemd user service.
set -euo pipefail

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/exocortex-daemon.service"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" << 'EOF'
[Unit]
Description=Exocortex daemon (exocortexd)

[Service]
Type=simple
WorkingDirectory=%h/Workspace/Exocortex/daemon
ExecStart=%h/.local/bun/bin/bun run src/main.ts
Restart=on-failure
RestartSec=2

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
