# SQLite Conversation Store — Pre-Merge Test TODO

Run this checklist sequentially inside the `sqlite-conversation-store` worktree.
Do not merge, clean the worktree, restart the main daemon, or write to main-instance
conversation data while executing it.

Evidence containing real transcript data, databases, exports, screenshots, PIDs, or
runtime files belongs only under gitignored worktree `config/data/` paths or `/tmp`.
Only aggregate, non-sensitive test results may be committed.

## 1. Safety and test isolation

- [ ] Confirm the current repository is the `sqlite-conversation-store` linked worktree and the Git working tree is initially clean.
- [ ] Record the main daemon PID/status and confirm it is healthy without restarting it.
- [ ] Confirm the worktree daemon is stopped before destructive/offline database tests.
- [ ] Record hashes/metadata for every main source file named in the immutable fixture manifest so post-test drift can be reported without treating ordinary live activity as a test write.
- [ ] Create a fresh gitignored pre-merge evidence directory under the worktree instance.
- [ ] Verify all temporary test configurations resolve outside the main instance data/runtime paths.

## 2. Static and compatibility validation

- [ ] Run the root TypeScript typecheck for shared, daemon, and TUI.
- [ ] Run shared tests with an isolated config root.
- [ ] Run the complete TUI test suite.
- [ ] Run the complete default JSON-compatibility daemon test suite.
- [ ] Record all default-suite failures and prove they are baseline/environment failures rather than SQLite failures.
- [ ] Run `git diff --check` after the static/compatibility pass.

## 3. Schema, migration, and query validation

- [ ] Add a durable importer test that starts from a fresh schema and imports valid legacy v18 JSON.
- [ ] Test an interrupted/partial import containing one corrupt source.
- [ ] Repair the corrupt source and prove the next import resumes without duplicating already imported messages.
- [ ] Change a previously imported source before import completion and prove its hash/generation is re-imported safely.
- [ ] Prove completed import startup performs no legacy conversation scan or re-import.
- [ ] Test import of folders, inherited instructions, unread state, queue state, BTW receipts, and overlay-materialized conversation state.
- [ ] Test migration from each supported schema checkpoint to schema v6.
- [ ] Test rejection of a future schema without modifying the database.
- [ ] Test title-FTS insert, rename, soft-delete filtering, restore, and hard-delete trigger behavior.
- [ ] Test `EXPLAIN QUERY PLAN` uses the intended summary and page indexes.
- [ ] Run `quick_check`, `foreign_key_check`, and schema diagnostics on all migration-test databases.

## 4. Repository differential and transaction testing

- [ ] Run the shared JSON/SQLite repository contract suite.
- [ ] Add a deterministic differential state-machine test that applies the same mutation sequence to JSON and SQLite repositories.
- [ ] Differentially compare metadata, ordered messages, folders, instructions, unread state, queue state, BTW state, tool outputs, recent pages, and older pages after every state-machine checkpoint.
- [ ] Include append, metadata-only save, settings changes, folder moves, queue reorder, unread changes, clone-like copies, soft delete, restore, undo/redo stack operations, and unwind in the state machine.
- [ ] Prove metadata-only saves do not rewrite historical SQLite message rows.
- [ ] Prove ordinary append inserts only the new suffix.
- [ ] Test stale-generation rejection with two independently loaded writers.
- [ ] Run every save fault-injection boundary and compare pre/post logical database state.
- [ ] Run every unwind fault-injection boundary and compare history, receipt, queue, and display state.
- [ ] Run every delete fault-injection boundary and compare live rows, unread/BTW state, and undo/redo stacks.
- [ ] Force abrupt child-process exit inside a transaction and prove WAL recovery on reopen.
- [ ] Verify failed transactions leave no orphan blobs or FTS divergence.

## 5. Exhaustive real-fixture parity

- [ ] Reverify all copied fixture hashes and exclusions.
- [ ] Rerun exact scalar/message/active-context/export parity for all 24 real conversations.
- [ ] Add exhaustive cursor walking that loads every display page for every real conversation from newest to oldest.
- [ ] Compare every walked SQLite page with the JSON compatibility projection.
- [ ] Prove every older-page cursor strictly progresses and terminates without duplicate or missing entries.
- [ ] Compare all deferred tool outputs for every real conversation.
- [ ] Verify old image base64 is absent from compact pages and recent-image semantics remain equal.
- [ ] Verify all fixture goals remain absent and no main Chrono/subscription state exists in the worktree fixture.
- [ ] Run integrity and foreign-key checks after exhaustive reads.

