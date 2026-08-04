# SQLite conversation rewind optimization

Date: 2026-08-04

Raw aggregate: `results/sqlite-rewind-real-clones.json`

## Result

The initial profile confirmed the user's hypothesis: the shipped SQLite rewind was a
major cause of the visible **“Finishing conversation rewind”** window. Editing the
latest user message spent **1.09–2.58 seconds** in `saveUnwind()` and **2.54–5.48
seconds** in the complete idle `conversations.unwindTo()` operation.

The optimized implementation now:

- deletes only `messages.sequence >= cutSequence`, allowing foreign-key cascades to
  remove only doomed tool/image payloads;
- preserves every immutable prefix message/blob row and its loaded-state snapshot;
- rebuilds only the affected display suffix;
- updates content/message/display counts, active context, queue tombstones, and the
  unwind receipt in one transaction;
- uses the indexed target-user display boundary instead of reconstructing the full
  display merely to count retained entries;
- reuses cached active-context validation and the target user's atomically persisted
  context checkpoint instead of repeatedly serializing/hashing the retained prefix;
- preserves a lagging but valid compact replay when the cut removes only canonical
  history it has not represented, without rewriting that potentially large payload;
- caches the safely derived rewound context for the next submission; and
- requires no schema migration.

After optimization, latest-edit persistence is **11.8–17.0 ms median** and complete
idle domain latency is **16.1–30.0 ms median / 22.9–34.4 ms p95** across the same five
real clones. Persistence improved **68x–218x**, end-to-end rewind improved
**100x–340x**, and WAL traffic fell from **68.9–117.5 MB** to **136–223 KB**.

## Safe real-clone fixture

The five largest live, goal-free conversations were selected from main, excluding
the profiling conversation. They were copied using SQLite reads into five separate,
gitignored worktree databases. Original IDs, titles, transcripts, database files,
and raw profiles remain under ignored worktree data and are not committed.

| Label | Canonical content | Stored messages | Blob payload | Real user messages | Active context |
|---|---:|---:|---:|---:|---:|
| largest-1 | 94.0 MB | 5,435 | 90.7 MB | 121 | yes |
| largest-2 | 90.8 MB | 2,684 | 89.1 MB | 64 | yes |
| largest-3 | 63.8 MB | 8,925 | 58.8 MB | 513 | yes |
| largest-4 | 62.0 MB | 9,625 | 56.8 MB | 574 | yes |
| largest-5 | 34.9 MB | 8,018 | 30.7 MB | 514 | yes |

No main conversation, database row, runtime file, automation state, or Git file was
modified. Main remained healthy during and after cloning/profiling.

## Methodology

- Three independent repetitions per reported case before and after the change.
- Each repetition began from a fresh file copy of its one-conversation baseline.
- Database copy and initial full conversation load were excluded, matching an
  already-open conversation in the daemon.
- No conversation had an active stream, so results exclude provider/tool abort delay.
- Every trial checked message truncation, unwind receipt presence, `quick_check`, and
  foreign keys.
- Storage trials call `SqliteConversationStore.saveUnwind()` directly.
- Full-domain trials call `conversations.unwindTo()` through the canonical SQLite
  facade after preloading the conversation.
- The pre-change tail-diff prototype used the repository's generic suffix save plus
  a receipt in one outer transaction. It established the expected scaling law before
  production code changed.

## Latest-user-message persistence

This is the common edit case: retain nearly all history and remove a tiny final suffix.

| Clone | Removed messages / bytes | Before | After | Speedup | WAL before / after |
|---|---:|---:|---:|---:|---:|
| largest-1 | 26 / 33.5 KB | 2,577 ms | 11.8 ms | 218.1x | 117.5 MB / 157 KB |
| largest-2 | 3 / 136 B | 2,565 ms | 14.2 ms | 180.8x | 102.3 MB / 223 KB |
| largest-3 | 59 / 155.5 KB | 1,905 ms | 17.0 ms | 111.9x | 101.0 MB / 173 KB |
| largest-4 | 14 / 130.8 KB | 1,858 ms | 15.7 ms | 118.6x | 101.3 MB / 161 KB |
| largest-5 | 22 / 14.8 KB | 1,093 ms | 16.0 ms | 68.3x | 68.9 MB / 136 KB |

The optimized dedicated method is faster than the original generic tail prototype
because it knows the exact cut boundary and reuses prefix snapshots rather than
shallow-comparing/snapshotting every retained message.

## Full idle-domain latency

| Clone | Before median | After median | After p95 | Speedup |
|---|---:|---:|---:|---:|
| largest-1 | 5,482 ms | 16.1 ms | 24.1 ms | 340.1x |
| largest-2 | 4,188 ms | 21.4 ms | 22.9 ms | 196.0x |
| largest-3 | 4,111 ms | 30.0 ms | 32.2 ms | 137.0x |
| largest-4 | 4,162 ms | 26.0 ms | 33.9 ms | 160.2x |
| largest-5 | 2,544 ms | 25.5 ms | 34.4 ms | 99.7x |

These results contain no stream abort/finalizer wait. Editing during an active response
still must wait for that writer to release the conversation; that is a separate,
necessary correctness boundary.

## CPU profiles

Before optimization, a 500 µs sampled profile of `largest-1` reported 6.27 seconds
inside `unwindTo()` under profiler overhead:

- `saveUnwind`: **3.79 s / 54.1%**
- active-context validation: **1.44 s / 20.5%**
- `historyPrefixHashes`: **1.42 s / 20.2%**
- retained loaded-state snapshots: **816 ms / 11.6%**
- process self-time: `JSON.stringify` **47.8%**, SQLite execution **24.0%**, crypto
  updates **18.4%**

After the final optimization, a 250 µs profile measured **31.1 ms** inside
`unwindTo()` and **19.4 ms** in `saveUnwind` under profiler overhead. No retained-prefix
hashing appeared beneath `unwindTo`; the large hash visible in the process profile was
the deliberately excluded, one-time conversation-load validation. Nested profile
percentages overlap and are not summed.

## Correctness and regression gates

The optimized path retains all existing transaction/fault semantics. New direct
coverage installs temporary message-row triggers and proves that an unwind:

- deletes exactly the tail sequences;
- inserts no prefix message rows;
- leaves a large retained blob row byte-identical;
- preserves display, receipt, generation, and integrity behavior; and
- rolls back conversation, message, payload, display, queue, and receipt state at each
  injected transaction boundary.

The post-change targeted SQLite matrix passes **185 tests, 9 intentional JSON-file
skips, 0 failures**. Root typecheck and the JSON/domain contract suite also pass.

## Remaining UX follow-up

The performance cause of the ordinary idle warning window is resolved: 16–30 ms is
shorter than normal human edit-and-submit time. A warning may still legitimately
appear when editing while a provider/tool stream is being aborted. Separately, the
protocol could queue an Enter pressed during that abort window or combine rewind and
replacement submission into one command; that is a UX improvement rather than a
storage-performance requirement.
