# Asynchronous conversation windows

Compacted SQLite conversations no longer load their complete canonical bodies
on the daemon's IPC thread. See also [DB-first conversations](DB-FIRST-CONVERSATIONS.md)
for append/display invariants.

## Read and integrity model

- `conversation-load-worker.ts` owns readonly SQLite connections. A consistent
  read transaction streams 128-row batches, resolves original blob bytes, parses
  messages, and validates the checkpoint off-thread. It does **not** import,
  migrate, repair, or write the database.
- The worker uses the existing SHA-256 prefix definition: JSON of
  `{role, content, providerData: providerData ?? null}`, followed by a newline
  per replay-history message, truncated to the same 24 hex characters.
  Neither hashing nor checkpoint validation is disabled.
- Foreground state contains the active checkpoint and real recent tail, plus
  small immutable headers for earlier rows. Absolute message/user indices,
  automation metadata, user checkpoints, and system instructions survive.
  Headers are runtime-only WeakMap identities, **not** canonical message values.
- A matching compaction divider bounds the retained tail, even when one user
  task accumulated tens of thousands of tool rounds. Legacy checkpoints use
  their original divider, not their later advancing replay cursor.
- Successful integrity proofs bind to the exact adopted message/content/provider
  references and replay eligibility. Replay bodies/provider data and loaded
  checkpoints are recursively frozen. Replacing content requires an off-thread
  proof refresh; changing/truncating/reordering archive headers is rejected.
- Adoption checks the current durable generation, message count, and deletion
  state. Cold reads coalesce; stale results are released/retried, never installed
  over newer cache state.
- Invalid checkpoints remain present so replay fails closed. A missing
  checkpoint with a compaction divider cannot silently replay the archive.
  Canonical insert, provider projection, hashing, and unsafe render fallbacks
  reject headers. Prefix validation runs before destructive persistence writes.
- A worker retains copied native SHA state for each live window. Appends hash
  only the real tail off-thread. If the worker is lost, it rebuilds the prefix
  from canonical bytes and requires the original count/digest to match.
  Eviction/stale loads release handles; shutdown terminates the loader.

### Cooperative loading and verified reuse

- Two lazy readonly worker lanes avoid globally serializing admission behind one
  large archive. Reads yield between 128-row batches; urgent native tail hashes
  can run during another archive read. Lost-hash restoration uses a separate
  connection so it cannot nest inside the cooperative read transaction.
- A paginated open schedules a 120 ms debounced prewarm. At most one speculative
  job runs, only compacted archives qualify, and another interactive load can
  cancel it at a batch boundary. This is not a startup scan or provider request.
  Same-conversation admission joins that lane rather than duplicating its read.
- Each worker retains at most eight verified windows with a 64 MiB accounted
  budget (32 MiB maximum per entry). Full/uncompacted/invalid-checkpoint results
  are not retained. Cache entries contain checkpoint, headers, real tail, and
  native hash state—not old tool bodies. Every adoption gets its own handle.
- Schema 11 installs transactional revision triggers covering conversation rows,
  messages, blobs, clone aliases, checkpoints, and runtime unwind-receipt fields.
  Owner-blob changes invalidate dependent clones too. An unrelated conversation
  write does not invalidate an entry. Queue-cleanup acknowledgements do not
  change the runtime receipt and therefore do not invalidate it.
- Reuse requires the same database file identity, schema cookie, revision,
  generation, and count. Trigger definitions are checked on schema-cookie
  changes; missing/altered triggers or atomic file replacement fail closed.
  Adoption and subsequent writes check freshness. Writes recheck inside the
  transaction and capture the resulting token before commit; presentation
  updates cannot bless a previously stale loaded snapshot.
- This revision is **freshness, not a cryptographic receipt**. Initial reads still
  validate actual bytes. Worker restart discards every cached proof.
