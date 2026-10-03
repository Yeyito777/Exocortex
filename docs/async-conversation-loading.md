# Asynchronous conversation windows

Compacted SQLite conversations resume from the last usable checkpoint and its
tail, not from a validation scan of historical bodies. Historical chunks are
verified when requested. See also [DB-first conversations](DB-FIRST-CONVERSATIONS.md)
for append/display invariants.

## Read and integrity model

- `conversation-load-worker.ts` owns readonly SQLite connections. A consistent
  transaction verifies the checkpoint payload/range receipt, structural replay
  invariants, required system instructions, and canonical tail in 128-row batches.
  It does **not** import, migrate, repair, or write the database.
- Superseded tool/image/message bodies are **not** read or verified on admission,
  including after worker/daemon restart. Their corruption is detected on access,
  not proactively reported on resume. A bad/missing checkpoint or tail checksum
  rejects admission; there is no automatic full-history replay fallback.
- Legacy prefix fingerprints are retained as checkpoint roots. New cursors use
  a domain-separated per-message SHA-256 chain (`checkpoint_tail_v1`), rather
  than pretending a truncated legacy digest can restore native SHA internals.
  Each chain step binds replay count, preceding root, and canonical JSON of
  `{role, content, providerData: providerData ?? null}`. A newer compaction root
  resumes the same chain across restart without rereading the earlier tail.
- Foreground state contains the active checkpoint and real recent tail, plus
  one sealed prefix descriptor. No old per-row headers are queried or transferred.
  The descriptor carries absolute sequence/replay/user offsets, summary counts,
  and verified required system instructions. Historical metadata/dedupe queries
  use indexed persistence even when a sparse window is cached. Superseded
  user checkpoints are not eagerly hydrated; legacy represented-tail cursors
  are verified with those bounded tail rows.
  Descriptors/proofs are runtime-only WeakMap identities, **not** canonical rows.
  `Conversation.messages` is the materialized tail, not an absolute-index array;
  use `storedMessageCount` / `messageSequenceOffset` for durable boundaries.
- A matching compaction divider bounds the retained tail, even when one user
  task accumulated tens of thousands of tool rounds. Legacy checkpoints use
  their original divider, not their later advancing replay cursor.
- Successful integrity proofs bind to the exact adopted message/content/provider
  references and replay eligibility. Replay bodies/provider data and loaded
  checkpoints and prefix descriptors are recursively frozen. Replacing content
  requires an off-thread proof refresh; losing/replacing the sparse descriptor
  cannot authorize a destructive write.
- Adoption checks the current durable generation, message count, and deletion
  state. Cold reads coalesce; stale results are released/retried, never installed
  over newer cache state.
- Invalid checkpoints remain stored but admission rejects them. A missing
  checkpoint with a compaction divider cannot silently replay the archive.
  Canonical insert, provider projection, hashing, and unsafe render fallbacks
  reject headers. Prefix validation runs before destructive persistence writes.
- A worker retains copied tail-chain state for each live window. Appends hash
  only the real tail off-thread. If the worker is lost, it restores the already
  admitted checkpoint root, not its superseded canonical archive. Uncompacted
  replay retains the original native SHA definition.
  Eviction/stale loads release handles; shutdown terminates the loader.

### Cooperative loading and verified reuse

- Two lazy readonly worker lanes avoid globally serializing admission behind one
  large archive. Reads yield between 128-row batches; urgent tail hashes
  can run during another archive read. Lost-hash restoration uses a separate
  connection so it cannot nest inside the cooperative read transaction.
- A paginated open schedules a 120 ms debounced prewarm. At most one speculative
  job runs, only compacted archives qualify, and another interactive load can
  cancel it at a batch boundary. This is not a startup scan or provider request.
  Same-conversation admission joins that lane rather than duplicating its read.
- Each worker retains at most eight verified windows with a 64 MiB accounted
  budget (32 MiB maximum per entry). Full/uncompacted/invalid-checkpoint results
  are not retained. Cache entries contain checkpoint, prefix descriptor, real tail, and
  tail hash state—not old tool bodies. Every adoption gets its own handle.
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
- The revision is **freshness, not a cryptographic receipt**. Schema 12 separately
  stores full SHA-256 checksums for message envelopes, checkpoint payload/range
  receipts, and compact display projections. Writes update them transactionally.
  Missing receipts fail closed and are never repaired by a reader.
- Schema 13 extends each checkpoint receipt to bind a small prefix summary:
  real-user count, summary message count, instruction sequences and a bounded
  work-timer continuation record. Its one-time
  startup-worker upgrade verifies the existing v12 receipt before extending it;
  invalid/missing receipts stay invalid/missing. Summary enrollment reads small
  index/metadata fields, never old tool/image bodies. New checkpoint writes
  preserve this sealed descriptor transactionally. Normal loads
  read the descriptor rather than recounting or enumerating the prefix.

