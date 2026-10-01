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
