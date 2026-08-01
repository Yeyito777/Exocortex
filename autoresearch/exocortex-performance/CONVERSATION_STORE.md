# SQLite conversation-store performance report

Date: 2026-08-01

Raw results: `results/conversation-store-full.json` and
`results/conversation-store-50000-startup.json`

Harness: `conversation-store-benchmark.ts`

Automated gate report: `results/conversation-store-gates.json`

## Result

The agreed gates pass:

- **10,000-conversation startup/list:** 142.81 ms JSON vs 31.77 ms SQLite
  median, a **4.49x speedup** (required: at least 2x).
- **50,000-conversation startup/list:** 737.60 ms JSON vs 176.51 ms SQLite
  median, a **4.18x speedup**.
- **Append to a 10 MiB history:** 12.52 ms vs 0.442 ms, **28.3x faster**.
- **Append to a 50 MiB history:** 62.83 ms vs 0.425 ms, **148.0x faster**.
- **Append to an approximately 100 MiB history (96 MiB fixture):** 132.85 ms
  vs 0.435 ms, **305.7x faster**.
- SQLite append median stayed between 0.425 and 0.493 ms from 1 through 96
  MiB, a maximum/minimum spread of only **1.16x**. Ordinary append cost follows
  the new suffix, not the historical transcript size.
- **Real 24-conversation fixture startup/list:** 0.332 ms JSON vs 1.206 ms
  SQLite. The +0.874 ms median and +0.906 ms p95 are inside the approved low-scale
  allowances of 2 ms median / 5 ms p95.
- **Interactive writes:** metadata p95 was 3.275 ms and a sidebar move p95 was
  0.139 ms, well inside the 50 ms gate.
- The executable gate verifier reports **13 passed, 0 failed**.

## Detailed medians

| Operation | JSON | SQLite | Observation |
|---|---:|---:|---|
| 24-conversation startup/list | 0.332 ms | 1.206 ms | +0.874 ms; passes low-scale absolute gate |
| 10k startup/list | 142.815 ms | 31.772 ms | 4.49x faster |
| 50k startup/list | 737.595 ms | 176.513 ms | 4.18x faster |
| 10k warm full list | 20.921 ms | 29.913 ms | 8.99 ms slower, but not a startup regression and still bounded |
| Find summary by ID | 0.117 ms | 0.057 ms | 2.07x faster |
| Search title | 0.538 ms | 0.323 ms | 1.66x faster via title-only FTS5 |
| Recent page at 10k | N/A | 0.150 ms | indexed page query; no corpus scan |
| Metadata write at 10k | N/A | 3.179 ms | targeted transaction |
| Sidebar move at 10k | N/A | 0.133 ms | targeted ordering rows |
| Real large conversation, recent page | N/A | 1.736 ms | bounded direct page read |
| Real large conversation, all deferred tool outputs | N/A | 46.539 ms | intentionally materializes every requested output for that conversation |

The all-tool-output measurement is not an ordinary page load: it selects and
reconstructs every tool result for a particularly tool-heavy real conversation.
Recent pages do not select those payloads. A future protocol could request tool call
IDs individually if this explicit expansion latency becomes user-visible.

## Storage and memory

- 10,000 synthetic summaries/transcripts: JSON/index files **11,755,917 bytes**;
  SQLite **11,251,712 bytes** after checkpoint, a **0.957x** ratio.
- 50,000 synthetic summaries/transcripts: JSON/index files **59,045,901 bytes**;
  SQLite **55,545,856 bytes** after checkpoint.
- 96 MiB append fixture: JSON **100,665,785 bytes**; SQLite **101,179,392
  bytes**. Separate schema-v6 payload rows eliminate the earlier duplicate
  tool-output copy and keep total storage close to canonical JSON.
- The largest positive SQLite startup/list RSS delta was about **0.14 MiB** at
  10k; the 50k samples showed no positive delta. Warm 10k SQLite listing's largest
  positive delta was about **2.9 MiB**, versus about **4.6 MiB** for JSON. These
  process-level deltas are noisy, but show no transcript-sized residency or
  corpus-wide message parsing.
- `/proc/self/io` often reported zero steady-state physical writes because the OS
  page cache and WAL batching absorbed the measured operation. Logical database/WAL
  size is therefore included and is the more useful storage-amplification signal in
  this run.

## Methodology

- The harness is deterministic and deletes its synthetic temp corpus after a run.
- Large-scale data contains 10,000 conversations, plus a startup-only 50,000-row
  run. Each synthetic conversation has two messages; data spans 20 folders, both
  providers, pinned/marked rows, and varied metadata.
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

Run a short smoke profile, the full profile, the 50k startup profile, and the
executable acceptance gates:

```bash
bun autoresearch/exocortex-performance/conversation-store-benchmark.ts --quick
bun autoresearch/exocortex-performance/conversation-store-benchmark.ts
bun autoresearch/exocortex-performance/conversation-store-benchmark.ts --count 50000 --startup-only --repetitions 7
bun autoresearch/exocortex-performance/verify-conversation-store-gates.ts
```

The commands replace only aggregate result JSON under `results/`. Synthetic
temporary data is removed automatically.
