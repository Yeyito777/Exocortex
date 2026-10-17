#!/usr/bin/env bash
# build-launcher.sh — build, sign and install the macOS daemon launcher.
#
# Builds macos/launcher into "Exocortex Daemon.app", signs it with a stable
# identity, and points the com.exocortex.daemon LaunchAgent at it so TCC
# privacy consents belong to the app instead of Homebrew's ad-hoc signed bash.
# Idempotent; bun is resolved when the daemon starts, so Homebrew upgrades
# need no rebuild. See README.md › macOS › Daemon launcher.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SRC_DIR="$REPO_DIR/macos/launcher"
LABEL="${EXOCORTEX_LAUNCHD_LABEL:-com.exocortex.daemon}"
BUNDLE_ID="dev.yeyito.exocortex.daemon"
EXECUTABLE_NAME="exocortex-daemon"

APP="$HOME/Applications/Exocortex Daemon.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
IDENTITY="${EXOCORTEX_CODESIGN_IDENTITY:-}"
ADHOC=0
UPDATE_PLIST=1
RELOAD=0

usage() {
  cat <<EOF
Usage: scripts/macos/build-launcher.sh [options]

  --app PATH        App bundle to install (default: $APP)
  --identity ID     codesign identity: SHA-1 hash or name (default: first
                    "Apple Development" or "Developer ID Application" identity;
                    also EXOCORTEX_CODESIGN_IDENTITY)
  --adhoc           Sign ad-hoc (privacy prompts will keep coming back)
  --no-plist        Do not touch the LaunchAgent plist
  --reload          Reload the LaunchAgent now (graceful restart with replay)
  -h, --help        Show this help
EOF
}

while (($# > 0)); do
  case "$1" in
    --app) APP="${2:?--app needs a path}"; shift ;;
    --identity) IDENTITY="${2:?--identity needs a value}"; shift ;;
    --adhoc) ADHOC=1 ;;
    --no-plist) UPDATE_PLIST=0 ;;
    --reload) RELOAD=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "  ✗ Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

APP="${APP%/}"
EXECUTABLE="$APP/Contents/MacOS/$EXECUTABLE_NAME"
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"

