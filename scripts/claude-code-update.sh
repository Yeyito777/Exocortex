#!/usr/bin/env bash
# Keep Claude Code (the binary Exocortex's Claude provider runs) on the newest
# native release. It downloads the release, checks its checksum, runs one real
# turn through the Agent SDK with it (daemon/src/providers/anthropic/update-smoke.ts),
# and only then points ~/.local/bin/claude at it. Claude processes started after
# that use the new version; running ones keep theirs. A version that fails the
# check is skipped until a newer one comes out.
#
#   scripts/claude-code-update.sh            # channel "latest" (CLAUDE_UPDATE_CHANNEL=stable for stable)
#
# Exit 0: up to date, updated, a known-bad version skipped, or inconclusive
# (every account at a usage limit; retried next run). Exit 1: a new version
# failed its check or the update broke; the reason is printed. Linux only.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/bun/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"

CHANNEL="${CLAUDE_UPDATE_CHANNEL:-latest}"
BASE="https://downloads.claude.ai/claude-code-releases"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSIONS="$HOME/.local/share/claude/versions"
LINK="$HOME/.local/bin/claude"
LOCKS="$HOME/.local/state/claude/locks"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/claude-code-update"
KEEP=3

mkdir -p "$STATE"
exec 9>"$STATE/lock"
flock -n 9 || { echo "another update is running"; exit 0; }
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$STATE/log"; }

[[ "$(uname -s)" == Linux ]] || { echo "Linux only"; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) log "unsupported architecture $(uname -m)"; exit 1 ;;
esac
platform="linux-$arch"
if [[ -f /lib/libc.musl-x86_64.so.1 || -f /lib/libc.musl-aarch64.so.1 ]] || ldd /bin/ls 2>&1 | grep -q musl; then
  platform="linux-$arch-musl"
fi

target="$(curl -fsSL --max-time 30 "$BASE/$CHANNEL")"
[[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { log "unexpected $CHANNEL version: ${target:0:80}"; exit 1; }
current="$(basename "$(readlink -f "$LINK")")"
[[ "$current" == "$target" ]] && exit 0
# Only ever move forward (a channel can point back, e.g. stable after latest).
[[ "$(printf '%s\n%s\n' "$current" "$target" | sort -V | tail -n1)" == "$target" ]] || exit 0
[[ -e "$STATE/failed-$target" ]] && exit 0

mkdir -p "$VERSIONS"
binary="$VERSIONS/$target"
if [[ ! -x "$binary" ]]; then
  checksum="$(curl -fsSL --max-time 30 "$BASE/$target/manifest.json" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["platforms"][sys.argv[1]]["checksum"])' "$platform")"
  download="$VERSIONS/.$target.download"
  trap 'rm -f "$download"' EXIT
  curl -fsSL --max-time 900 -o "$download" "$BASE/$target/$platform/claude"
  echo "$checksum  $download" | sha256sum -c --quiet - || { log "checksum mismatch for $target"; exit 1; }
  chmod +x "$download"
  mv -f "$download" "$binary"
fi

set +e
check="$(cd "$REPO/daemon" && CLAUDE_CODE_BIN="$binary" timeout 600 bun run src/providers/anthropic/update-smoke.ts 2>&1)"
status=$?
set -e
case $status in
  0) ;;
  3) log "$target: check inconclusive (usage limits), retrying next run"; exit 0 ;;
  *)
    touch "$STATE/failed-$target"
    log "$target FAILED its check, staying on $current: $(tr '\n' ' ' <<<"$check" | tail -c 1500)"
    exit 1 ;;
esac

ln -sfn "$binary" "$LINK.new"
mv -Tf "$LINK.new" "$LINK"
log "updated Claude Code $current -> $target"

# Prune old versions no Claude process still runs, keeping the newest $KEEP.
in_use() {
  local version="$1" lock pid
  for lock in "$LOCKS/$version#"*.lock; do
    [[ -e "$lock" ]] || continue
    pid="${lock##*#}"; pid="${pid%.lock}"
    kill -0 "$pid" 2>/dev/null && return 0
  done
  for pid in /proc/[0-9]*; do
    [[ "$(readlink "$pid/exe" 2>/dev/null)" == "$VERSIONS/$version"* ]] && return 0
  done
  return 1
}
mapfile -t installed < <(find "$VERSIONS" -maxdepth 1 -type f -regex '.*/[0-9]+\.[0-9]+\.[0-9]+' -printf '%f\n' | sort -V)
for ((i = 0; i < ${#installed[@]} - KEEP; i++)); do
  version="${installed[i]}"
  [[ "$version" == "$target" ]] && continue
  in_use "$version" || { rm -f "$VERSIONS/$version"; log "removed old version $version"; }
done
