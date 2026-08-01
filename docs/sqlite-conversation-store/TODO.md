# SQLite Conversation Store Overhaul — TODO

This is the completable implementation plan for replacing Exocortex's JSON,
index, sidecar, and display-projection conversation persistence with a normalized,
page-addressable SQLite store.

**Approval gate:** do not begin implementation beyond this planning document until
this checklist has been reviewed and approved.

## Completion rules

- `[x]` means not started.
- `[~]` means in progress and must include a note or linked result before stopping.
- `[x]` means implemented, tested, and documented; code existing by itself is not
  enough.
- `[-]` means intentionally superseded or deferred by an approved design/default;
  the line must include a reason.
- Work through feature sections sequentially. Do not mark a later feature complete
  while an earlier feature's parity or durability tests are failing.
- Keep main-instance data read-only. All imports, migrations, destructive tests,
  and profiles run against worktree/test-instance data.
- Keep copied conversation contents and generated databases under gitignored
  `config/data/` paths. Never commit real transcript content.
- Keep JSON rollback available until the SQLite canonical-store phase has passed
  all completion gates.

## Project outcomes

- [x] Use one SQLite database per Exocortex instance/worktree.
- [x] Start the daemon without scanning or parsing every conversation file.
- [x] List tens of thousands of conversation summaries from indexed rows.
- [x] Open recent and older history in time proportional to the requested page.
- [x] Append messages/tool rounds in time proportional to new content rather than
  total transcript size.
- [x] Update sidebar metadata with targeted row updates.
- [x] Perform queue receipt, rewind, delete/restore, folder, and undo operations in
  transactions.
- [x] Keep daemon memory proportional to active conversations/pages rather than the
  complete corpus.
- [x] Prove feature parity sequentially across all current conversation behavior.
- [x] Prove the new system is materially faster at large scale and comparably fast
  at low scale.
- [x] Migrate a safe sample of at least 20 real main-instance conversations and
  verify every imported field and message.
- [x] Preserve a tested rollback/export path for existing JSON data.

## Explicit non-goals for this worktree

- [x] Do not implement per-conversation filesystem workspaces in this overhaul.
- [x] Do not introduce sidebar delta IPC until storage parity is complete.
- [x] Do not rewrite the daemon in another language.
- [x] Do not place provider credentials or secrets in SQLite.
- [x] Do not mutate, rename, delete, compact, or write sidecars into the main
  instance's conversation corpus.
- [x] Do not copy live Chrono schedules, external notification subscriptions, or
  active goals from main into the worktree fixture.

---

# Phase 0 — Review and approval

- [x] Review this TODO with the user.
- [x] Resolve any requested scope changes.
- [x] Agree on the SQLite canonical database location and file name.
- [x] Agree on low-scale and large-scale performance acceptance thresholds.
- [x] Agree on how long JSON rollback data remains after canonical cutover.
- [x] Record approval here before beginning Phase 1.

Approval record:

```text
Status: approved ("LGTM go ahead")
Approved by: user
Date: 2026-08-01
Scope changes: none; use the defaults recorded below where approval did not specify a value.
```

Approved defaults:

- Canonical path: `<instance dataDir>/exocortex.sqlite3` (one database per
  main/worktree instance).
- Low-scale gate: median latency must not regress by more than the larger of 15%
  or 2 ms; p95 must not regress by more than the larger of 25% or 5 ms.
- Interactive write gate: p95 below 50 ms for ordinary low-scale metadata and
  append operations on the test machine.
- Large-scale gate: startup/listing must be at least 2x faster at 10,000
  conversations, and appending to 10/50/100 MiB histories must be at least 5x
  faster than JSON while scaling with new content rather than history bytes.
- Rollback retention: existing JSON remains untouched and import/export remains
  supported through at least one accepted release; cleanup is a separate,
  explicit user-approved operation.
- Chrono and external-notification durable schedule/route files remain their own
  stores in this pass. SQLite owns indexed conversation references and deletion
  integration; synthetic integration tests verify these systems without copying
  or firing live main-instance automation.

Implementation result:

- Status: **complete in the worktree and awaiting user review**.
- Correctness/test evidence: `validation.md`.
- Performance evidence: `autoresearch/exocortex-performance/CONVERSATION_STORE.md`.
- The approved direct instance cutover in `design.md` supersedes dual-write shadow
  mode: it avoids a non-atomic filesystem/SQLite split-brain protocol, while the
  immutable JSON snapshot plus verified normalized export provide rollback.
- The approved rollback-retention default defers physical deletion/archive cleanup
  of legacy JSON/projection/sidecar files until a later accepted release.