### Requested chunks and migration boundary

- Scrolling verifies precisely the selected compact display projections (plus
  pinned entries) against their stored checksums and index continuity. Hidden
  canonical tool bodies are not part of a compact page request.
- Expanding tool output verifies the selected canonical message envelope,
  reconstructed content checksum, blob checksums and block/index correspondence
  on a worker before returning it. Unrelated old outputs are not read. Full
  materialization explicitly verifies all requested canonical rows.
- Copies of compacted conversations read only the verified latest checkpoint,
  its editable tail, and required instruction snapshots. Superseded history and
  its display/tool rows are not copied. Replay and user-edit cursors are rebased
  to the new transcript, and display rows are rebuilt from the verified tail.
  The source snapshot's revision is checked again inside the creation/undo
  transaction. Missing or corrupt checkpoints/tails fail closed.
- Uncompacted copies retain all history using SQL and copy-on-write blobs,
  preserving deferred body checksums. Rebound user projections are verified
  before new checksums are minted.
- The one-time v12 migration enrolls existing small envelopes, compact projections,
  and checkpoint/range receipts. Existing canonical content/blob checksums are
  preserved; old tool/image bodies are not scanned. Previously unchecksummed
  fields are necessarily an **enrollment baseline**, not retroactive proof that
  old data was never corrupted. Checksums protect against accidental/uncoordinated
  changes, not an attacker rewriting both data and checksums.
- Migration/import runs in `conversation-schema-worker.ts` before accepting IPC,
  transactionally and off the main thread. A current-schema restart does not
  repeat enrollment. Both worker entrypoints must be embedded in compiled builds.

Implementation entry points:
`conversation-loader.ts`, `conversation-load-protocol.ts`,
`conversation-window.ts`, `sqlite-conversation-store.ts`, and `conversations.ts`.
Compiled builds must explicitly include both worker entrypoints; Bun 1.3 embeds them
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
- Cache accounting charges the live tail plus descriptor overhead. Realtime owners
  and title jobs pin their live window while asynchronous callbacks can append
  or rename it. Voice transcript writes serialize per conversation.
- Titles retain bounded earliest user context from the worker rather than
  accidentally generating from only the latest tail.

## Scope and remaining costs

This is not zero-cost cold loading: checkpoint/tail verification is proportional
to the retained context, and foreground adoption visits only materialized tail
rows/checkpoint data. Neither depends on superseded historical row count or body
size. No checkpoint means the
canonical replay itself is needed; the loader cannot invent a compaction.

Remaining admission costs are worker startup (if no lane exists yet), bounded
checkpoint/tail I/O, checksum verification, structured clone and live-context
setup. Cache invalidation is still conservative for unrelated-to-replay edits
within the same conversation. Explicit checkpoint creation/upgrade, full rewrites
and requested full history retain their archive-sized costs; they are not resume.

The admission guarantee intentionally changed at the user's request: checkpoint
and tail are verified before resume; archived chunks are verified on access.
This does not claim that a stored hash proves unread historical bytes unchanged.

Explicit trim/instruction rewrites opt into full materialization **off-thread**
and refuse concurrent streams/unwinds. Their subsequent persistence/rewrite may
remain proportional to the affected archive. Full legacy display requests,
unbounded tool-output expansion, JSON-backend rollback, and schema/import
migrations retain their explicit full-history costs. This change does not
promise to eliminate stalls caused by those operations, provider output size,
other synchronous work, or general host resource contention.

New chain-mode checkpoints require the SQLite receipt/proof path. Export retains
their data and namespace, but a legacy JSON-backend rollback cannot reinterpret
those fingerprints as native full-prefix SHA; it fails closed rather than
silently treating them as validated resumable checkpoints.

## Earlier full-prefix implementation validation (2026-10-01)

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
  daemon/src/conversation-load-worker.ts daemon/src/conversation-schema-worker.ts \
  --outfile /tmp/loader-smoke
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

## Checkpoint/tail architecture validation (2026-10-01)

This replaces the full-prefix admission guarantee described in the earlier
measurements, explicitly at the user's request. All fixtures were owned copies;
the real source database was never migrated or written, and the main daemon
was not restarted.

### Cold latency and archive-size independence

The same 156,572,475-byte / 32,647-row conversation now reads **162 canonical
tail rows and zero superseded bodies**. Its 597 provider replay messages and
checkpoint payload are preserved. It still transfers 32,485 small index headers.

