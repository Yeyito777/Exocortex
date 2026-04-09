#!/usr/bin/env bash
# Migrate config from ~/.config/exocortex/ into the repo at config/.
#
# After this migration:
#   - Config lives at <repo>/config/ (self-contained)
#   - ~/.config/exocortex is a symlink to <repo>/config/ (XDG compat)
#   - All path resolution uses import.meta.dir (survives mv)
#
# Safe to run multiple times — skips steps that are already done.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
REPO_CONFIG="$REPO_DIR/config"
XDG_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/exocortex"

echo "Repo:       $REPO_DIR"
echo "Config dir: $REPO_CONFIG"
echo ""

# Step 1: Ensure config exists in the repo
if [ ! -d "$REPO_CONFIG" ]; then
  if [ -d "$XDG_CONFIG" ] && [ ! -L "$XDG_CONFIG" ]; then
    echo "Moving $XDG_CONFIG → $REPO_CONFIG ..."
    mv "$XDG_CONFIG" "$REPO_CONFIG"
  else
    echo "✗ No config dir found at $XDG_CONFIG or $REPO_CONFIG"
    exit 1
  fi
fi
echo "✓ Config dir at $REPO_CONFIG"

# Step 2: Symlink from XDG location
if [ -L "$XDG_CONFIG" ]; then
  current_target="$(readlink "$XDG_CONFIG")"
  if [ "$current_target" = "$REPO_CONFIG" ]; then
    echo "✓ Symlink already exists: $XDG_CONFIG → $REPO_CONFIG"
  else
    echo "⚠ Symlink exists but points to $current_target — updating"
    rm "$XDG_CONFIG"
    ln -s "$REPO_CONFIG" "$XDG_CONFIG"
    echo "✓ Symlink updated"
  fi
elif [ -d "$XDG_CONFIG" ]; then
  echo "⚠ $XDG_CONFIG is still a real directory — replacing with symlink"
  rm -rf "$XDG_CONFIG"
  ln -s "$REPO_CONFIG" "$XDG_CONFIG"
  echo "✓ Symlink created"
else
  ln -s "$REPO_CONFIG" "$XDG_CONFIG"
  echo "✓ Symlink created: $XDG_CONFIG → $REPO_CONFIG"
fi

# Step 3: Restart daemon
echo ""
echo "Restarting daemon ..."
systemctl --user restart exocortex-daemon
sleep 1
systemctl --user status exocortex-daemon --no-pager