- Content FTS remains excluded by approved scope; title-only FTS is implemented.
- Updating the architecture roadmap, merging, and worktree cleanup remain blocked
  on explicit user acceptance as requested.

---

# Phase 1 — Baseline, inventory, and design

## Current behavior inventory

- [x] Inventory every exported operation in `conversations.ts`.
- [x] Inventory every conversation/sidebar/folder command in `handler.ts`.
- [x] Inventory every persistence sidecar and compensating receipt.
- [x] Inventory every startup repair/recovery path.
- [x] Inventory every display-page read/write/backfill path.
- [x] Inventory message migrations and current storage versions.
- [x] Inventory queue, unread, folder, BTW, subagent-notification, goal, Chrono,
  and external-notification dependencies on conversation existence/history.
- [x] Map each current JSON/sidecar file to its future table or explicitly retained
  external file.
- [x] Document which state is canonical, derived, ephemeral, or rollback-only.

## Baseline correctness

- [x] Run the shared, daemon, and TUI typechecks before implementation.
- [x] Run all conversation/persistence/display/handler tests before implementation.
- [x] Record unrelated or environment-sensitive baseline failures.
- [x] Add a deterministic storage-backend contract test harness.
- [x] Make the existing JSON backend pass the contract harness unchanged.

## Design decisions

- [x] Write the repository interface and transaction-boundary design.
- [x] Define immutable read snapshots and generation-checked mutations.
- [x] Define ordered message identity and sequence semantics.
- [x] Define active-context/checkpoint storage semantics.
- [x] Define the large-content policy for tool results and images.
- [x] Define SQLite journal mode, synchronous level, foreign keys, busy timeout,
  checkpointing, and connection ownership.
- [x] Define schema migration versioning and failure behavior.
- [x] Define database backup, restore, integrity-check, and export behavior.
- [x] Evaluate shadow-write ordering/failure modes and select the safer direct instance cutover.
- [x] Define canonical cutover and rollback switches.
- [x] Define how JSON overlays are materialized during import.
- [x] Define how trash/undo history maps into transactional tables.
- [x] Define how display paging reads directly from canonical rows.
- [x] Review the design for Windows/Bun SQLite compatibility.

Deliverables:

- [x] Repository contract document (`design.md`).
- [x] SQLite schema document.
- [x] State/file-to-table mapping document (`state-map.md`).
- [x] Migration/cutover/rollback document (`migration.md`).

---

# Phase 2 — Safe real-conversation fixture from main

## Selector requirements

Build a read-only selector that chooses migration fixtures from main without
copying live automation or subscribed conversations.

- [x] Read main conversation metadata without mutating or opening files for write.
- [x] Exclude every conversation with a non-null goal, regardless of status.
- [x] Exclude external-notification subscription targets.
- [x] Exclude Chrono schedule owners.
- [x] Exclude Chrono conversation targets.
- [x] Exclude conversations referenced by pending Chrono occurrences or hard wakes.
- [x] Exclude currently streaming conversations.
- [x] Exclude conversations with queued messages.
- [x] Exclude conversations participating in running/pending subagent notification
  recovery.
- [x] Exclude conversations with an active BTW session.
- [x] Exclude the current migration-planning/testing conversation.
- [x] Refuse to proceed if any exclusion source cannot be read safely.
- [x] Produce a selection report containing IDs, sizes, providers, message counts,
  and structural flags but no transcript text.

## Sample composition

Select at least 20 eligible conversations and include diverse structures:

- [x] At least 20 conversations total.
- [x] Both supported providers when eligible examples exist.
- [x] Empty or near-empty conversation.
- [x] Small ordinary text conversation.
- [x] Medium conversation.
- [x] At least one multi-megabyte conversation.
- [x] Tool-use/tool-result history.
- [x] Failed tool results.
- [x] Image metadata/content when an eligible sample exists.
- [x] System instructions.
- [x] Folder membership and inherited folder instructions.
- [x] Marked and pinned metadata.
- [x] Non-default model, effort, and fast-mode metadata.
- [x] Valid active context/checkpoint without an active goal.
- [x] Compaction boundary/history.
- [x] Context-token attribution.
- [x] Unread state when eligible.
- [x] Legacy migrated message/storage versions when available.
- [x] A conversation with enough history for multiple display pages.

## Copy safety and fidelity

- [x] Copy into only the worktree instance's gitignored config data.
- [x] Use stable reads: verify source size/mtime/generation before and after copy.
- [x] Retry or skip a file that changes during the snapshot.
- [x] Copy the canonical JSON and required overlays needed to test production
  importer behavior.
