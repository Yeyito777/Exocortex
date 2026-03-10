#!/usr/bin/env bash
# Restart the exocortex daemon to pick up code changes.
set -euo pipefail

systemctl --user restart exocortex-daemon
sleep 0.5

systemctl --user status exocortex-daemon --no-pager