## 6. Full SQLite feature integration

- [ ] Run conversation, queue, handler, BTW, Chrono, external-notification, subagent, restart-recovery, edit-message, and late-join tests with SQLite canonical reads/writes.
- [ ] Confirm only explicitly JSON-file-specific tests are skipped in SQLite mode.
- [ ] Rerun the sequential 21-step worktree feature smoke test from a clean synthetic prefix.
- [ ] Verify create, move, delete, undo, redo, recursive folder delete, unwrap, trim, rewind, goals, queue, unread, external inbox, and synthetic Chrono all pass.
- [ ] Reopen the database after the feature smoke and rerun integrity checks.
- [ ] Restore real-fixture unread state after synthetic/manual testing and rerun the 24-conversation parity verifier.

## 7. Scale, latency, memory, and storage

- [ ] Rerun the final 24-conversation low-scale benchmark.
- [ ] Rerun the 10,000-conversation JSON/SQLite benchmark with seven measured repetitions.
- [ ] Rerun 1/10/50/approximately-100 MiB append benchmarks.
- [ ] Add and run a 50,000-conversation startup/list scale test using deterministic synthetic data.
- [ ] Automatically enforce the approved low-scale median/p95 allowances.
- [ ] Automatically enforce the 10,000-conversation minimum 2x startup/list speedup.
- [ ] Automatically enforce the minimum 5x append speedup at 10/50/approximately-100 MiB.
- [ ] Verify SQLite append latency remains effectively independent of historical size.
- [ ] Record RSS/CPU/storage/WAL metrics and confirm memory does not grow with transcript payload size during summary/page reads.
- [ ] Checkpoint WAL and explain total SQLite storage versus canonical JSON storage.
- [ ] Commit only aggregate synthetic results; scan them for real IDs, titles, and transcript text.

## 8. Backup, restore, export, and rollback drills

- [ ] Run administration diagnostics and integrity checks against the stopped worktree database.
- [ ] Create a new online backup and verify it independently.
- [ ] Restore the backup to a distinct new database and refuse overwrite of existing destinations.
- [ ] Start an isolated SQLite daemon against the restored database and verify ping, list, recent history, older history, and deferred tool output IPC.
- [ ] Export one real conversation to normalized JSON and compare it with canonical SQLite state.
- [ ] Export the complete worktree instance to a fresh isolated directory.
- [ ] Load every exported conversation through the JSON compatibility adapter with zero failures.
- [ ] Start an isolated JSON-backend daemon against the full export and verify ping, list, real history, and folder state.
- [ ] Stop only the isolated rollback daemons and verify their sockets/PIDs are removed.

## 9. xenv/exotest user-path validation

- [ ] Start the worktree through a fresh `xenv` plus `exotest` session.
- [ ] Confirm indexed startup and sidebar/folder rendering.
- [ ] Open at least three migrated real conversations from different folders/providers where available.
- [ ] Navigate newest and older history pages.
- [ ] Expand deferred tool output with `Ctrl+O`.
- [ ] Exercise a worktree-only create/rename/move/delete/undo flow through daemon/TUI-visible paths.
- [ ] Stop the complete worktree session and start it again against the same database.
- [ ] Verify post-restart state and integrity.
- [ ] Stop the test daemon, remove the xenv, and restore fixture unread state.
- [ ] Confirm the main daemon PID never changed during xenv/exotest testing.

## 10. Final safety and handoff

- [ ] Compare post-test main source metadata/hashes with the initial snapshot and report ordinary live drift separately.
- [ ] Confirm no test command wrote a main-instance sidecar, queue, subscription, Chrono, database, or runtime file.
- [ ] Confirm the main daemon is still healthy and was never restarted.
- [ ] Confirm the worktree daemon, rollback daemons, background processes, and xenv are all stopped.
- [ ] Rerun root typecheck, repository/fault tests, fixture parity, integrity checks, and `git diff --check` as the final gate.
- [ ] Scan Git changes for secrets, real transcript text, generated databases, exports, screenshots, sockets, PIDs, and other ignored artifacts.
- [ ] Commit the durable test additions and aggregate reports in reviewable commits.
- [ ] Leave the worktree and gitignored evidence available for user inspection.
- [ ] Do not merge or clean the worktree until the user explicitly approves it.