- Canonical archived blob envelopes can be reconstructed as raw JSON fragments,
  avoiding decode/re-escape of large strings and structured results. Those exact
  bytes must match either the row's content SHA or the active checkpoint's native
  prefix SHA. Failed anchored validation retries with the original JSON
  parse/normalize semantics; it never turns a failed checkpoint into a valid one.

Implementation entry points:
`conversation-loader.ts`, `conversation-load-protocol.ts`,
`conversation-window.ts`, `sqlite-conversation-store.ts`, and `conversations.ts`.
Compiled builds must explicitly include the worker entrypoint; Bun 1.3 embeds it
as `.js`, while source installations use `.ts`.

## Admission and non-model work

- Production rejects synchronous cold SQLite `get` calls. Turn admission owns
  asynchronous loading, reserves a handoff first, and verifies its exact token
  again after awaits. Stop acknowledges without waiting for the worker.
- Queue injection prepares each preceding checkpoint before committing the
  batch; cancellation/queue changes cannot consume uncommitted durable entries.
- Recovery, scheduler/notification dedupe, policy queries, cold goal pause,
  paged history, and targeted tool-output reads use summaries/indexed SQL instead
  of opening canonical archives. Trash undo/redo restores summaries/workspaces
  without archive hydration.
- Display suffix rebuilding recognizes compaction dividers, avoiding an enormous
  still-open AI group from the original single-user task.
- Cold rename/mark/mute/pin/clone and corresponding mark/rename undo use targeted
  SQL/sidebar state rather than hydrating canonical history.
- Cache accounting charges the live tail plus header overhead. Realtime owners
  and title jobs pin their live window while asynchronous callbacks can append
  or rename it. Voice transcript writes serialize per conversation.
- Titles retain bounded earliest user context from the worker rather than
  accidentally generating from empty archive headers or only the latest tail.

## Scope and remaining costs

This is not zero-cost cold loading: the first read still scans/hash-validates
the canonical archive on a worker, and foreground adoption is proportional to
row/header count and the actual retained context. No checkpoint means the
canonical replay itself is needed; the loader cannot invent a compaction.

**Architectural limit:** `readRuntimeWindow` still loops through the entire
canonical archive to establish the native checkpoint's relationship to it.
Verified reuse and prewarm eliminate repeated scans or move the first one before
admission; neither makes a genuinely fresh/restarted load bounded by live context
size. Tail append/checkpoint/presentation changes conservatively invalidate the
whole worker entry. The foreground also constructs/freezes/snapshots one header
per old row, so even a cache hit is not independent of archive row count.

The next storage design needs a separately persisted, integrity-bound runtime
checkpoint plus indexed recent tail, prefix-scoped mutation tracking, and lazy
archive/user-boundary descriptors instead of a whole header array. A stored SHA
or Merkle root alone does **not** prove that unread archive bytes are unchanged.
Two different guarantees must be kept explicit:

1. Verify every historical byte before every cold admission (necessarily
   proportional to archive size).
2. Verify an authenticated runtime capsule before admission, invalidate it on
   relevant mutations, and verify archived data when accessed/audited.

The second can provide bounded cold latency, but merely deferring the current
prefix check to the background would weaken the first guarantee. This work does
not silently make that change or persist unchecked trust receipts.

Explicit trim/instruction rewrites opt into full materialization **off-thread**
and refuse concurrent streams/unwinds. Their subsequent persistence/rewrite may
remain proportional to the affected archive. Full legacy display requests,
unbounded tool-output expansion, JSON-backend rollback, and schema/import
migrations retain their explicit full-history costs. This change does not
promise to eliminate stalls caused by those operations, provider output size,
other synchronous work, or general host resource contention.

## Validation (2026-10-01)

### Readonly production-sized comparison

One existing archive was profiled readonly in separate processes: 156,539,174
canonical bytes, 32,619 rows. No provider was contacted and no production
conversation was copied or written.