| Path | Load | Canonical rows read |
|---|---:|---:|
| Previous full-prefix worker | 943 ms | 32,647 |
| New fresh worker, median of 3 | **267 ms** | **162** |
| Verified cached reload | 101 ms | 0 |
| Completed prewarm | 104 ms | 0 |

Fresh samples were 267.0, 269.0 and 265.7 ms: approximately **72% less load
latency** than the previous full scan. Preparation took 18–19 ms. These are
fresh runtime/worker loads with filesystem cache potentially warm, not a claim
about physical-disk cold starts. Foreground state was 5,047,839 bytes.

A matched 32,004-row synthetic comparison kept the same checkpoint, headers
and three-row tail while changing historical body size:

| Historical canonical bytes | Fresh load | Old bodies read |
|---:|---:|---:|
| 3,486,755 | 185 ms | 0 |
| 159,726,755 | 182 ms | 0 |

This verifies that historical **body byte size** no longer drives admission.
The remaining approximately 100 ms cached-load floor is principally eager
index-header transfer/adoption and retained-context setup. It is not constant
in historical row count. Profiling-helper event-loop maxima also include its
foreground JSON size measurement; actual IPC contention was measured separately.

### Integrity, restart and build tests

- Repository suite: **2,413 passed**, zero failures; the external exo-cli
  paths file passed **5/5** separately without the conflicting config preload.
  Shared, daemon and TUI typechecks passed.
- All 33 loader cases repeated three times: **99 passed**. Cases cover deferred
  corrupt/missing old blobs, requested projection/content/envelope checksums,
  ordinal corruption, missing/tampered checkpoint receipts, tail/instruction
  corruption, no automatic checksum repair, clone rebinding, worker loss,
  new-compaction fingerprint parity across restart, legacy represented-tail
  rewind, and instruction insertion/removal without breaking covered proofs.
- Startup-worker enrollment passed with an intentionally malformed old blob;
  resume did not inspect it, requested expansion rejected it. Reopening a v12
  database did not recreate a deliberately removed receipt.
- Dedicated five-child daemon IPC smoke passed: Stop **4.1 ms**, paged opens
  **14 ms**, fresh restarted resume **179 ms**, completed-prewarm resume **82 ms**.
  Concurrent cheap IPC maxima were **49/54 ms**, medians **0.27/0.25 ms**.
  All 32,004 rows and the byte-identical checkpoint survived cancellation,
  restart and metadata undo/redo. Restarted diagnostics read three tail rows,
  not the archive. Old corruption allowed resume but requested output/page
  corruption returned IPC errors; fresh tail corruption rejected resume and
  subsequent cheap IPC still worked.
- Linux embedded load and schema workers ran successfully outside the checkout.
  Windows x64 cross-compilation included both workers, as do Makefile and
  PowerShell build entrypoints. Windows runtime was not available/tested.

Artifacts: `/tmp/exocortex-async-loading-validation-1790876711501/`,
particularly `checkpoint-tail-last-*.json`, `checkpoint-tail-ipc-last.json`
and its per-child performance log. Tests/typechecks:
`/tmp/checkpoint-tail-{root,exo-paths,loader-repeat,types}-last.log`.

## Sparse-prefix architecture validation (2026-10-01)

The old header-array cost described above is now removed. A sealed descriptor
replaces all 32,485 historical headers. Required instructions remain verified;
absolute append, streaming, summary and editable-user indices remain durable.
Unwind carries the descriptor to its bounded prefix plan. Explicit rewrites still
materialize off-thread; detached descriptors cannot authorize prefix deletion.
Automated continuations retain a bounded archived work clock, while human turns
reset it. Historical metadata dedupe falls back to indexed SQL, not enumeration.

### Latest large-chat results

Same owned 156,572,475-byte / 32,647-row archive, byte-preserved checkpoint and
597 provider replay messages. Medians below are three independent measurements;
fresh runtime/worker does not mean physically cold filesystem cache.

| Path | Previous header window | Sparse descriptor |
|---|---:|---:|
| First load, including worker startup | 267 ms | **114 ms** |
| Uncached chat, already-started worker | — | **51 ms** |
| Verified cached reload | 101 ms | **10 ms** |
| Completed prewarm | 104 ms | **16 ms** |

All uncached reads verified 162 canonical tail rows, **zero old headers and zero
old bodies**. Foreground state fell from 5,047,839 to **2,266,614 bytes**.
Foreground adoption itself was 3.6–4.5 ms; replay/checkpoint setup was ~12 ms.
The uncached started-worker path includes ~47 ms RPC/worker read/transfer, not
47 ms foreground CPU. Worker startup accounts for much of the first-load
premium. Loading remains proportional to the actual live checkpoint/tail,
not to unread audit-history rows.

