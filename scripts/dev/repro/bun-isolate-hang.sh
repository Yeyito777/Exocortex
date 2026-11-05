#!/usr/bin/env bash
# bun-isolate-hang — reproduce bun 1.4.2 wedging a `bun test --parallel` worker.
#
# Usage:
#   scripts/dev/repro/bun-isolate-hang.sh [RUNS (default 12)] [--first]
#
# Runs the TUI suite as plain `bun test --parallel=8` (no timings: files go to
# workers in alphabetical chunks, so tui/src/updatecheck.test.ts runs after
# other files in its worker) until a run outlives 20 s. For the stuck worker it
# prints the files it ran, its threads (the main thread spins in R state) and
# its unreaped children (finished `git` processes left <defunct>), then kills
# the run's session. --first pins updatecheck.test.ts as a worker's first file,
# as `bun run check` does (scripts/dev/check.ts FIRST_IN_FRESH_WORKER): no hang.
# Seen on whale (12 cores): ~4 of 5 plain runs hang; 0 of 10 with --first, 0 of
# 8 with --no-isolate.

set -uo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)"
RUNS="${1:-12}"
FIRST="${2:-}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/bun-isolate-hang.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# A second preload logs which file each worker starts (isolated files rerun preloads).
cat > "$WORK/log-file.ts" <<TS
require("fs").appendFileSync("$WORK/starts.log", \`\${process.pid} \${Bun.main}\n\`);
TS
TIMINGS=()
if [[ "$FIRST" == "--first" ]]; then
  echo '{"version":1,"files":{"src/updatecheck.test.ts":99999999}}' > "$WORK/first.json"
  TIMINGS=(--timings="$WORK/first.json")
fi

cd "$ROOT/tui"
for i in $(seq 1 "$RUNS"); do
  rm -f "$WORK/starts.log"
  setsid bun test --parallel=8 --preload ../test/setup-config.ts --preload "$WORK/log-file.ts" "${TIMINGS[@]}" \
    > "$WORK/run.txt" 2>&1 &
  pid=$!
  for _ in $(seq 1 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "run $i: finished ($(grep -E '^ [0-9]+ fail$' "$WORK/run.txt" | xargs))"
    continue
  fi
  echo "run $i: HUNG"
  for w in $(ps -s "$pid" -o pid=,pcpu= | awk '$2 > 50 { print $1 }'); do
    echo "  worker $w ran: $(grep "^$w " "$WORK/starts.log" | awk '{print $2}' | sed 's|.*/tui/||' | tr '\n' ' ')"
    for t in /proc/"$w"/task/*; do echo "    thread $(basename "$t") $(awk '{print $2, $3}' "$t/stat")"; done
  done
  ps -s "$pid" -o pid=,stat=,args= | awk '$2 ~ /Z/ { print "  unreaped child:", $0 }'
  pkill -KILL -s "$pid"
  exit 1
done
echo "no hang in $RUNS runs"