die() { echo "  ✗ $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "build-launcher.sh only runs on macOS"
for tool in clang codesign plutil security launchctl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (install Xcode or the command-line tools)"
done
if ((UPDATE_PLIST == 1 || RELOAD == 1)); then
  command -v bun >/dev/null 2>&1 || die "bun not found in PATH"
fi

# A reload stops the daemon; from inside its own job it would kill this script
# between bootout and bootstrap and leave the daemon unloaded.
if ((RELOAD == 1)) && [[ "${XPC_SERVICE_NAME:-}" == "$LABEL" ]]; then
  die "--reload must not run from inside the daemon (a turn or tool); run it from a terminal"
fi

# ── Signing identity ─────────────────────────────────────────────────

pick_identity() {
  # Lines look like:  1) <SHA-1> "Apple Development: Name (TEAMID)"
  security find-identity -v -p codesigning 2>/dev/null \
    | awk '/"(Apple Development|Developer ID Application): / { print $2; exit }'
}

identity_label() {
  security find-identity -v -p codesigning 2>/dev/null | awk -v id="$1" '$2 == id { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }'
}

if ((ADHOC == 1)); then
  IDENTITY="-"
elif [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(pick_identity)"
fi
if [[ -z "$IDENTITY" || "$IDENTITY" == "-" ]]; then
  IDENTITY="-"
  cat >&2 <<'EOF'

  ⚠ ─────────────────────────────────────────────────────────────────────
  ⚠ No "Apple Development" or "Developer ID Application" signing identity.
  ⚠ Signing AD-HOC: macOS has no stable identity to remember consent for,
  ⚠ so privacy prompts WILL keep coming back after rebuilds.
  ⚠ Fix: sign in to Xcode › Settings › Accounts and create an
  ⚠ "Apple Development" certificate, then re-run this script.
  ⚠ ─────────────────────────────────────────────────────────────────────

EOF
fi

# ── Build ────────────────────────────────────────────────────────────

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
STAGE_APP="$STAGE/$(basename "$APP")"
mkdir -p "$STAGE_APP/Contents/MacOS"

clang -std=c11 -O2 -Wall -Wextra -Werror -mmacosx-version-min=13.0 \
  "$SRC_DIR/launcher.c" -o "$STAGE_APP/Contents/MacOS/$EXECUTABLE_NAME"
cp "$SRC_DIR/Info.plist" "$STAGE_APP/Contents/Info.plist"
printf 'APPL????' > "$STAGE_APP/Contents/PkgInfo"
plutil -lint -s "$STAGE_APP/Contents/Info.plist"
echo "  ✓ Built $(basename "$APP")"

# Hardened runtime is off: the launcher only spawns bash/bun and needs no
# entitlements. The identifier pins the designated requirement TCC stores.
codesign --force --sign "$IDENTITY" --identifier "$BUNDLE_ID" --timestamp=none "$STAGE_APP"
codesign --verify --strict --verbose=1 "$STAGE_APP"
if [[ "$IDENTITY" == "-" ]]; then
  echo "  ⚠ Signed ad-hoc"
else
  echo "  ✓ Signed with ${IDENTITY} $(identity_label "$IDENTITY")"
fi

# Move rather than overwrite: a running launcher keeps its old, still-valid
# image instead of being killed for a modified signed executable.
mkdir -p "$(dirname "$APP")"
rm -rf "$APP.previous"
[[ -e "$APP" ]] && mv "$APP" "$APP.previous"
mv "$STAGE_APP" "$APP"
rm -rf "$APP.previous"
echo "  ✓ Installed $APP"

# ── LaunchAgent ──────────────────────────────────────────────────────

if ((UPDATE_PLIST == 1)); then
  mkdir -p "$REPO_DIR/config/runtime"
  if [[ -f "$PLIST" ]] && [[ "$(head -c 6 "$PLIST")" == "bplist" ]]; then
    plutil -convert xml1 "$PLIST"
  fi
  backup_dir="$REPO_DIR/config/runtime/launchd/backups"
  result="$(bun "$SCRIPT_DIR/launchagent.ts" --plist "$PLIST" --executable "$EXECUTABLE" \
    --repo "$REPO_DIR" --bun-dir "$(dirname "$(command -v bun)")" --label "$LABEL" --backup-dir "$backup_dir")"
  if ! plutil -lint -s "$PLIST"; then
    # Backups are ISO-timestamped, so the glob's last match is the newest.
    latest=""
    for backup in "$backup_dir/$(basename "$PLIST")".*.bak; do [[ -f "$backup" ]] && latest="$backup"; done
    [[ -n "$latest" ]] && cp "$latest" "$PLIST" && echo "  • Restored $latest" >&2
    die "rewritten LaunchAgent failed plutil -lint"
  fi
  case "$result" in
    created) echo "  ✓ Wrote $PLIST" ;;
    updated) echo "  ✓ Pointed $PLIST at the launcher (backup in $backup_dir)" ;;
    *) echo "  • $PLIST already runs the launcher" ;;
  esac
fi

if ((RELOAD == 0)); then
  cat <<EOF

  Next steps (from a terminal, not from an Exocortex turn):
    1. Optional, avoids every prompt: System Settings › Privacy & Security ›
       Full Disk Access › + › $APP
    2. Reload the LaunchAgent (graceful; active conversations replay):
         $SCRIPT_DIR/build-launcher.sh --reload
       or by hand:
         (cd "$REPO_DIR/daemon" && bun run src/control-cli.ts prepare-restart)
         launchctl bootout $TARGET
         launchctl bootstrap $DOMAIN "$PLIST"
    3. Check: launchctl print $TARGET | grep -E 'program|state|pid'
              exocortexd status

EOF
  exit 0
fi

# ── Reload ───────────────────────────────────────────────────────────

if launchctl print "$TARGET" 2>/dev/null | grep -q "state = running"; then
  # Same preparation as `exocortexd restart`: interrupt streams for replay.
  if ids="$(cd "$REPO_DIR/daemon" && bun run src/control-cli.ts prepare-restart)"; then
    [[ -n "$ids" ]] && echo "  • Interrupted and scheduled replay: $(paste -sd, - <<< "$ids")"
  else
    echo "  ⚠ Could not prepare conversations for replay; reloading anyway" >&2
  fi
fi
launchctl bootout "$TARGET" 2>/dev/null || true
for _ in {1..100}; do
  launchctl print "$TARGET" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$TARGET" 2>/dev/null || true

for _ in {1..100}; do
  if launchctl print "$TARGET" 2>/dev/null | grep -q "state = running"; then
    echo "  ✓ Reloaded $LABEL"
    launchctl print "$TARGET" | grep -E '^\s*(program|state|pid) = ' || true
    exit 0
  fi
  sleep 0.1
done
die "LaunchAgent did not reach running state; check: launchctl print $TARGET"