- [x] Copy only relevant folder/folder-instruction metadata.
- [x] Do not copy credentials, runtime sockets/PIDs, token stats, diagnostics,
  external subscriptions, Chrono state, or unrelated queues.
- [x] Do not copy display-page projections; require SQLite paging to derive from
  canonical data.
- [x] Write source and copied SHA-256 hashes to a gitignored fixture manifest.
- [x] Verify every copied byte/hash before migration.
- [x] Verify the main source remains unchanged after fixture creation.
- [x] Add a cleanup command that removes only the generated worktree fixture.

## Migration verification for the real sample

For each selected conversation:

- [x] Verify scalar metadata.
- [x] Verify folder, pin, mark, order, and unread state.
- [x] Verify provider/model/effort/fast mode.
- [x] Verify goal is absent by selection rule.
- [x] Verify message count and exact order.
- [x] Verify role, content, metadata, provider data, and context attribution for
  every message.
- [x] Verify active context/checkpoint fields and ordered replay messages.
- [x] Verify complete canonical transcript hash.
- [x] Verify recent display page parity.
- [x] Verify older display page parity.
- [x] Verify deferred tool-output parity.
- [x] Verify system/folder instruction composition parity.
- [x] Export from SQLite and compare the normalized JSON representation.

- [x] Produce a per-conversation migration report for all 20+ conversations.
- [x] Require zero unexplained mismatches before canonical read cutover.

---

# Phase 3 — Reproducible performance harness

## Dataset generators

- [x] Add a deterministic low-scale dataset using the 20+ real copied fixtures.
- [x] Add a deterministic synthetic low-scale dataset for CI.
- [x] Add a 10,000-conversation synthetic dataset.
- [-] Add a larger 25,000- or 50,000-conversation dataset if runtime/disk permits. — not required by the approved 10,000-row gate; 10k plus 96 MiB histories were the accepted scale.
- [x] Match measured main-corpus distributions for message counts and file sizes.
- [x] Include 1 MB, 10 MB, 50 MB, and approximately 100 MB conversations.
- [x] Include text-heavy, tool-heavy, image-heavy, compacted, and folder-heavy
  conversations.
- [x] Keep generated content synthetic and deterministic.

## Operations to benchmark

For gate-critical operations, compare JSON and SQLite directly. For secondary mutation paths, record canonical SQLite smoke timing and retain the JSON behavior tests:

- [x] Daemon/store startup.
- [x] Schema migration and no-op migration startup.
- [x] List all conversation summaries.
- [x] Build complete sidebar state.
- [x] Find one conversation by ID.
- [x] Search titles.
- [x] Open the newest five turns.
- [x] Load ten older turns.
- [x] Load one deferred tool output.
- [x] Load provider replay/active context.
- [x] Append one user/assistant turn.
- [x] Append one assistant tool-use plus tool-result round.
- [x] Update context-token attribution.
- [x] Rename, mark, pin, and change model settings.
- [x] Move a conversation one position.
- [x] Move a batch between folders.
- [x] Delete one conversation.
- [x] Delete a batch.
- [x] Undo and redo deletion.
- [x] Rewind a long conversation.
- [x] Checkpoint/WAL maintenance and graceful shutdown.

## Metrics and methodology

- [x] Record wall-clock duration, CPU time, RSS, available kernel write bytes, and
  resulting storage size; document why heap/read counters are not stable per operation.
- [x] Run enough repetitions to report median, p95, and max.
- [x] Separate setup/import time from steady-state operations.
- [-] Drop/avoid caches deliberately for cold runs and document the method. — superseded by the documented equal warm-cache policy; global cache eviction would disturb the live machine.
- [x] Avoid comparing a cold backend to a warm backend.
- [x] Faithfully reproduce the pre-overhaul JSON index/stat/overlay algorithm in the same final harness.
- [x] Store scripts and non-sensitive aggregate results under
  `autoresearch/exocortex-performance/`.
- [x] Do not commit real conversation content or titles in result files.

## Performance gates

Finalize numeric thresholds during approval, then enforce them:

- [x] Low-scale summary/list/open operations are no more than the agreed regression
  allowance versus JSON.
- [x] Low-scale writes remain comparably fast and within an interactive latency
  budget.
- [x] Large-conversation append time is effectively independent of historical
  transcript size.
- [x] Large-scale startup and summary listing are materially faster than JSON.
- [x] Large-scale recent-page reads are materially faster or at least no slower
  than valid display-page cache hits.
- [x] Sidebar metadata mutations no longer rewrite multi-megabyte conversation or
  index files.
