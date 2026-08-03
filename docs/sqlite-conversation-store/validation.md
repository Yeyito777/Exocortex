# SQLite conversation-store validation

Date: 2026-08-01

Worktree: `sqlite-conversation-store`

All copied transcripts, databases, exports, screenshots, and per-conversation reports
remain under gitignored worktree data or `/tmp`. No real transcript content is in
Git.

## Real migration fixture

- 24 eligible main-instance conversations, selected read-only.
- Both OpenAI and DeepSeek.
- Empty, small, medium, multi-megabyte, tool-heavy, failed-tool, image, system
  instruction, folder/inheritance, marked/pinned, non-default model/effort/fast,
  active-context, compaction, context-attribution, legacy-version, unread, and
  multi-page cases are represented.
- Goals, subscriptions, Chrono owners/targets/pending wakes, streaming work, queued
  work, active tasks, subagent recovery, BTW sessions, and this implementation
  conversation were excluded.
- The selector performed stable pre/post stat/hash reads and immediately reverified
  main after copying. The immutable copied files still match all 26 manifest hashes.
- Five live-main source paths now differ naturally from the immutable snapshot.
  Later `verify` reports that live drift separately without confusing it with fixture
  corruption. `verify --require-source-stable` remains available when a frozen source
  is required.
- Final migration verifier: **24 conversations, 0 mismatches**, `quick_check=ok`, no
  foreign-key errors, all goals absent, and no copied automation files.
- Exhaustive pagination walked **346 pages / 3,568 display entries** with strict
  cursor progress, no gaps or duplicates, and compared **23,377 deferred tool
  outputs**. There were zero old-image payload violations and zero mismatches.
- Every scalar, ordered message and optional field, active context/checkpoint,
  transcript hash, all display pages, deferred tool output, instruction composition,
  and normalized export was compared.

Gitignored evidence:

- `sqlite-fixture/manifest.json`
- `sqlite-fixture/migration-report.json`

## Sequential feature validation

`bun scripts/dev/sqlite-feature-smoke.ts` exercised the real domain/handler paths
against the canonical worktree database. Result: **21 passed, 0 failed**.

Covered:

1. indexed startup summaries
2. empty creation
3. atomic creation with initial user message
4. user/assistant/tool append
5. newest/older history pages
6. rename/mark/pin/sidebar move
7. model/effort/fast mode
8. conversation instructions
9. folder create/rename/pin/move/inherited instructions
10. full synthetic goal lifecycle
11. durable queue CRUD and ordering
12. clone and independent mutation
13. history/thinking/tool trim
14. stable-identity rewind
15. unread and external inbox
16. delete/undo/redo/restore
17. recursive folder delete/undo
18. folder unwrap/undo
19. synthetic non-executing Chrono create/cancel
20. close/reopen durable-state verification
21. SQLite integrity

Gitignored evidence: `sqlite-fixture/feature-smoke-report.json`.

## Main synchronization — 2026-08-03

Current `main` through `ba3d155` was merged into the worktree. The merge adds
realtime calls, external call adapters, authenticated speaker attribution, direct
attributed utterances, transcript reconciliation, exact task stopping,
instance-local daemon restart, long Unix-socket fallback, and the helper-tool rename.
One textual conflict in `conversations.ts` was resolved by retaining both the SQLite
direct page/tool-output paths and main's streaming-extra reconciliation.

Storage reconciliation:

- finalized call utterances and call boundary markers use ordinary canonical message
  rows;
- all new call/adapter/speaker fields round-trip through `metadata_json`, so schema
  version 6 remains sufficient;
- call status rows are canonical but excluded from `message_count`;
- promotion of a persisted call transcript into a backend delegation forces
  field-level comparison from the edited sequence;
- orchestrator transcript replacement retains external messages appended while the
  stream is active;
- WebRTC/Bidi transport, audio, SDP, partial deltas, participants, speaker windows,
  and active call identity remain ephemeral and are not restart-recovered;
- instance restart stops calls, flushes and closes SQLite, then reopens the same
  namespaced database. The short-socket fallback changes only IPC location.

A new direct SQLite regression test covers complete realtime provenance/speaker
metadata, status-count semantics, promoted-content rewrite, reopen, and integrity.
The merged domain realtime tests also reload promoted content from persistence.
Initial SQLite-targeted realtime gate: **6 passed, 0 failed**.

The remaining-only architecture roadmap was updated to remove the completed
repository/SQLite/migration program and add JSON retirement plus realtime service and
runtime-validation follow-up work. The post-merge aggregate is in
[`main-sync-results.md`](./main-sync-results.md).

## Legacy trash and history migration completion — 2026-08-03

A post-review audit found that the first importer implementation migrated live
conversation files but did not actually import `trash/*.json`, `trash/trash.json`, or
`trash/redo.json`, despite the earlier architecture documents saying that it did. The
cutover path now:

- enumerates both live and soft-deleted sources and retains deleted messages under a
  non-null `deleted_at`;
- rejects the same ID appearing in both source directories instead of guessing;
- imports ordered undo and redo stacks after all source conversations succeed,
  including a trash-only corpus with zero live conversations;
- preserves folder-recursive delete, folder-unwrap, and conversation delete/restore
  ordering across a JSON-to-SQLite process restart;
- leaves every legacy JSON byte unchanged; and
- exports soft-deleted conversations plus `trash/trash.json` and `trash/redo.json` in
  the exact directory layout accepted by the JSON backend, so deletion undo survives
  rollback.

Four isolated child-process tests prove full JSON setup → SQLite import → sequential
undo/redo behavior, trash-only import, safe duplicate-ID refusal, and SQLite export →
JSON rollback/undo. The migration tests use synthetic IDs and fresh config roots only.