| Measurement | Synchronous baseline | Worker window |
|---|---:|---:|
| Cold load | 1,266 ms | 1,469–1,583 ms |
| Replay/checkpoint preparation | 26 ms | 22–28 ms |
| Maximum 5 ms event-loop probe delay | 1,291 ms | 118–139 ms |
| Worker-run p95 event-loop delay | — | 0.38–0.43 ms |
| Foreground serialized representation | 156.5 MB | 5.43 MB |
| Process RSS delta at preparation | 1,293.6 MB | 268–288 MB |
| Real foreground tail rows | 32,619 | 134 (+32,485 headers) |
| Projected replay messages | 569 | 569 |

Both paths produced the identical canonical checkpoint hash,
`0cfa712a5793dfae3ac03b1a`. Maximum foreground delay fell roughly **89–91%**.
Cold wall time is not faster; the benefit is responsiveness and avoiding
archive-sized foreground allocations. These are individual cold measurements,
not a statistical throughput claim or a peak-memory measurement.

### Actual isolated daemon IPC and restart

A generated 159.7 MB / 32,004-row fixture was transactionally copied into a fresh
temporary config. Only the owned child processes were stopped/restarted;
the main daemon was not restarted. Credentials were not inherited, external
daemon supervision was disabled, and no model request was made.

- Cold admission: 580 ms; Stop acknowledged in **0.29 ms** and cancelled input
  was not persisted.
- Concurrent `list_tasks`: 56 probes, median **0.11 ms**, p95 **33.94 ms**,
  maximum **54.86 ms** during admission.
- Replacement-daemon cold load: 606 ms; 57 concurrent probes, median **0.18 ms**,
  p95 **44.47 ms**, maximum **65.51 ms**.
- Paged open: 12 ms; targeted archived tool output: 3.13 ms.
- Cold undo/redo/restore: 2.53 / 1.05 / 0.45 ms, before hydrating the restarted
  cache.
- Restart exit protocol, metadata durability, all original rows, byte-identical
  active checkpoint, and SQLite `integrity_check` passed.
- A deliberately malformed canonical row in the disposable copy returned a
  verified-load IPC error; subsequent cheap IPC still worked (0.19 ms).

### Automated/build coverage

- Whole repository: **2,356 passing tests, zero failures** (227 files).
- Shared, daemon, and TUI typechecks passed.
- Worker tests cover parity, exact hashes, writes preserving archived bytes,
  copy-on-write clone aliases, corrupted/missing checkpoints/blobs, archive holes,
  stale/deleted generations, changed references, truncation, worker loss/recovery,
  legacy boundaries, titles, and zero-header/noncompacted proofs.
- An isolated child suite exercises 12 real SQLite/orchestrator cases including
  admission coalescing, Stop, successor/deletion races, queued checkpoints,
  compaction, unwind, explicit rewrites, rewrite/handoff exclusion, cold goal
  pause, indexed undo/redo, and cache pins/dirty-window paging.
- Linux embedded-worker executable ran successfully **outside the checkout**.
  Windows x64 daemon including the worker cross-compiled successfully; a Windows
  runtime was not available and is not claimed tested.
- Three stale baseline test assertions were corrected without changing their
  runtime implementations: `/model` is now a valid inline command (use `/rename`
  to test standalone-only completion), the existing oversized-context safety
  error precedes image-specific rejection, and an explicitly widened TUI state
  type is needed after a mutating navigation call.

Reproduce without accessing live data:

```sh
bun run typecheck
bun test
bun scripts/dev/profile-archive-loader.ts seed /tmp/NEW-fixture.sqlite3 archive-stress 150
bun scripts/dev/profile-archive-loader.ts baseline /tmp/NEW-fixture.sqlite3 archive-stress
bun scripts/dev/profile-archive-loader.ts worker /tmp/NEW-fixture.sqlite3 archive-stress
bun scripts/dev/async-loader-ipc-smoke.ts /tmp/NEW-fixture.sqlite3 archive-stress /tmp/ipc-report.json
bun build --compile daemon/src/conversation-loader-compiled-smoke.ts \
  daemon/src/conversation-load-worker.ts --outfile /tmp/loader-smoke
(cd /tmp && ./loader-smoke /tmp/NEW-fixture.sqlite3 archive-stress)
```