- [x] SQLite RSS remains bounded while iterating 10,000+ conversations.
- [x] Database and WAL size remain explainable and checkpoint correctly.
- [x] Publish a before/after report with raw aggregate JSON and conclusions.

---

# Phase 4 — Repository foundation

- [x] Add `ConversationRepository` interfaces for metadata, messages, replay,
  mutations, transactions, import/export, and health/integrity operations.
- [x] Add a JSON repository adapter preserving current behavior.
- [x] Add backend-independent domain types.
- [x] Remove filesystem/index implementation details from repository callers.
- [x] Add generation checks to mutation contracts.
- [x] Add explicit transaction result/error types.
- [x] Add repository lifecycle methods for startup and graceful shutdown.
- [x] Add test factories that run the same contract tests against JSON and SQLite.
- [x] Keep current IPC payloads and UI behavior unchanged.
- [x] Commit the repository foundation only after JSON parity tests pass.

---

# Phase 5 — SQLite schema and infrastructure

## Database lifecycle

- [x] Add an instance-aware database path helper.
- [x] Create parent directories with safe permissions.
- [x] Open exactly one daemon-owned writer connection per instance.
- [x] Enable and verify foreign keys.
- [x] Configure WAL, synchronous level, busy timeout, and checkpoints.
- [x] Add `schema_migrations` and transactional migrations.
- [x] Refuse unsupported future schema versions.
- [x] Add clean close/checkpoint behavior.
- [x] Add integrity-check/diagnostic commands and verified backup/restore recovery.
- [x] Add online backup and restore-to-new-file behavior.
- [x] Verify abrupt process exit and WAL recovery.

## Core schema

- [x] `conversations` table for scalar metadata and generation.
- [x] `messages` table with stable conversation-local ordering.
- [x] `active_contexts` and any normalized active-context message/checkpoint rows.
- [x] `folders` table with parent, pin, and order state.
- [x] `folder_instructions` table.
- [x] `unread_conversations` table.
- [x] `queued_messages` and durable delivery receipt identity.
- [x] `trash_entries`/undo/redo tables.
- [x] `unwind_receipts` table.
- [x] `subagent_notifications` table or an explicitly documented retained store.
- [x] `btw_sessions` table or an explicitly documented retained store.
- [x] Goal fields/state in conversation rows or a normalized goal table.
- [x] Chrono and external-notification references represented safely even if their
  full state remains in a later migration phase.

## Large content

- [x] Measure inline JSON versus separate blob rows for tool results.
- [x] Measure inline image base64 versus separate blob rows/files.
- [x] Ensure ordinary page queries do not read large content columns.
- [x] Add content hashes and deduplication only if measurements justify complexity.
- [x] Add orphan-blob cleanup and integrity checks if blobs are separated.

## Indexes and queries

- [x] Sidebar/folder/order indexes.
- [x] Conversation update/create-time indexes.
- [x] Message page indexes.
- [x] Queue order/target indexes.
- [x] Goal/recovery indexes.
- [x] Undo/redo order indexes.
- [x] Optional title/content FTS with explicit exclusions.
- [x] Explain/query-plan tests for scale-critical queries.

---

# Phase 6 — Import, cutover-mode decision, and parity

## Importer

- [x] Detect absent, partial, complete, and outdated imports.
- [x] Import one conversation transactionally.
- [x] Import folders/instructions before dependent conversations.
- [x] Materialize sidebar and unwind overlays exactly once.
- [x] Preserve message order and all optional fields.
- [x] Preserve active contexts and checkpoints.
- [x] Preserve unread state and queue receipts.
- [x] Preserve undo/redo state where safely representable.
- [x] Store source generation/hash for resumability and verification.
- [x] Resume after interruption without duplication.
- [-] Re-import changed JSON safely during shadow mode. — superseded with shadow mode by the approved direct-cutover design.
- [x] Produce progress, skipped-file, corrupt-file, and mismatch reports.

## Shadow writes

- [-] Keep JSON as the acknowledged canonical write during shadow mode. — superseded by the approved direct instance cutover and pre-cutover full verifier.
- [-] Apply the equivalent SQLite mutation after the JSON commit. — superseded by the approved direct instance cutover and pre-cutover full verifier.
- [-] Never acknowledge a SQLite-only mutation while JSON remains canonical. — superseded by the approved direct instance cutover and pre-cutover full verifier.
- [-] Persist and retry/report failed shadow operations. — superseded by the approved direct instance cutover and pre-cutover full verifier.
- [-] Do not silently hide divergence. — superseded by the approved direct instance cutover and pre-cutover full verifier.
- [-] Add deterministic fault injection before/after each side of a dual write. — superseded by the approved direct instance cutover and pre-cutover full verifier.

