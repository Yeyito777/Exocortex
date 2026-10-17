# Daemon performance and resource audit (October 2026)

Branch `audit-daemon-perf`, from `d0c8a1de`. Scope: daemon event loop,
SQLite persistence, conversation load/save and display pages, memory,
startup, background timers, token stats, and provider streaming. TUI
rendering, wire protocol and correctness are covered by other audits.

## Method

- **Live evidence (read-only).** I read the `perf:` lines in
  `config/runtime/exocortex.log*` (event-loop lag, opens, history, runtime
  loads) and the daemon's `/proc/<pid>/{io,status}`.
- **DB snapshot.** `VACUUM INTO` produced a consistent copy of the 7.9 GB live
  DB. `sqlite3 .backup` never finishes against a busy writer because it
  restarts on every source change.
- **Real code paths, real data.** Benchmarks drove the real
  `conversations`/`persistence`/`orchestrator` modules against that copy,
  using an `EXOCORTEX_CONFIG_DIR` temp root:
  - a round simulator (append tool rounds, as the orchestrator does);
  - a whole `orchestrateSendMessage` with an instant fake provider;
  - cold `getAsync` with a main-thread stall probe;
  - per-statement SQLite timings;
  - `bun --cpu-prof`.
- **Numbers.** Warm medians unless stated. The host was heavily loaded the
  whole time (PMV5 replays used about 8 of 12 cores), so absolute times are
  noisy, but before/after pairs were measured under the same conditions.

Benchmarks live outside the repo, in `~/.cache/audit-daemon-perf/bench/`
(`rounds.ts`, `stmt.ts`, `turn.ts`, `loadlag.ts`, `tok.ts`, `oai.ts`,
`lines.ts`). Rerun one with
`EXOCORTEX_CONFIG_DIR=<root> bun <bench>.ts <convIds>` from `daemon/`.

## Findings, ranked by user impact

### 1. Every provider round rewrote every stored message (fixed, `c3f69834`)

**What happened.** `onContextUpdate` ran after every provider round (every
Claude Code tool round, every OpenAI round). It did two expensive things:

- **Recalibration.** `annotateApiMessagesContextTokens` recalibrated a
  per-message token attribution across the whole replayed transcript. That
  meant JSON-stringifying and SHA-256-hashing every message and base64-decoding
  every image to read its dimensions.
- **Full row rewrite.** It then marked the conversation attribution-dirty, so
  the next append ran `UPDATE messages SET context_tokens_json=…` on **every
  row**. SQLite rewrites a row's whole record, overflow content included, so
  each round rewrote the full transcript into the WAL.

**Nothing reads this data.** The attribution's only reader
(`validContextTokenAttribution` in compaction) was removed in July
(`7c8274e2`).

**Impact.**

- This was the dominant cause of the live `event_loop_lag` storms: 389 of the
  ≥400 ms lag warnings are preceded by this log line.
- In the peak hour (Oct 16 18:00Z) there were 1,009 rounds rewriting 1.68M
  rows, roughly 170 s of main-thread time in 100 ms–1 s blocks.
- The daemon wrote 31 GB in 29 h of uptime.

| conversation (real copy) | per round, before | per round, after |
|---|---:|---:|
| 3.1k-message Claude subagent, no checkpoint | 312 ms | 23 ms |
| 6.8k-message Claude, 20 MB WAL per round | 219 ms write + 150–250 ms hash | 0 |
| 30k-message OpenAI chat (full-replay case) | 1.2 s hash + 0.6 s write, 81 MB WAL | 0 |

**Fix.** The orchestrator still updates `lastContextTokens` and emits
`context_update`. Existing attribution columns are left in place. The library
functions remain (tested, unused). Delete them, or recompute attributions on
demand if a feature ever needs them.

### 2. Replay-history counts scanned whole transcripts (fixed, `29b3d110`, schema v15)

**What happened.** `rebuildDisplay` runs on every append and needs
`COUNT(*) … WHERE is_replay_history=1 AND sequence<?`. Loads and checkpoint
sealing need the same count, or an `OFFSET` into it. With no index covering
it, SQLite walked every message row and its overflow content.

**Impact.**

- 70 ms per append in a 30k-message conversation (warm).
- 76 ms per round end-to-end for that conversation, even with a compacted
  303-message runtime window.

**Fix.** A partial covering index:
`messages_replay_idx ON messages(conversation_id, sequence) WHERE is_replay_history=1`.
The query drops to 4.7 ms, and the round to 14 ms.

**Deploy note.** The one-time build took 13–36 s on the 7.9 GB copy. It runs
in the startup schema worker, so the first start after deploying blocks
commands for that long. An older binary refuses a v15 DB ("future schema").
To roll back, run `DROP INDEX messages_replay_idx;` and
`DELETE FROM schema_migrations WHERE version=15;`. The old trigger body is
equivalent apart from the `WHEN` guard.

### 3. Unchanged titles were re-indexed in FTS on every save (fixed, `3b621eee`, in v15)

**What happened.** `upsertConversationRow` assigns `title` on every
append/save. That fired `AFTER UPDATE OF title`, which deleted and reinserted
the FTS row (scanning the `UNINDEXED` id column).

**Impact.** 1.7 ms instead of 0.05 ms per row update with about 5k
conversations, growing with the sidebar.

**Fix.** The trigger now has `WHEN old.title IS NOT new.title`.

### 4. Quadratic JSON-line framing on big lines (fixed, `4f3b6f20`)

**What happened.** Three readers searched `partial + chunk` from the start of
the accumulated line on every chunk:

- the IPC server (`server.ts`), where pasted images arrive as one multi-MB
  command;
- the Claude Code relay client (`relay-client.ts`), where stream-json lines
  carry base64 screenshots in tool results;
