# SQLite Conversation Store — Pre-Merge Validation Results

Date: 2026-08-01

Worktree: `sqlite-conversation-store`

Result: **pass; ready for review, not merged**

All real transcripts, copied files, databases, exports, logs, screenshots, process
metadata, and per-conversation reports remain under gitignored worktree `config/data/`
or `/tmp`. Git contains only source, tests, documentation, and aggregate synthetic
benchmark results.

## Safety and isolation

- Main remained online and healthy; its PID was unchanged from the initial snapshot
  through final validation. It was never restarted.
- Every mutating daemon/CLI command explicitly targeted the worktree instance or an
  isolated restore/export config. No test command targeted main conversation state,
  sidecars, queue, subscriptions, Chrono state, database, or runtime paths.
- The 26 immutable fixture files still match their copied hashes. A post-test read-only
  comparison of the corresponding live main paths found 23 unchanged paths and three
  ordinary live drifts: two actively changed conversations and one folded/removed
  sidebar overlay. None affects the immutable worktree fixture.
- The worktree daemon, both rollback daemons, test background processes, and the
  `sqlite-store-test` xenv are stopped. The unrelated xenv owned by another worktree
  was left untouched.

## Correctness gates

- Root TypeScript typecheck: **pass**.
- Shared tests: **13 pass, 0 fail**.
- TUI tests: **673 pass, 0 fail**.
- Default JSON daemon suite: **744 pass** with two documented, unrelated
  environment/baseline failures and no SQLite regression.
- SQLite canonical integration matrix: **167 pass, 0 fail, 9 intentional
  JSON-file-specific skips**.
- Final repository/import/schema/fault suite: **27 pass, 0 fail**.
- Sequential feature smoke: **21 pass, 0 fail**.
- Real fixture migration parity: **24 conversations, 0 mismatches**.
- Exhaustive fixture history walk: **346 pages, 3,568 entries, 23,377 deferred tool
  outputs, 0 cursor gaps/duplicates, 0 old-image payload violations, 0 mismatches**.
- Final database: **35 live conversations, 38,602 messages, 23,382 payload rows,
  20 folders, `quick_check=ok`, 0 foreign-key errors, 0-byte WAL after checkpoint**.

The new differential test found one real implementation defect during this pass:
SQLite unwind updated transcript rows but retained the old indexed `message_count`.
The store now writes the domain-calculated visible message count in the same unwind
transaction, and all differential/fault/parity gates pass afterward.

## Import, schema, and transaction coverage

- Fresh v18 import; partial import with a corrupt source; repair/resume; changed-source
  reimport before completion; completed-import no-scan startup.
- Folder/instruction, overlay, unread, queue, BTW, and unwind materialization.
- Every schema checkpoint from v1 through v6; future-version refusal without mutation.
- Title FTS insert, rename, soft-delete filtering, restore, and hard-delete cleanup.
- Targeted metadata save and suffix-only append behavior.
- Every save, unwind, and delete fault boundary with logical-state, blob, FTS,
  auxiliary-state, and history-stack rollback checks.
- Abrupt child exit inside a transaction followed by WAL recovery and integrity checks.

## Backup, restore, export, and rollback

- Online backup verified independently and restored to a distinct database.
- Existing-destination overwrite refusal passed.
- An isolated SQLite daemon against the restore passed ping, summary/folder listing,
  recent history, older history, and deferred-tool-output IPC.
- One real normalized export matched canonical SQLite state exactly.
- The full 34-conversation pre-xenv export loaded **34/34** through the JSON adapter
  with zero failures and 19 folders.
- An isolated JSON daemon against that export passed equivalent real-history and
  folder IPC before clean shutdown.

## xenv/exotest user paths

Two complete worktree `xenv` + `exotest` sessions validated:

- indexed startup and folder/sidebar rendering
- three migrated real conversations across root and two different nested folders
- both OpenAI and DeepSeek history
- recent rendering, older-page backfill, and manual older navigation
- deferred tool output expansion with `Ctrl+O`
- worktree-only folder create plus conversation create, rename, move, delete, and undo
- restored title/folder visibility
- persistence after a complete daemon/TUI stop and fresh restart
- final integrity and fixture unread-state restoration

## Performance gates

The automated verifier reports **13 passed, 0 failed**:

- low scale: +0.874 ms median and +0.906 ms p95, within the approved +2/+5 ms bounds
- 10,000 startup/list: **4.49x faster**
- 50,000 startup/list: **4.18x faster**
- 10 MiB append: **28.3x faster**
- 50 MiB append: **148.0x faster**
- 96 MiB append: **305.7x faster**
- append median historical-size spread: **1.16x** across 1–96 MiB
- metadata write p95: **3.275 ms**
- 10k SQLite/JSON storage ratio: **0.957x**

See `../validation.md`,
`../../../autoresearch/exocortex-performance/CONVERSATION_STORE.md`, and
`../../../autoresearch/exocortex-performance/results/conversation-store-gates.json`
for the durable reports. Detailed/private evidence remains in the gitignored
`config/data/instances/sqlite-conversation-store/pre-merge/` directory.