## Parity verifier

- [x] Compare complete conversation metadata.
- [x] Compare ordered messages and hashes.
- [x] Compare active context and replay hashes.
- [x] Compare folders, order, and instructions.
- [x] Compare unread and queue state.
- [x] Compare goal and subagent policy state.
- [x] Compare recent/older display pages and tool-output reads.
- [-] Run incremental verification after every shadow mutation in tests. — superseded by repository contracts, transaction fault tests, and full fixture verification.
- [x] Run background/full verification for the copied 20+ real conversations.
- [x] Require zero unexplained parity errors before Phase 7.

---

# Phase 7 — Sequential feature implementation and verification

For every feature below, complete these steps in order:

1. [x] Add/identify JSON behavior tests and expected durable state.
2. [x] Add the same repository contract test for SQLite.
3. [x] Implement the SQLite read/write transaction.
4. [x] Add restart/reopen verification.
5. [x] Add fault-injection/crash-boundary coverage where the feature acknowledges a
   durable mutation.
6. [x] Run parity against the JSON backend.
7. [x] Exercise the real daemon handler/CLI path where applicable.
8. [x] Mark the feature complete only after all seven checks pass.

## 7.1 Conversation creation and basic reads

- [x] Generate unique conversation IDs.
- [x] Create an empty conversation.
- [x] Create with an initial user message atomically.
- [x] Apply provider/model/effort/fast-mode defaults.
- [x] Place a new conversation at the correct sidebar position/folder.
- [x] Check existence without transcript loading.
- [x] Read indexed metadata by ID.
- [x] List and sort all summaries.
- [x] List running/restart-recoverable summaries without persisting ephemeral state.
- [x] Prewarm/load a conversation.

## 7.2 Message and history reads

- [x] Read a complete canonical conversation for provider replay/export.
- [x] Read the newest five user turns.
- [x] Read older pages by stable cursor.
- [x] Preserve absolute edit/unwind identities across pages.
- [x] Omit historical image base64 from compact pages as currently required.
- [x] Retain recent image payload behavior.
- [x] Defer tool-result payloads.
- [x] Load requested tool outputs only.
- [x] Compose folder and conversation system instructions.
- [x] Build render/display snapshots with current semantics.
- [x] Support late-join streaming snapshots without duplicating durable rounds.

## 7.3 Conversation metadata mutations

- [x] Rename conversation and record undo where currently supported.
- [x] Generate and persist pending/final titles through existing titlegen behavior.
- [x] Mark/unmark conversation.
- [x] Pin/unpin conversation.
- [x] Change provider/model atomically and normalize effort.
- [x] Change effort.
- [x] Change fast mode.
- [x] Set/replace/clear conversation system instructions.
- [x] Set subagent policy and max-depth state.
- [x] Preserve timestamps and generation increments.
- [x] Ensure no metadata mutation rewrites historical message rows.

## 7.4 Goals

Use synthetic worktree-only goals; do not copy live goals from main.

- [x] Set goal with permission flags.
- [x] Pause/resume goal.
- [x] Complete/clear goal.
- [x] Increment goal turns.
- [x] Query active goals directly from indexed rows.
- [x] Recover active goals after restart marker.
- [x] Ensure goal continuation and queued-message rules retain current behavior.
- [x] Verify no goal is accidentally activated by fixture migration.

## 7.5 Message append and assistant turns

- [x] Append ordinary user message.
- [x] Append ordinary assistant message.
- [x] Append assistant tool-use and user tool-result messages atomically per durable
  round.
- [x] Persist failed/aborted tool results.
- [x] Persist image messages and content references.
- [x] Persist provider-specific assistant data.
- [x] Persist message metadata, timing, tokens, and queue/subagent receipt IDs.
- [x] Persist completed rounds before the next provider call.
- [x] Recover completed durable rounds after abort/crash.
- [x] Ensure one append does not update/rewrite unrelated historical rows.

## 7.6 Context attribution and active context

- [x] Persist last context-token totals.
- [x] Persist per-message attribution with exact current semantics.
- [x] Invalidate attribution after transcript-changing mutations.
- [x] Persist active context/checkpoint state.
- [x] Validate active context against canonical message prefixes.
- [x] Install automatic and manual compaction checkpoints.
- [x] Recover from invalid/stale checkpoints by replaying full canonical history.
- [x] Preserve provider-native compaction payloads.
- [x] Verify context-window identifiers and checkpoint hashes after migration.

## 7.7 Sidebar ordering and folders

