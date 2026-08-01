# SQLite conversation-store performance report

Date: 2026-08-01

Raw result: `results/conversation-store-full.json`

Harness: `conversation-store-benchmark.ts`

## Result

The agreed gates pass:

- **10,000-conversation startup/list:** 90.11 ms JSON vs 19.22 ms SQLite
  median, a **4.69x speedup** (required: at least 2x).
- **Append to a 10 MiB history:** 9.35 ms vs 0.283 ms, **33.0x faster**.
- **Append to a 50 MiB history:** 38.07 ms vs 0.274 ms, **138.8x faster**.
- **Append to an approximately 100 MiB history (96 MiB fixture):** 72.28 ms
  vs 0.275 ms, **263.0x faster**.
- SQLite append median stayed between 0.275 and 0.346 ms from 1 through 96
  MiB. This confirms that ordinary append cost follows the new suffix, not the
  historical transcript size.
- **Real 24-conversation fixture startup/list:** 0.292 ms JSON vs 0.759 ms
  SQLite. The +0.467 ms median and +0.501 ms p95 are inside the approved low-scale
  allowances of 2 ms median / 5 ms p95.
- **Interactive writes:** metadata p95 was 2.44 ms and a sidebar move p95 was
  0.078 ms, well inside the 50 ms gate.

## Detailed medians

| Operation | JSON | SQLite | Observation |
|---|---:|---:|---|
| 24-conversation startup/list | 0.292 ms | 0.759 ms | +0.467 ms; passes low-scale absolute gate |
| 10k startup/list | 90.109 ms | 19.222 ms | 4.69x faster |
| 10k warm full list | 13.067 ms | 17.056 ms | 3.99 ms slower, but not a startup regression and still bounded |
| Find summary by ID | 0.058 ms | 0.039 ms | 1.46x faster |
| Search title | 0.309 ms | 0.204 ms | 1.51x faster via title-only FTS5 |
| Recent page at 10k | N/A | 0.080 ms | indexed page query; no corpus scan |
| Metadata write at 10k | N/A | 2.370 ms | targeted transaction |
| Sidebar move at 10k | N/A | 0.075 ms | targeted ordering rows |
| Real large conversation, recent page | N/A | 1.088 ms | bounded direct page read |
| Real large conversation, all deferred tool outputs | N/A | 31.036 ms | intentionally materializes every requested output for that conversation |

The all-tool-output measurement is not an ordinary page load: it selects and
reconstructs every tool result for a particularly tool-heavy real conversation.
Recent pages do not select those payloads. A future protocol could request tool call
IDs individually if this explicit expansion latency becomes user-visible.

## Storage and memory

- 10,000 synthetic summaries/transcripts: JSON/index files **11,755,917 bytes**;
  SQLite **11,251,712 bytes** after checkpoint.
- 96 MiB append fixture: JSON **100,665,785 bytes**; SQLite **101,179,392
  bytes**. Separate schema-v6 payload rows eliminate the earlier duplicate
  tool-output copy and keep total storage close to canonical JSON.
- 10k SQLite startup/list's largest measured RSS delta was about **3 MiB**. Warm
  SQLite listing's largest positive delta was about **0.2 MiB**, versus about
  **4.7 MiB** for JSON. These are process-level deltas and noisy, but they show no
  transcript-sized residency or corpus-wide message parsing.
- `/proc/self/io` often reported zero steady-state physical writes because the OS
  page cache and WAL batching absorbed the measured operation. Logical database/WAL
  size is therefore included and is the more useful storage-amplification signal in
  this run.

## Methodology

- The harness is deterministic and deletes its synthetic temp corpus after a run.
- Large-scale data contains 10,000 conversations, two messages each, 20 folders,
  both providers, pinned/marked rows, and varied metadata.
- Large append data uses 1, 10, 50, and 96 MiB historical messages followed by one
  small appended message.
- Low scale uses the 24 safely copied, gitignored real fixtures and commits no
  transcript content or title.
- Setup/import time is excluded from steady-state measurements.
- Each operation receives three warmups, then seven measured repetitions. Results
  include wall time, CPU, RSS delta, and Linux I/O counters and report median, p95,
  and max.
- Startup closes/reopens SQLite on each repetition. The JSON baseline reproduces
  the legacy `loadConversationIndex` behavior: parse the pretty JSON index,
  enumerate/stat canonical files, and probe `.sidebar`/`.unwind` overlays.
- Both backends are measured warm in the same process and on the same machine. This
  report does not claim uncached-disk numbers; forcing global cache eviction would
  disturb the user's machine and make the comparison less reproducible.
- The benchmark uses the final schema and implementation. The legacy algorithm is
  self-contained in the harness so it remains runnable after the source adapter is
  retired.

## Reproduce

First create/import the isolated fixture (never point this at main for destructive
work):

```bash
bun scripts/dev/sqlite-conversation-fixture.ts verify
bun scripts/dev/verify-sqlite-conversation-migration.ts
```

Run a short smoke profile or the full profile:

```bash
bun autoresearch/exocortex-performance/conversation-store-benchmark.ts --quick
bun autoresearch/exocortex-performance/conversation-store-benchmark.ts
```

The commands replace only the aggregate `conversation-store-quick.json` or
`conversation-store-full.json` result under this directory. Synthetic temporary
data is removed automatically.