## Automated tests

- Root TypeScript typecheck: **passed**.
- Shared: **15 passed, 0 failed** with an isolated test config.
- TUI: **711 passed, 0 failed**.
- Default JSON compatibility/full daemon run: **817 passed, 2 unrelated
  environment-sensitive failures** across 80 files. One is the existing native-Exo
  hint expectation under the repository harness; the other is a DeepSeek no-key
  assertion while real/stored credentials are available. Neither relevant source
  file differs from merged main, and neither failure is storage-related.
- Final repository/import/differential/schema/maintenance/fault gate: **32 passed,
  0 failed** across JSON and SQLite.
- Merged SQLite conversation/realtime/call gate: **182 passed, 0 failed, 8 skipped**.
- Broad SQLite canonical matrix: **658 passed, 0 failed, 9 skipped** across 66 files.
  The skips explicitly assert obsolete JSON `.sidebar`, `.unwind`, filesystem-failure,
  or orphan-tombstone mechanics; those paths still execute in JSON mode.
- An exploratory all-file SQLite run was classified rather than used as a gate:
  direct JSON persistence and display-projection tests intentionally expect JSON
  files from the process-wide facade. The canonical matrix excludes those
  implementation-specific files and had zero failures.
- The resumable-import tests cover valid v18 import, one corrupt source, resume after
  repair, changed-source reimport before completion, overlays, folders/instructions,
  unread, queue, BTW, deleted source rows, ordered undo/redo stacks, a trash-only
  corpus, duplicate live/trash refusal, JSON rollback undo, and a completed-import
  no-scan startup. Their assertions are robust when other full-suite tests leave
  unrelated legacy fixtures in the shared isolated root.
- Fault injection covers every save, unwind, and delete boundary and compares full
  logical state, blob rows, FTS rows, auxiliary state, and undo/redo history before
  and after rollback. A child-process test exits abruptly inside a transaction and
  proves WAL rollback plus integrity on reopen.
- Schema maintenance tests cover every v1→v6 checkpoint, immutable future-version
  refusal, title-FTS lifecycle, backup, restore-to-new, normalized live/deleted export
  with undo/redo history, separate large blobs, exact reconstruction, cascading orphan
  cleanup, realtime metadata promotion, and scale-critical index query plans.

The merged storage changes introduce no new default-backend compatibility failure.

## xenv/exotest

The merged worktree daemon and TUI were started through `xenv` plus the worktree's
`exotest`; main was never restarted.

Validated manually:

- indexed startup with 40 fixture-plus-smoke conversations
- folders/sidebar rendering and a migrated real conversation
- newest-page rendering and manual older-page navigation
- explicit `Ctrl+O` deferred tool-output loading and expansion
- `/call`, `/hangup`, and `/mic` autocomplete/rendering without initiating a call
- `Ctrl+Shift+R` replacing only the worktree daemon child and reconnecting to the
  same conversation/database
- complete worktree daemon/TUI stop and a cold reopen against the same database
- fixture unread-state restoration, empty-Chrono removal, final clean stop, integrity,
  and xenv removal
- unchanged main daemon PID throughout

This test found that `exotest` still polled the pre-fallback long Unix socket path.
It now obtains the endpoint from the same shared resolver used by the daemon and TUI.
The separately linked external `exo` CLI still duplicates endpoint logic; consolidating
that contract and testing cross-instance discovery are now roadmap items.

Screenshots were kept only under `/tmp`; transcript images are not committed.

## Integrity, backup, restore, export, and JSON rollback

Against the final real worktree database:

- schema version 6
- 40 live fixture-plus-smoke conversations
- 38,613 canonical messages
- 23,383 separated message payload rows
- `quick_check=ok`
- no foreign-key errors
- WAL mode with a clean zero-byte checkpointed WAL

Before the xenv-only mutation, the administration drill created and validated an
online backup of the 34-conversation database and restored it to a distinct file;
overwrite refusal also passed. An isolated SQLite daemon loaded that restore and
passed ping, list/folders, recent history, older history, and deferred-tool-output
IPC. The full normalized export was then installed under an isolated config root.
The JSON adapter loaded **34/34** files with zero failures and 19 folders, and an
actual JSON-backend daemon passed the same real history/folder IPC before only the
rollback-test daemons were stopped.

Gitignored evidence:

- `sqlite-fixture/admin-check.json`
- `sqlite-fixture/backup-report.json`
- `sqlite-fixture/restore-report.json`
- `sqlite-fixture/export-report.json`
- `sqlite-fixture/rollback-adapter-report.json`
- `sqlite-fixture/rollback-daemon-report.json`

## Performance

See `autoresearch/exocortex-performance/CONVERSATION_STORE.md` and
`results/conversation-store-full.json`.

All approved gates pass; the executable verifier reports **13 passed, 0 failed**:

- low scale: +0.874 ms startup/list median and +0.906 ms p95, inside the 2/5 ms
  absolute allowances
- 10,000 startup/list: **4.49x faster**
- 50,000 startup/list: **4.18x faster**
- 10 MiB append: **28.3x faster**
- 50 MiB append: **148.0x faster**
- 96 MiB append: **305.7x faster**
- metadata and sidebar mutation p95: **3.275 ms** and **0.139 ms**
- SQLite append historical-size spread: **1.16x** across 1–96 MiB
- SQLite/JSON storage ratio at 10k: **0.957x**

The post-main-merge 2,000-conversation quick rerun on Bun 1.3.14 measured a
**0.416 ms** low-scale absolute SQLite delta, **4.38x** startup/list speedup at 2k,
**2.91x** append speedup at 1 MiB, and **38.83x** at 10 MiB.