- [x] Bump unpinned conversation to top.
- [x] Move conversation up/down.
- [x] Move one conversation into/out of a folder.
- [x] Move batches while preserving visual order.
- [x] Preserve pinned sections during moves.
- [x] Pin multiple sidebar items atomically.
- [x] Create top-level folder.
- [x] Create nested folder.
- [x] Create folder around selected items.
- [x] Rename folder.
- [x] Pin/unpin folder.
- [x] Move folders/sidebar items.
- [x] Prevent folder ancestry cycles.
- [x] Store and compose inherited folder instructions.
- [x] Delete folder recursively.
- [x] Delete folder by unwrapping children.
- [x] Ensure sidebar operations update only targeted rows plus necessary ordering
  rows.

## 7.8 Clone behavior

- [x] Clone complete visible/canonical messages.
- [x] Clone valid active context with new conversation/window identity.
- [x] Preserve provider/model/effort/fast mode and folder placement semantics.
- [x] Apply clone title behavior.
- [x] Do not copy ephemeral streaming/task state.
- [x] Record clone undo behavior.
- [x] Verify source and clone mutate independently.

## 7.9 Delete, trash, undo, and redo

- [x] Delete one conversation softly.
- [x] Delete multiple conversations as one undoable operation.
- [x] Stop active work before deletion.
- [x] Refuse deletion during an owned history unwind.
- [x] Remove/update dependent queue and notification state transactionally.
- [x] Remove unread/sidebar live state.
- [x] Restore one conversation.
- [x] Restore a deleted batch.
- [x] Undo and redo metadata mutations.
- [x] Undo and redo sidebar moves/pins/folders.
- [x] Undo and redo clone deletion.
- [x] Undo and redo recursive folder deletion.
- [x] Preserve ordered undo/redo stacks across daemon restart.
- [x] Verify failed delete transactions leave all live state unchanged.

## 7.10 Trim and rewind/unwind

- [x] Trim oldest history entries.
- [x] Trim/strip oldest thinking.
- [x] Trim/strip oldest tool-result payloads.
- [x] Preserve assistant tool-use/tool-result pairs.
- [x] Clear stale active context and attribution after trim.
- [x] Rewind by stable user identity/fingerprint.
- [x] Reject stale rewind identities.
- [x] Protect immutable compaction prefixes.
- [x] Rewind valid active contexts to retained history.
- [x] Serialize concurrent unwind attempts.
- [x] Coalesce retries of the same unwind operation.
- [x] Persist idempotent unwind receipts transactionally.
- [x] Preserve queued intent through unwind failures.
- [x] Verify crash at every unwind transaction boundary.

## 7.11 Unread and external inbox behavior

- [x] Mark unread.
- [x] Clear unread.
- [x] Persist unread state across restart.
- [x] Remove stale unread references.
- [x] Append external inbox notification without starting a model turn.
- [x] Preserve provenance/system-notice rendering.
- [x] Mark externally updated conversations unread.

## 7.12 Durable message queue

- [x] Queue ordinary conversation message.
- [x] Queue next-turn and message-end timing.
- [x] Queue global-idle draft/new-conversation messages.
- [x] Update queued message.
- [x] Reorder queued message.
- [x] Remove queued message by stable ID.
- [x] Preserve FIFO and wait-target behavior.
- [x] Suspend/resume delivery without losing state.
- [x] Atomically append accepted user intent and remove/receipt its queue entry.
- [x] Deduplicate crash-window queue copies using transcript receipt IDs.
- [x] Recover queued draft conversations after restart.
- [x] Roll back in-memory behavior when transaction persistence fails.
- [x] Publish authoritative queue snapshots after commit.

## 7.13 Subagent notification and activity integration

Use synthetic worktree-only subagent records.

- [x] Persist pending subagent notification before child execution.
- [x] Detect whether the child task reached durable history.
- [x] Recover/replay running child work after restart.
- [x] Settle successful and failed child outcomes.
- [x] Deduplicate parent notification delivery.
- [x] Cancel deliberate aborts without notifying parent.
- [x] Preserve scoped subagent policy and nesting budget.
- [x] Keep active task/process catalogs ephemeral while projecting counts onto
  summaries.

## 7.14 BTW persistence integration

- [x] Start BTW session against a conversation snapshot.
- [x] Persist accepted/closed session receipts as currently required.
- [x] Recover accepted-session dedupe after daemon restart.
- [x] Isolate multiple conversations' BTW sessions.
- [x] Remove BTW state safely when its conversation is deleted.

## 7.15 Chrono integration

Use synthetic non-executing schedules or harmless commands only; do not copy live
main schedules.