An independent row-scaling comparison held the same tiny checkpoint and three
tail rows while varying superseded history:

| Stored rows | Fresh worker load, median of three | Old headers/bodies read |
|---:|---:|---:|
| 1,004 | 80 ms | 0 / 0 |
| 128,004 | 78 ms | 0 / 0 |

Both transferred ~1.1 KB foreground state. This is a scaling check, not a claim
that bigger archives are intrinsically faster; worker-startup noise dominates.

### Validation and runtime caveat

- Repository run: **2,381 passed, zero failures**, including a child containing
  **39 loader cases** and another containing **14 real orchestrator cases**.
  The external exo-cli path tests passed **5/5** separately.
- Loader cases repeated three times: **117 passed**. New coverage includes
  bounded 32,002-row prefixes, absolute user/summary/streaming indices, cached
  metadata dedupe, clone descriptors, empty tails, automation clocks, descriptor
  tampering/detachment and v12 upgrade without blessing bad/missing receipts.
- Shared/daemon/TUI typechecks passed. Linux embedded load/schema workers ran
  outside the checkout; Windows x64 cross-build passed. Windows runtime was
  not available/tested.
- Owned five-child daemon IPC/restart smoke passed. Fresh restarted resume was
  **72 ms**, verified prewarm **5.4 ms**, Stop **4.2 ms**. Concurrent cheap-IPC
  maximum was **0.28 ms** during restarted admission (seven probes).
  All 32,004 rows and byte-identical checkpoint survived; requested old
  corruption/tail corruption rejected the appropriate request, and cheap IPC
  remained usable. Only owned test children were restarted.
- Two earlier monolithic runs crashed inside Bun 1.3.14's native GC/timer heap
  (`IncrementalSweeper` → `WTFTimer` → intrusive heap removal). These were
  **not passing runs**. The real-worker suite now runs in an isolated child,
  avoiding the repository's unrelated process-wide mocks; the complete
  isolated coverage and repeated worker suite pass. This is test isolation,
  **not a claim to have fixed Bun's native runtime bug**.
- A concurrent stress run also hit three cleanup-hook timeouts in the unchanged
  voice/SSH TUI E2E tests. Their isolated rerun passed **4/4**, and the final
  serial repository run passed **2,381/2,381**. No voice test implementation
  or timeout was changed.

Artifacts: `sparse-final-*.json`, `sparse-ipc-final.json`, its child/performance
logs and `sparse-compiled-*.json` in the same owned validation directory.
Test logs: `/tmp/sparse-root-serial-final.log`,
`/tmp/sparse-loader-isolated-last.log`, `/tmp/sparse-exo-paths-verified.log`
and `/tmp/sparse-types-final-post-isolation.log`.

```sh
bun test ./daemon/src/conversation-loader.cases.ts --rerun-each 3
bun scripts/dev/profile-archive-loader.ts ready /tmp/CURRENT-fixture.sqlite3 archive-stress
# Owned NEW fixtures with different row counts:
bun scripts/dev/profile-archive-loader.ts seed /tmp/NEW-small.sqlite3 archive-stress 1 500
bun scripts/dev/profile-archive-loader.ts seed /tmp/NEW-large.sqlite3 archive-stress 1 64000
```

## Startup cursor regression and cleanup

The v12 enrollment title collector stopped at its character budget while using
a cached `db.query(...).iterate()` statement. The next checkpoint could not
rebind that still-active cursor (`bad parameter or other API misuse`), preventing
startup. The same behavior reproduces on Bun 1.3.14 and 1.4.2; it is separate from
the native GC/timer crash above. Single-checkpoint/short-title fixtures missed it.

All streamed store queries now use `iterateRows`: an uncached prepared statement
owned by a generator and finalized in `finally`. Exhaustion, early breaks and
validation exceptions release it. Clone envelope/projection failures previously
poisoned subsequent same-connection attempts too; repeated rejection and a retry
after restoring the exact fixture bytes are now covered. Integrity checks,
transactions, receipt format and deferred historical-body validation are unchanged.

On an owned consistent 7.1 GB backup (817,230 messages, 245 checkpoints), full
v11→v13 enrollment succeeded in 22.9 s, preserving byte-identical checkpoint
payloads. A subsequent schema-worker run took 54 ms (schema phase only, not whole
daemon startup). SQLite quick-check, foreign keys, blob aliases and receipt/
descriptor coverage were clean. Two fresh runtime admissions/replays succeeded
without reading historical bodies or index headers. Validation: 2,384 repository
tests, 40 repeated cursor/migration checks, workspace typechecks, owned daemon
IPC/integrity smoke, Linux compiled-worker smoke and Windows x64 cross-build.
