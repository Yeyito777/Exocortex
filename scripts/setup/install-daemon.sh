#!/usr/bin/env bash
# Install and enable the exocortex daemon as a systemd user service.
# Auto-detects the repo root and bun path — no hardcoded paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
command -v bun >/dev/null 2>&1 || { echo "  ✗ bun not found in PATH"; exit 1; }
BUN_BIN="$(command -v bun)"
BUN_DIR="$(dirname "$BUN_BIN")"

# UNIT_NAME is passed by the Makefile; abort if missing.
: "${UNIT_NAME:?UNIT_NAME must be set (e.g. exocortex-daemon.service)}"
UNIT_STEM="${UNIT_NAME%.service}"

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME"
# The instance's own socket (long paths fall back to a short one), not one
# inherited from a calling Exocortex shell.
SOCKET_FILE="$(env -u EXOCORTEX_SOCKET "$REPO_DIR/bin/exocortexd" socket)"

wait_for_socket() {
  for _ in $(seq 1 100); do
    if [ -S "$SOCKET_FILE" ]; then
      echo "  ✓ Daemon socket ready"
      return 0
    fi
    sleep 0.2
  done
  echo "  ⚠ Started service, but daemon socket is not ready yet: $SOCKET_FILE"
  echo "    Check: systemctl --user status $UNIT_NAME --no-pager"
  return 1
}

mkdir -p "$UNIT_DIR"

# Restart=always: any exit that isn't a requested stop comes back in 2s, also
# the clean exit 0 after a stray SIGTERM (which replays its interrupted turns).
# `exocortexd stop` is `systemctl stop`, which systemd never restarts; exit 78
# (configuration error) stays down too.
cat > "$UNIT_FILE" << EOF
[Unit]
Description=Exocortex daemon (exocortexd)

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/daemon
Environment=PATH=$HOME/.local/bin:$BUN_DIR:$HOME/.bun/bin:$HOME/.local/bun/bin:$HOME/.local/rust/cargo/bin:/usr/local/bin:/usr/bin
ExecStart=$REPO_DIR/bin/exocortexd
Restart=always
RestartPreventExitStatus=78
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
  rm -f "$SOCKET_FILE"
  systemctl --user start "$UNIT_STEM"
  echo "  ✓ Started $UNIT_NAME"
  wait_for_socket
else
  echo "  • $UNIT_NAME is already running (restart with: systemctl --user restart $UNIT_STEM)"
  wait_for_socket || true
fi
