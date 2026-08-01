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
- One selected main conversation changed naturally after the immutable snapshot;
  later `verify` reports this as live-source drift without confusing it with fixture
  corruption. `verify --require-source-stable` remains available when a frozen
  source is required.
- Final migration verifier: **24 conversations, 0 mismatches**, `quick_check=ok`, no
  foreign-key errors, all goals absent, and no copied automation files.
- Every scalar, ordered message and optional field, active context/checkpoint,
  transcript hash, newest/older page, deferred tool output, instruction composition,
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

## Automated tests

- Root TypeScript typecheck: **passed**.
- Shared: **13 passed, 0 failed** with an isolated test config.
- TUI: **673 passed, 0 failed**.
- Default JSON compatibility/full daemon run: **741 passed, 3 unrelated
  environment-sensitive failures**. The failures are the existing bash background
  timing assumption, native Exo availability under the test harness, and a
  DeepSeek-auth test while a real key is injected. They are not storage failures.
- Repository/maintenance/fault suite: **19 passed, 0 failed** across JSON and SQLite.
- SQLite canonical integration matrix: **167 passed, 0 failed, 9 skipped**. The
  skipped tests assert obsolete JSON `.sidebar`, `.unwind`, and filesystem failure
  mechanics; those same tests still execute in JSON compatibility mode.
- Fault injection proves rollback after message writes, during delete/undo, and
  during unwind/queue receipt. A separate child-process test exits abruptly from
  inside a live transaction and proves WAL rollback plus integrity on reopen.
- Schema maintenance tests cover future-version refusal, backup, restore-to-new,
  normalized export, separate large blobs, exact reconstruction, cascading orphan
  cleanup, and scale-critical index query plans.

The pre-implementation baseline had four environment-sensitive failures. The final
storage changes introduce no new default-backend test failure.

## xenv/exotest

The final worktree daemon and TUI were started through `xenv` plus `exotest`; main
was never restarted.

Validated manually:

- indexed startup with 29 fixture-plus-smoke conversations
- folders/sidebar rendering
- two different migrated real conversations
- newest and older history navigation
- explicit `Ctrl+O` deferred tool-output expansion
- sidebar folder navigation
- complete worktree daemon/TUI stop and fresh start against the same database
- post-restart conversation loading
- final clean stop and xenv removal

Screenshots were kept only under `/tmp`; transcript images are not committed.

## Integrity, backup, restore, export, and JSON rollback

Against the final real worktree database:

- schema version 6
- 29 live fixture-plus-smoke conversations
- 38,591 canonical messages
- 23,381 separated message payload rows
- `quick_check=ok`
- no foreign-key errors
- WAL cleanly checkpointed to zero bytes

The administration script created and validated a real online backup, restored it
to a distinct database file, and exported all 29 live conversations plus auxiliary
state. The export was installed under an isolated config root. The JSON adapter then
loaded **29/29** files with zero failures, and an actual JSON-backend daemon was
started against that export. IPC ping, indexed listing (29), and real conversation
load all passed before only that rollback-test daemon was stopped.

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

All approved gates pass:

- low scale: +0.467 ms startup/list median and +0.501 ms p95, inside the 2/5 ms
  absolute allowances
- 10,000 startup/list: **4.69x faster**
- 10 MiB append: **33.0x faster**
- 50 MiB append: **138.8x faster**
- 96 MiB append: **263.0x faster**
- metadata and sidebar mutation p95: **2.44 ms** and **0.078 ms**
- SQLite append median remains approximately 0.3 ms as historical size grows
