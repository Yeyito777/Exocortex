# SQLite Conversation Store — Main Sync TODO

Synchronize current `main` into the `sqlite-conversation-store` worktree, preserve
both sets of behavior, and update the architecture documentation for new durable
conversation semantics introduced on main.

Do not merge this worktree back to main or clean it until the user explicitly
approves the result. Keep real fixture data, databases, logs, and screenshots only
under gitignored worktree `config/data/` paths or `/tmp`.

## 1. Baseline and safety

- [ ] Confirm the repository root, worktree branch, and clean starting state.
- [ ] Confirm local `main` and `origin/main` agree and record branch divergence.
- [ ] Record the main daemon PID/status without restarting it.
- [ ] Confirm the worktree daemon and worktree xenv are stopped before merging.
- [ ] Inventory main-only commits and changed paths that intersect conversation storage, transcript semantics, configuration paths, lifecycle, IPC, and testing.

## 2. Merge current main

- [ ] Merge local `main` into `sqlite-conversation-store` without rebasing or touching the main checkout.
- [ ] Resolve every conflict deliberately, preserving current main behavior and the SQLite canonical repository/cutover.
- [ ] Verify renamed helper-tool files, package dependencies, lockfile state, worktree scripts, and ignore rules landed correctly.
- [ ] Run `git diff --check` and inspect the merge result for dropped changes or conflict markers.

## 3. Storage and architecture reconciliation

- [ ] Trace new realtime-call, attributed-input, transcript-reconciliation, active-stream, task-stop, compaction, and restart behavior through conversation persistence.
- [ ] Verify new message/provider/context fields round-trip through JSON and SQLite without schema loss.
- [ ] Verify new startup/restart and instance-path behavior remains compatible with one SQLite database per instance.
- [ ] Add or adjust regression tests wherever the merged behavior is not already exercised against SQLite.
- [ ] Update the SQLite design, state map, migration, schema, roadmap/TODO, and validation documents for relevant main changes.
- [ ] Explicitly document which realtime-call state is canonical conversation history versus ephemeral transport/session state.

## 4. Automated correctness validation

- [ ] Run root TypeScript typecheck.
- [ ] Run the complete shared test suite under an isolated config root.
- [ ] Run the complete TUI test suite.
- [ ] Run the complete default JSON-compatible daemon test suite and classify any failures.
- [ ] Run repository contract, differential, importer, schema, fault-injection, and maintenance tests.
- [ ] Run conversation, handler, compaction, transcript-merge, realtime-delegation, and call-manager tests with SQLite selected where applicable.
- [ ] Run the SQLite canonical integration matrix and confirm only intentional JSON-file-specific skips remain.

## 5. Fixture, feature, and performance regression

- [ ] Reverify immutable real-fixture hashes and report live-main drift separately.
- [ ] Rerun exact 24-conversation migration parity.
- [ ] Rerun exhaustive cursor/page/tool-output parity and integrity checks.
- [ ] Rerun the sequential SQLite feature smoke from a fresh synthetic prefix.
- [ ] Restore fixture unread state and remove any empty synthetic automation files.
- [ ] Run the quick low/large-scale benchmark and the committed performance gate verifier.
- [ ] Confirm no aggregate result contains real IDs, titles, transcript text, credentials, or absolute private paths.

## 6. xenv/exotest merged user paths

- [ ] Start a fresh worktree `xenv` plus `exotest` session against the merged code and existing SQLite fixture.
- [ ] Verify indexed startup, sidebar/folders, and a migrated real conversation.
- [ ] Verify recent/older history and deferred tool-output expansion.
- [ ] Verify the merged realtime-call commands/rendering are available without initiating an external call.
- [ ] Stop the full session, restart once against the same database, and verify persisted state/integrity.
- [ ] Stop the worktree daemon, remove only the test xenv, and restore fixture unread state.

## 7. Final safety and handoff

- [ ] Confirm the main daemon PID is unchanged and main remains healthy.
- [ ] Confirm no merge/test command mutated main-instance conversation, automation, database, or runtime state.
- [ ] Confirm all worktree/rollback daemons, test processes, and the test xenv are stopped.
- [ ] Rerun final typecheck, targeted repository/fault tests, fixture parity, integrity checks, and `git diff --check`.
- [ ] Scan tracked changes for secrets, real transcript content, databases, exports, screenshots, sockets, PIDs, logs, and other generated artifacts.
- [ ] Write an aggregate main-sync result report and commit durable fixes/docs in reviewable commits.
- [ ] Leave the worktree clean, unmerged, and available for user review.