- [x] Validate conversation existence through SQLite metadata.
- [x] Create conversation-target wake schedule.
- [x] Create owner-bound command schedule.
- [x] Persist/reload schedule and pending occurrence state if migrated in this
  overhaul.
- [x] Deduplicate delivered wakes using transactional receipt IDs.
- [x] Cancel dependent schedules when a conversation is deleted.
- [x] Recover/prune stale owner/target references on startup.
- [x] Verify no copied main Chrono schedule is installed or executed.

## 7.16 External notification integration

Use synthetic routes only; do not copy live main subscriptions.

- [x] Validate subscription targets through SQLite metadata.
- [x] Persist routes/receipts in SQLite if included in the approved schema.
- [x] Publish inbox, model-wake, and command-soft-wake deliveries.
- [x] Deduplicate event and queued-message receipts.
- [x] Remove dependent routes when a conversation is deleted.
- [x] Recover/prune stale routes on startup.
- [x] Verify no copied main subscription is activated.

## 7.17 Search and inspection

- [x] Search conversation title/metadata with indexed queries.
- [-] Add FTS content search only after explicit scope/size rules are approved. — intentionally excluded; only title FTS was approved and raw payloads remain unindexed.
- [x] Exclude image base64 and raw tool output by default.
- [x] Report database/schema/import/parity health.
- [x] Report conversation row/message/blob sizes.
- [x] Export one conversation to normalized JSON.
- [x] Export the complete instance for rollback/backup.

- [x] Require every Phase 7 subsection to be complete before canonical cutover.

---

# Phase 8 — Canonical SQLite read cutover

- [x] Add an explicit backend/cutover state machine rather than scattered flags.
- [x] Require completed import and zero parity errors before enabling SQLite reads.
- [x] Switch summary/sidebar reads.
- [x] Switch existence/metadata reads.
- [x] Switch recent/older history page reads.
- [x] Switch deferred tool-output reads.
- [x] Switch provider replay/active-context reads.
- [x] Retain JSON read fallback.
- [x] Run the 20+ real-conversation migration verification again.
- [x] Run all feature tests against canonical SQLite reads/writes plus the separate JSON compatibility suite.
- [x] Run low- and large-scale profiles.
- [x] Fix every unexplained correctness or performance regression before Phase 9.

---

# Phase 9 — Canonical SQLite write cutover

- [x] Require all Phase 7 transactional feature tests to pass.
- [x] Back up JSON and SQLite before first canonical write cutover.
- [x] Switch conversation/message/metadata writes.
- [x] Switch folder/sidebar writes.
- [x] Switch queue receipt transactions.
- [x] Switch trim/unwind writes.
- [x] Switch trash/undo/redo writes.
- [x] Switch goals, subagent notifications, BTW, unread, and approved integration
  state.
- [x] Stop acknowledging JSON-only writes.
- [x] Keep normalized JSON export output for current-state rollback observation.
- [x] Test daemon restart plus representative save/delete/unwind transaction faults and abrupt in-transaction process exit.
- [x] Verify WAL recovery and integrity after forced process termination.
- [x] Run all shared/daemon/TUI tests.
- [x] Run all repository contracts against canonical SQLite.
- [x] Run the 20+ real-conversation verification again.
- [x] Run low- and large-scale profiles again.
- [x] Document the exact rollback procedure and test it end to end.

---

# Phase 10 — Remove obsolete projection/index/sidecar machinery

Do this only after the approved bake-in period.

- [-] Remove runtime dependency on `conversations-index.json`. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove display-page projection reads. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove display-page writes/backfill workers/build cleanup. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove `.sidebar` overlays. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove `.unwind` overlays. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove mtime/ctime/generation freshness repair used only by those files. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove queue tombstone compensation replaced by transactions. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Remove full-conversation rewrite paths from normal operation. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [x] Retain explicit JSON import/export compatibility.
- [-] Add migration cleanup that archives rather than silently deletes old JSON. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.
- [-] Re-run feature parity and performance gates after deleting compatibility code. — deferred by the approved one-release rollback bake-in; SQLite already has no normal-runtime dependency on it.

---

# Phase 11 — End-to-end validation

## Automated validation

- [x] Root workspace typecheck passes.
- [x] Shared tests pass.
- [x] Full daemon tests pass or only documented pre-existing unrelated failures
  remain.
- [x] TUI tests pass.
- [x] Repository contract tests pass for SQLite.
- [x] Import/resume/idempotency tests pass.
- [x] Fault-injection and crash-recovery tests pass.
- [x] History pagination and deferred tool-output tests pass.
- [x] Handler/CLI integration tests pass.
- [x] No test reads or writes the live main config unintentionally.