- the relay's own socket reader.

**Impact.** For one line in 64 KB chunks: 5 MB cost 47 ms and 20 MB cost
597 ms. The new `LineSplitter` scans each chunk once: 1 ms and 9 ms.

**Note.** Relays started before a deploy keep their old reader until they
exit. Only daemon-to-relay traffic goes through that reader, and it is small.

### 5. Token stats re-read and re-merged history per call (fixed, `f9281cb3`; wire size not fixed)

**What happened.** After every provider call, `recordTokenUsage` did two
things:

- pretty-printed and rewrote the 0.75 MB stats file;
- built a full merged snapshot by re-reading every instance's file from disk,
  only for the caller to discard it.

Each turn completion then rebuilt the snapshot to broadcast it.

**Impact.** 10–36 ms per call, plus 7–22 ms per snapshot.

**Fix.**

- Recording writes compact JSON (~2.4 ms).
- Snapshots serve this instance from memory, reparse other instances' files
  only when their size or mtime changes, and are reused until something
  changes.

**Not fixed (for the wire audit).** Each turn completion still broadcasts a
**501 KB** `token_stats` event (181 days × provider/model/source breakdowns)
to every connected client. Over `/ssh`, a subagent-heavy hour costs tens of
MB per TUI. Better options: send `today` plus the changed day as a delta, or
send the full history only on request (`/tokens`).

## Checked and found healthy (no change)

- **Opens and history pages.** Live `conversation_open` p50 2.4 ms, p99 92 ms;
  `conversation_history` p50 5.7 ms, p99 31 ms. The slow opens are mostly CLI
  opens of streaming subagents returning ~2 MB, which is a wire-audit matter.
- **Cold runtime loads.** They run in the worker. The main thread blocks
  ≤ 67 ms on 2–3.5k-message windows (adoption/integrity). Worker time is
  0.04–0.9 s.
- **Turn-end flush and turn start.** Turn-end `markDirty`+`flush` takes
  12–20 ms. Turn start before the provider call takes 10–30 ms warm (130 ms
  cold).
- **OpenAI request path.** Build ≤ 50 ms for 1.2k input items. Incremental
  prepare ~1 ms, with 1–20 KB on the wire per round instead of a 1.2 MB full
  replay.
- **Startup and restart.** Shutdown takes ~0.5 s. Start to listening takes
  8 ms; summaries load in ~90 ms.
- **Memory.** Heap stays at 300–400 MB over 29 h with no upward trend. The
  conversation cache is capped at 64 entries / 256 MB of content bytes. Heap
  runs about 2–3× content JSON (a 10.9 MB conversation is 32 MB of heap), so
  the cap allows ~0.7 GB.
- **Timers.** Background-task recovery is a readdir every 250 ms (an empty
  directory live). The streaming heartbeat sends only uncommitted blocks every
  5 s. Account refresh runs every 60 s. Sidebar listing takes 12–57 ms
  (1.6 MB, 3.4k conversations) and runs only on connect.
- **Deletes.** 0.2–10 ms. A live 5 s stall logged next to
  `handler: deleted conversation` (Oct 17 21:04:41Z) does not reproduce. The
  delete was only queued behind it.

## Not fixed, suggested follow-ups

1. **Host contention (likely cause of the remaining multi-second stalls).**
   During the audit the box ran at 93% user CPU with 17–19 runnable threads,
   memory-pressure "full" stalls, and 183 MB of the daemon swapped out. The
   unexplained 5 s stall (finding above) fits a GC or swap-in stall. Suggested
   changes to `exocortex-daemon.service`: `CPUWeight=1000` (or `Nice=-5`) and
   `MemoryLow=1G`, so batch jobs don't starve the interactive daemon. This is
   an infra change, not in this branch.
2. **Display rebuild of the open AI entry.** Each append rebuilds and rewrites
   the current turn's whole AI display entry. A 445-block subagent turn grew
   it to 267 KB, about 20 MB of WAL per turn and 5–25 ms per append. Fix: an
   incremental append to the last AI entry, or rebuild only from the last
   committed block boundary.
3. **Event-loop lag log context.** `perf: event_loop_lag` could include the
   last IPC command type and the active turn count, so stalls like the 5 s one
   can be attributed.
4. **Dead attribution code and data.** `annotateApiMessagesContextTokens`,
   `copyContextTokenAttributionsToStoredHistory`,
   `validContextTokenAttribution`, `markContextAttributionDirty` /
   `saveContextAttribution`, and the stored `context_tokens_json` values are
   now unused. Remove them in a cleanup pass.
5. **WAL file size.** The WAL file stays at its high-water mark (67 MB live),
   because `journal_size_limit` is unset. Harmless; `PRAGMA
   journal_size_limit=67108864` would cap it.

## Tests

- New:
  - replay-index plan (`sqlite-conversation-store.test.ts`);
  - title-FTS reindex only on change;
  - provider context reports don't rewrite history
    (`orchestrator-persistence.cases.ts`);
  - `line-splitter.test.ts` (every chunk boundary, plus a linear-time
    guard);
  - token-stats snapshot reuse and invalidation.
- Updated: schema-version expectations from 14 to 15.
- Full daemon suite on this branch: 1580–1581 pass. The failures are all
  known noise:
  - the two SQLite clone-cursor tests;
  - `real asynchronous admission…` (5 s timeout under load);
  - the bash manual-backgrounding timing tests;
  - once, `goals > sets a user-owned goal…` (passes alone).

  Unmodified `main` on the same loaded host fails 4: both clone-cursor tests,
  `buildDaemonSpawnSpec`, and async admission. The bash backgrounding tests
  fail there intermittently too. `bun run typecheck` reports only the
  pre-existing `tools/bash-runner.ts:293` error, which is also on `main`.