The seed command refuses to overwrite an existing file; profile modes open
readonly. The IPC smoke refuses non-synthetic or undersized input, creates its
own fresh config, never targets a service/main instance, and removes its copy.

## Follow-up after merging main's TUI reopening changes (2026-10-01)

Main's render LRU/offscreen layout changes were merged into this worktree.
They speed up display/reopening, not canonical checkpoint validation.

A transactionally copied, single-conversation fixture contains 156,572,475
canonical bytes / 32,647 rows. Source attachment is enforced `mode=ro` using
SQLite URI-open flags; no production migration, model request, or daemon restart
is needed. Measurements below are individual runs, not statistical percentiles:

| Read path | Load | Archive rows read | Replay/checkpoint prep |
|---|---:|---:|---:|
| Synchronous full baseline | 1,246 ms | 32,647 | 27 ms |
| Fresh worker window | 943 ms | 32,647 | 26 ms |
| Verified worker cache | 122 ms | **0** | 24 ms |
| Completed prewarm | 114 ms | **0** | 26 ms |

The worker paths retained 5,469,554 foreground bytes, 162 real tail rows, and
32,485 headers. All four produced 597 replay messages and the identical hash
`a7c8cb54c9fc74ec4e568815`. Cold worker RSS delta was 204.6 MB versus 1,289.0 MB
for the baseline; these are process deltas, not peak memory. The cold worker's
5 ms event-loop probe had 0.81 ms p95 and 133 ms maximum (including foreground
adoption/reporting), versus a 1,274 ms baseline maximum.

A synchronous CPU profile of the optimized worker algorithm attributed self
samples to SQLite `.all` row extraction/string decoding (29.3%), SHA operations
(23.1%), JSON parse/stringify (9.4%), and other work (38.3%, including additional
SQL queries, joins, projection, freezing, allocation and setup). These are CPU
samples, **not** wall-time task-completion percentages or disk/model latency.
The architectural problem is touching 156.6 MB to prepare a 5.5 MB live window.

The isolated IPC smoke additionally waits for an exact-child prewarm log and
requires foreground `cacheHit:true, archiveRowsRead:0`; a timer alone is not
accepted as proof. On the 159.7 MB synthetic fixture, it measured 90 ms after
verified prewarm, ~629–648 ms true cold, 0.26 ms Stop, and maximum concurrent
cheap-IPC delay 57–60 ms. Restart/restore durability, cancelled-input exclusion,
byte-identical checkpoint, SQLite integrity checks, and fault isolation passed.
Only owned child daemons were restarted.

Coverage includes invalidation after direct SQL edits, rollback, alias fanout,
missing revision triggers, atomic file replacement, inter-check/transaction
writer races, cleanup acknowledgements, bounded LRU, independent foreground lanes,
same-chat prefetch joining, urgent hashing during cold reads, and legacy JSON
normalization fallback. Linux's current embedded-worker build passed outside the
checkout; the Windows daemon/worker cross-build passed (not Windows runtime).
The shared external exo-cli path
tests assume the config override is unset, conflicting with the repository's
isolation preload; run that read-only file separately with:

```sh
bun test --path-ignore-patterns '**/exo-cli/src/shared/paths.test.ts'
env -u EXOCORTEX_CONFIG_DIR EXOCORTEX_TEST_CONFIG_READY=1 \
  bun test external-tools/exo-cli/src/shared/paths.test.ts
bun scripts/dev/profile-archive-loader.ts warm /tmp/CURRENT-fixture.sqlite3 archive-stress
bun scripts/dev/profile-archive-loader.ts prefetch /tmp/CURRENT-fixture.sqlite3 archive-stress
```