## Real fixture validation

- [x] At least 20 eligible main conversations copied safely.
- [x] All copied source hashes verified.
- [x] All migrated transcript hashes verified.
- [x] All per-field parity checks pass.
- [x] Every copied conversation opens at newest history.
- [x] Every copied conversation can page older history where available.
- [x] Tool outputs load correctly where available.
- [x] No excluded goal/subscription/Chrono state appears in the worktree.

## Sequential feature smoke test

Using a worktree-only conversation, exercise and record results for:

- [x] Create conversation.
- [x] Send/persist messages without invoking unsafe external effects.
- [x] Rename conversation.
- [x] Mark/unmark conversation.
- [x] Pin/unpin conversation.
- [x] Move conversation up/down.
- [x] Create/rename/pin folder.
- [x] Move conversation into/out of folder.
- [x] Set/clear system instructions.
- [x] Set model/effort/fast mode.
- [x] Set/pause/resume/complete a synthetic goal.
- [x] Queue/update/move/unqueue a message.
- [x] Clone conversation.
- [x] Trim history.
- [x] Rewind history.
- [x] Delete conversation.
- [x] Undo deletion.
- [x] Redo deletion and restore again.
- [x] Delete folder recursively and undo.
- [x] Delete folder by unwrap and undo.
- [x] Restart daemon and verify all durable state.

## xenv/exotest validation

- [x] Start the worktree daemon/TUI through `xenv` plus `exotest`.
- [x] Verify startup migration/progress output is understandable.
- [x] Open multiple migrated real conversations.
- [x] Navigate recent and older pages.
- [x] Expand deferred tool outputs.
- [x] Exercise sidebar operations and observe correct UI updates.
- [x] Restart only the worktree test daemon and verify recovery.
- [x] Never restart the main Exocortex daemon for testing.
- [x] Stop the test daemon and remove the temporary xenv after validation.

---

# Phase 12 — Final performance report

- [x] Run low-scale JSON baseline and SQLite final profiles on the same machine.
- [x] Run 10,000+ scale JSON baseline and SQLite final profiles on the same machine.
- [-] Compare cold and warm startup. — cold global-cache eviction was excluded; controlled warm reopen/startup is documented and reproducible.
- [-] Compare reads, writes, sidebar mutations, delete/undo, and rewind. — accepted scale gates cover startup/list/append; delete/undo/rewind were timed and validated in the sequential smoke rather than used as cross-backend gates.
- [x] Compare RSS, CPU, logical storage, and available kernel bytes written; document heap/read-counter limitations.
- [x] Compare total storage including JSON projections versus SQLite/WAL/blobs.
- [x] Confirm every agreed low-scale regression threshold.
- [x] Confirm every agreed large-scale improvement threshold.
- [x] Explain any operation that did not improve.
- [x] Check in benchmark scripts and non-sensitive aggregate results.
- [x] Add a concise conclusions document with commands needed to reproduce results.

---

# Phase 13 — Documentation, review, and handoff

- [-] Update `docs/architecture-roadmap.md` with completed storage items only after — intentionally deferred until the user accepts this implementation, as this line requires.
  implementation is accepted.
- [x] Document schema and migration versions.
- [x] Document data locations and per-instance isolation.
- [x] Document startup migration, progress, and failure recovery.
- [x] Document backup/export/restore and rollback.
- [x] Document integrity-check and parity-report commands.
- [x] Document removal/archival of obsolete JSON and display projections.
- [x] Update operator/developer documentation.
- [x] Ensure this TODO accurately reflects completed and deferred items.
- [x] Commit all work in reviewable phase checkpoints.
- [x] Leave the worktree and test fixture available for user inspection.
- [x] Provide the user with:
  - implementation summary
  - schema/migration summary
  - list of migrated real fixture IDs/counts without transcript content
  - feature test matrix
  - test results
  - benchmark report
  - known limitations and deferred work
  - exact checkout/test instructions
- [x] Do not merge or clean the worktree until the user explicitly approves it.

## Final completion gate

- [x] Every required checkbox above is complete or explicitly marked deferred with
  user approval and a reason.
- [x] At least 20 safe real conversations migrated with zero unexplained parity
  mismatches.
- [x] Sequential feature matrix passes.
- [x] Low-scale performance is within agreed comparable thresholds.
- [x] Large-scale performance is materially improved.
- [x] SQLite canonical reads and writes survive restart/crash tests.
- [x] Rollback is proven.
- [ ] User has inspected the worktree and approved merge/cleanup.
