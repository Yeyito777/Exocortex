# SQLite conversation store — main synchronization results

Date: 2026-08-03

Branch: `sqlite-conversation-store`

Merged baseline: `main` / `origin/main` at `ba3d155`

This report covers the post-implementation synchronization of current `main` into
the SQLite conversation-store worktree. The worktree remains unmerged and available
for review.

## Merge and architecture reconciliation

- Merged all 29 then-main-only commits with a merge commit rather than rebasing.
- Resolved the only textual conflict in `daemon/src/conversations.ts` by retaining
  both main's unpersisted-stream reconciliation and SQLite's direct page,
  tool-output, and message-count paths.
- Retained the realtime-call manager, external adapters, attributed speaker input,
  transcript reconciliation, exact task stopping, instance-local restart, long
  Unix-socket fallback, and helper-tool rename.
- Classified finalized call utterances and model-hidden call boundaries as canonical
  messages. WebRTC/Bidi transport state, media, partial deltas, participant/speaker
  windows, and active call identity remain ephemeral.
- Confirmed realtime provenance and speaker attribution fit the existing message
  `metadata_json`; no SQLite schema bump was needed.
- Made in-place realtime transcript promotion dirty from the message field so SQLite
  compares and rewrites the edited message sequence instead of treating it as a
  metadata-only mutation.
- Added direct SQLite realtime round-trip/promotion coverage and made the domain test
  reload promoted content from persistence.
- Removed the completed repository/migration program from the remaining-work roadmap
  and added realtime service/schema work plus a single runtime-endpoint contract for
  daemon, TUI, test launcher, and external clients.

## Additional defects found during synchronization

1. **Importer suite isolation.** The full daemon suite intentionally shares one
   isolated config root. The importer test assumed that no other test had left legacy
   fixtures, so it failed only in the full-suite order. Assertions now verify the
   test-owned source IDs while still checking complete import state and integrity.
2. **Deep-worktree `exotest` readiness.** Main's daemon correctly hashed an overlong
   Unix socket to `/tmp`, but `exotest` still polled and removed the hard-coded long
   runtime path. `exotest` now resolves its socket through the same shared helper as
   the daemon and TUI. A cold xenv launch, instance-local restart, full stop, and cold
   reopen all passed with the 42-byte fallback endpoint.
3. **Remaining endpoint duplication.** The separately synchronized external `exo` CLI
   still owns a duplicate socket-path implementation and cannot discover this deep
   worktree's fallback socket through `--instance`. That external tool is linked from
   the main checkout and was not modified outside this worktree. The architecture
   roadmap now requires one endpoint contract/descriptor and a cross-instance
   integration test. This does not affect daemon/TUI operation or SQLite correctness.

## Automated validation

| Gate | Result |
| --- | ---: |
| Root TypeScript typecheck | passed |
| Shared suite | 15 passed, 0 failed |
| TUI suite | 711 passed, 0 failed |
| Default JSON-compatible daemon suite | 813 passed, 2 classified baseline failures |
| Repository/import/differential/schema/fault/maintenance gate | 28 passed, 0 failed |
| Merged SQLite conversation/realtime/call gate | 182 passed, 8 intentional JSON-file skips, 0 failed |
| Broad SQLite canonical matrix | 654 passed, 9 intentional JSON-file skips, 0 failed |
| Sequential feature smoke | 21 passed, 0 failed |
| Performance gate verifier | 13 passed, 0 failed |

The two default-suite failures are unchanged, non-storage environment assumptions:
the repository harness text differs from an exact native-Exo hint assertion, and the
DeepSeek no-key case sees real/stored credentials. Relevant source files are
byte-identical to merged `main`.

The broad SQLite matrix ran 663 tests across 65 behavior/integration files. It
excluded direct JSON persistence/display-projection implementation tests and the two
classified environment-sensitive files. Nine skips explicitly assert obsolete JSON
`.sidebar`, `.unwind`, filesystem-failure, or orphan-tombstone mechanics; those paths
still execute in the default JSON suite.

An exploratory all-file run with SQLite forced was also classified rather than used
as a gate: direct `persistence.test.ts` and `display-page-store.test.ts` cases expect
the compatibility facade itself to write JSON files, so they fail by design when the
process-wide backend is forced to SQLite. No canonical SQLite behavior test failed.

## Real fixture and migration parity

- All 26 immutable fixture file hashes still match.
- Five live-main source paths changed naturally after the snapshot; this is reported
  separately and does not affect copied-fixture integrity.
- Exact migration: **24 conversations, 0 mismatches**.
- Exhaustive display walk: **346 pages, 3,568 entries, 23,377 deferred tool outputs,
  0 cursor/page mismatches, 0 old-image payload violations**.
- Feature smoke used a fresh synthetic prefix and sequentially covered creation,
  append, history paging, metadata, folders, goal lifecycle, queue CRUD, clone, trim,
  rewind, unread/inbox, delete/undo/redo, recursive delete, unwrap, non-executing
  Chrono integration, reopen, and integrity.
- Fixture unread state was restored to both the JSON compatibility snapshot and
  SQLite. Empty synthetic Chrono files were removed.
- Final database: schema 6, 40 live fixture/synthetic conversations, 38,613 messages,
  23,383 separated payload rows, `quick_check=ok`, zero foreign-key errors, WAL mode,
  and a fully checkpointed zero-byte WAL.

## xenv/exotest validation

A fresh nested X11 environment used the worktree's own `exotest` and canonical fixture
database. The following user paths passed:

- indexed startup and a 40-row sidebar/folder snapshot;
- opening a migrated real conversation;
- recent history, older-page loading, and explicit `Ctrl+O` deferred output expansion;
- autocomplete/rendering for `/call`, `/hangup`, and `/mic` without initiating a call;
- `Ctrl+Shift+R` instance-local restart, replacing only the worktree daemon child and
  reconnecting to the same conversation/database;
- complete TUI/daemon stop followed by a cold reopen of the same database;
- final clean shutdown, xenv removal, unread restoration, and integrity check.

Screenshots and logs remain under `/tmp` or gitignored worktree data and are not
committed.

## Performance regression

The fresh 2,000-conversation quick run on Bun 1.3.14 measured:

- low-scale startup/list: JSON 0.223 ms, SQLite 0.639 ms (a 0.416 ms absolute delta);
- 2,000-conversation startup/list: SQLite **4.38x faster**;
- append: SQLite **2.91x faster** at 1 MiB and **38.83x faster** at 10 MiB;
- synthetic storage: 2,375,680 SQLite bytes vs 2,355,483 JSON bytes.

The committed full and 50,000-conversation verifier still passes all 13 gates,
including 4.49x/4.18x startup speedups at 10k/50k, bounded low-scale latency, 28x–306x
large append speedups, and storage/RSS limits.

## Safety and handoff

- The recorded main daemon PID remained unchanged; it was never restarted.
- Main stayed healthy with 2,310 conversations. Its streaming count changed naturally
  from two to three while this worktree was being tested.
- No command mutated main conversation, automation, database, or runtime state; live
  source access was read-only fixture-hash verification and status inspection.
- No worktree daemon, rollback daemon, test process, socket, PID file, or xenv remains.
- No real transcript, title, conversation ID, credential, database, export, log,
  screenshot, socket, PID, or absolute private path is included in this report or the
  new aggregate conversation-store benchmark results.
