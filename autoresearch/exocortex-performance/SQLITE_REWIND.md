# SQLite conversation rewind profile

Date: 2026-08-04

Raw aggregate: `results/sqlite-rewind-real-clones.json`

## Result

The user's hypothesis is confirmed. The shipped SQLite `saveUnwind()` is a major
cause of the visible **“Finishing conversation rewind”** window.

For the common operation—editing the latest user message—the current persistence
method took **1.09–2.58 seconds median** on five of the largest main-instance
conversations. A correctness-preserving tail-diff prototype took **19.3–25.7 ms**,
a **47x–133x speedup**. The current method wrote **68.9–117.5 MB** to the WAL for
cuts that removed only **3–59 messages / 136 bytes–156 KB** of canonical content;
the tail prototype wrote **144–235 KB**.

The full idle domain operation was slower still: `conversations.unwindTo()` took
**2.54–5.48 seconds median** for a latest-message edit before any active-stream
abort wait. This directly explains why a person can edit and press Enter before the
correlated rewind completion arrives.

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

- Three independent repetitions per reported case.
- Each repetition began from a fresh file copy of its one-conversation baseline.
- Database copy and initial full conversation load were excluded from timed storage
  operations, matching an already-open conversation in the daemon.
- No conversation had an active stream, so results exclude provider/tool abort delay.
- Every trial checked message truncation, unwind receipt presence, `quick_check`, and
  foreign keys.
- **Current** calls the shipped `SqliteConversationStore.saveUnwind()`.
- **Tail prototype** mutates the loaded conversation to the target suffix boundary,
  uses the repository's existing suffix-diff `save()` path, and writes the unwind
  receipt in the same outer transaction. This is an upper bound for a dedicated
  tail-delete unwind; it still performs shallow prefix comparison/snapshot work.
- Full-domain results call `conversations.unwindTo()` through the canonical SQLite
  persistence facade after preloading the conversation.

## Latest-user-message persistence

| Clone | Retained / removed messages | Retained / removed bytes | Current | Tail prototype | Speedup | Current / tail WAL |
|---|---:|---:|---:|---:|---:|---:|
| largest-1 | 5,409 / 26 | 94.0 MB / 33.5 KB | 2,577 ms | 21.4 ms | 120.3x | 117.5 MB / 165 KB |
| largest-2 | 2,681 / 3 | 90.8 MB / 136 B | 2,565 ms | 19.3 ms | 132.8x | 102.3 MB / 235 KB |
| largest-3 | 8,866 / 59 | 63.7 MB / 155.5 KB | 1,905 ms | 25.6 ms | 74.5x | 101.0 MB / 181 KB |
| largest-4 | 9,611 / 14 | 61.8 MB / 130.8 KB | 1,858 ms | 25.7 ms | 72.4x | 101.3 MB / 169 KB |
| largest-5 | 7,996 / 22 | 34.9 MB / 14.8 KB | 1,093 ms | 23.0 ms | 47.4x | 68.9 MB / 144 KB |

The current time follows the **retained prefix**. The prototype time follows the
**removed suffix**, which is the desired scaling law for an edit rewind.

## Earlier cuts

| Clone | Cut | Retained / removed bytes | Current | Tail prototype | Speedup |
|---|---|---:|---:|---:|---:|
| largest-1 | 90% user boundary | 92.9 MB / 1.1 MB | 2,713 ms | 34.7 ms | 78.3x |
| largest-4 | 90% user boundary | 60.0 MB / 2.0 MB | 1,777 ms | 46.0 ms | 38.6x |
| largest-1 | Half user boundary | 19.8 MB / 74.2 MB | 1,752 ms | 649.5 ms | 2.7x |
| largest-4 | Half user boundary | 29.4 MB / 32.5 MB | 2,110 ms | 383.4 ms | 5.5x |

Large early cuts legitimately cost more because SQLite must delete tens of megabytes
of suffix rows and cascading blobs. They still avoid rewriting the retained prefix.

## Full idle-domain latency

| Clone | `unwindTo()` median | p95 |
|---|---:|---:|
| largest-1 | 5,482 ms | 7,031 ms |
| largest-2 | 4,188 ms | 4,232 ms |
| largest-3 | 4,111 ms | 4,146 ms |
| largest-4 | 4,162 ms | 4,183 ms |
| largest-5 | 2,544 ms | 2,563 ms |

These values contain no stream abort/finalizer wait. Editing during an active response
can add further latency, up to the existing ten-second safety timeout.

## CPU profile

A 500 µs sampled CPU profile of the latest-message domain rewind on `largest-1`
reported 6.27 seconds inside `unwindTo()` under profiler overhead:

- `saveUnwind`: **3.79 s / 54.1%**
- active-context validation: **1.44 s / 20.5%**
- `historyPrefixHashes`: **1.42 s / 20.2%**
- copying retained loaded-state snapshots: **816 ms / 11.6%**
- display reconstruction/fingerprints and repeated active-context boundary work make
  up much of the remaining time

Across the process, native `JSON.stringify` was **47.8% self time**, SQLite statement
execution was **24.0%**, and crypto hash updates were **18.4%**. Percentages in nested
call-tree entries overlap and must not be summed.

The storage transaction is the largest single problem, but it is not the only one:
active-context validation and prefix hashing repeatedly serialize/hash large retained
tool payloads.

## Root cause

The shipped method performs:

1. `DELETE FROM messages WHERE conversation_id=?`
2. reinsertion of every retained message and separated blob
3. full display projection rebuild
4. full retained-message snapshots

The generic repository `save()` path already knows how to delete and rebuild only a
changed suffix, but `saveUnwind()` does not use it and ignores its
`_targetHistoryCount` argument.

## Recommended optimization target

1. Make `saveUnwind()` delete only `sequence >= cutSequence`, preserving prefix
   message/blob rows.
2. Rebuild only the display suffix at the affected user boundary.
3. Update content/message/display counts and the unwind receipt in one transaction.
4. Preserve the active context without repeatedly rehashing an already validated
   immutable prefix; hash only the changed boundary when required.
5. Avoid generating all user unwind fingerprints merely to calculate
   `historyTotalEntries`.
6. Add this real-clone profile plus deterministic synthetic 1/10/50/100 MB rewind
   gates to the performance suite.
7. Separately improve the TUI protocol so a submit during the safety window is queued
   or rewind-plus-replacement is one command.

A reasonable idle latest-edit gate is **<50 ms median** for these real clones and WAL
traffic proportional to the removed suffix, not the retained history.
