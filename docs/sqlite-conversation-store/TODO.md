# SQLite Conversation Store Overhaul — TODO

This is the completable implementation plan for replacing Exocortex's JSON,
index, sidecar, and display-projection conversation persistence with a normalized,
page-addressable SQLite store.

**Approval gate:** do not begin implementation beyond this planning document until
this checklist has been reviewed and approved.

## Completion rules

- `[ ]` means not started.
- `[~]` means in progress and must include a note or linked result before stopping.
- `[x]` means implemented, tested, and documented; code existing by itself is not
  enough.
- Work through feature sections sequentially. Do not mark a later feature complete
  while an earlier feature's parity or durability tests are failing.
- Keep main-instance data read-only. All imports, migrations, destructive tests,
  and profiles run against worktree/test-instance data.
- Keep copied conversation contents and generated databases under gitignored
  `config/data/` paths. Never commit real transcript content.
- Keep JSON rollback available until the SQLite canonical-store phase has passed
  all completion gates.

## Project outcomes

- [ ] Use one SQLite database per Exocortex instance/worktree.
- [ ] Start the daemon without scanning or parsing every conversation file.
- [ ] List tens of thousands of conversation summaries from indexed rows.
- [ ] Open recent and older history in time proportional to the requested page.
- [ ] Append messages/tool rounds in time proportional to new content rather than
  total transcript size.
- [ ] Update sidebar metadata with targeted row updates.
- [ ] Perform queue receipt, rewind, delete/restore, folder, and undo operations in
  transactions.
- [ ] Keep daemon memory proportional to active conversations/pages rather than the
  complete corpus.
- [ ] Prove feature parity sequentially across all current conversation behavior.
- [ ] Prove the new system is materially faster at large scale and comparably fast
  at low scale.
- [ ] Migrate a safe sample of at least 20 real main-instance conversations and
  verify every imported field and message.
- [ ] Preserve a tested rollback/export path for existing JSON data.

## Explicit non-goals for this worktree

- [ ] Do not implement per-conversation filesystem workspaces in this overhaul.
- [ ] Do not introduce sidebar delta IPC until storage parity is complete.
- [ ] Do not rewrite the daemon in another language.
- [ ] Do not place provider credentials or secrets in SQLite.
- [ ] Do not mutate, rename, delete, compact, or write sidecars into the main
  instance's conversation corpus.
- [ ] Do not copy live Chrono schedules, external notification subscriptions, or
  active goals from main into the worktree fixture.

---

# Phase 0 — Review and approval

- [ ] Review this TODO with the user.
- [ ] Resolve any requested scope changes.
- [ ] Agree on the SQLite canonical database location and file name.
- [ ] Agree on low-scale and large-scale performance acceptance thresholds.
- [ ] Agree on how long JSON rollback data remains after canonical cutover.
- [ ] Record approval here before beginning Phase 1.

Approval record:

```text
Status: awaiting review
Approved by:
Date:
Scope changes:
```

---

# Phase 1 — Baseline, inventory, and design

## Current behavior inventory

- [ ] Inventory every exported operation in `conversations.ts`.
- [ ] Inventory every conversation/sidebar/folder command in `handler.ts`.
- [ ] Inventory every persistence sidecar and compensating receipt.
- [ ] Inventory every startup repair/recovery path.
- [ ] Inventory every display-page read/write/backfill path.
- [ ] Inventory message migrations and current storage versions.
- [ ] Inventory queue, unread, folder, BTW, subagent-notification, goal, Chrono,
  and external-notification dependencies on conversation existence/history.
- [ ] Map each current JSON/sidecar file to its future table or explicitly retained
  external file.
- [ ] Document which state is canonical, derived, ephemeral, or rollback-only.

## Baseline correctness

- [ ] Run the shared, daemon, and TUI typechecks before implementation.
- [ ] Run all conversation/persistence/display/handler tests before implementation.
- [ ] Record unrelated or environment-sensitive baseline failures.
- [ ] Add a deterministic storage-backend contract test harness.
- [ ] Make the existing JSON backend pass the contract harness unchanged.

## Design decisions

- [ ] Write the repository interface and transaction-boundary design.
- [ ] Define immutable read snapshots and generation-checked mutations.
- [ ] Define ordered message identity and sequence semantics.
- [ ] Define active-context/checkpoint storage semantics.
- [ ] Define the large-content policy for tool results and images.
- [ ] Define SQLite journal mode, synchronous level, foreign keys, busy timeout,
  checkpointing, and connection ownership.
- [ ] Define schema migration versioning and failure behavior.
- [ ] Define database backup, restore, integrity-check, and export behavior.
- [ ] Define shadow-write ordering and parity failure reporting.
- [ ] Define canonical cutover and rollback switches.
- [ ] Define how JSON overlays are materialized during import.
- [ ] Define how trash/undo history maps into transactional tables.
- [ ] Define how display paging reads directly from canonical rows.
- [ ] Review the design for Windows/Bun SQLite compatibility.

Deliverables:

- [ ] Repository contract document.
- [ ] SQLite schema document.
- [ ] State/file-to-table mapping document.
- [ ] Migration/cutover/rollback document.

---

# Phase 2 — Safe real-conversation fixture from main

## Selector requirements

Build a read-only selector that chooses migration fixtures from main without
copying live automation or subscribed conversations.

- [ ] Read main conversation metadata without mutating or opening files for write.
- [ ] Exclude every conversation with a non-null goal, regardless of status.
- [ ] Exclude external-notification subscription targets.
- [ ] Exclude Chrono schedule owners.
- [ ] Exclude Chrono conversation targets.
- [ ] Exclude conversations referenced by pending Chrono occurrences or hard wakes.
- [ ] Exclude currently streaming conversations.
- [ ] Exclude conversations with queued messages.
- [ ] Exclude conversations participating in running/pending subagent notification
  recovery.
- [ ] Exclude conversations with an active BTW session.
- [ ] Exclude the current migration-planning/testing conversation.
- [ ] Refuse to proceed if any exclusion source cannot be read safely.
- [ ] Produce a selection report containing IDs, sizes, providers, message counts,
  and structural flags but no transcript text.

## Sample composition

Select at least 20 eligible conversations and include diverse structures:

- [ ] At least 20 conversations total.
- [ ] Both supported providers when eligible examples exist.
- [ ] Empty or near-empty conversation.
- [ ] Small ordinary text conversation.
- [ ] Medium conversation.
- [ ] At least one multi-megabyte conversation.
- [ ] Tool-use/tool-result history.
- [ ] Failed tool results.
- [ ] Image metadata/content when an eligible sample exists.
- [ ] System instructions.
- [ ] Folder membership and inherited folder instructions.
- [ ] Marked and pinned metadata.
- [ ] Non-default model, effort, and fast-mode metadata.
- [ ] Valid active context/checkpoint without an active goal.
- [ ] Compaction boundary/history.
- [ ] Context-token attribution.
- [ ] Unread state when eligible.
- [ ] Legacy migrated message/storage versions when available.
- [ ] A conversation with enough history for multiple display pages.

## Copy safety and fidelity

- [ ] Copy into only the worktree instance's gitignored config data.
- [ ] Use stable reads: verify source size/mtime/generation before and after copy.
- [ ] Retry or skip a file that changes during the snapshot.
- [ ] Copy the canonical JSON and required overlays needed to test production
  importer behavior.
- [ ] Copy only relevant folder/folder-instruction metadata.
- [ ] Do not copy credentials, runtime sockets/PIDs, token stats, diagnostics,
  external subscriptions, Chrono state, or unrelated queues.
- [ ] Do not copy display-page projections; require SQLite paging to derive from
  canonical data.
- [ ] Write source and copied SHA-256 hashes to a gitignored fixture manifest.
- [ ] Verify every copied byte/hash before migration.
- [ ] Verify the main source remains unchanged after fixture creation.
- [ ] Add a cleanup command that removes only the generated worktree fixture.

## Migration verification for the real sample

For each selected conversation:

- [ ] Verify scalar metadata.
- [ ] Verify folder, pin, mark, order, and unread state.
- [ ] Verify provider/model/effort/fast mode.
- [ ] Verify goal is absent by selection rule.
- [ ] Verify message count and exact order.
- [ ] Verify role, content, metadata, provider data, and context attribution for
  every message.
- [ ] Verify active context/checkpoint fields and ordered replay messages.
- [ ] Verify complete canonical transcript hash.
- [ ] Verify recent display page parity.
- [ ] Verify older display page parity.
- [ ] Verify deferred tool-output parity.
- [ ] Verify system/folder instruction composition parity.
- [ ] Export from SQLite and compare the normalized JSON representation.

- [ ] Produce a per-conversation migration report for all 20+ conversations.
- [ ] Require zero unexplained mismatches before canonical read cutover.

---

# Phase 3 — Reproducible performance harness

## Dataset generators

- [ ] Add a deterministic low-scale dataset using the 20+ real copied fixtures.
- [ ] Add a deterministic synthetic low-scale dataset for CI.
- [ ] Add a 10,000-conversation synthetic dataset.
- [ ] Add a larger 25,000- or 50,000-conversation dataset if runtime/disk permits.
- [ ] Match measured main-corpus distributions for message counts and file sizes.
- [ ] Include 1 MB, 10 MB, 50 MB, and approximately 100 MB conversations.
- [ ] Include text-heavy, tool-heavy, image-heavy, compacted, and folder-heavy
  conversations.
- [ ] Keep generated content synthetic and deterministic.

## Operations to benchmark

For JSON baseline and SQLite, measure cold and warm runs where meaningful:

- [ ] Daemon/store startup.
- [ ] Schema migration and no-op migration startup.
- [ ] List all conversation summaries.
- [ ] Build complete sidebar state.
- [ ] Find one conversation by ID.
- [ ] Search titles.
- [ ] Open the newest five turns.
- [ ] Load ten older turns.
- [ ] Load one deferred tool output.
- [ ] Load provider replay/active context.
- [ ] Append one user/assistant turn.
- [ ] Append one assistant tool-use plus tool-result round.
- [ ] Update context-token attribution.
- [ ] Rename, mark, pin, and change model settings.
- [ ] Move a conversation one position.
- [ ] Move a batch between folders.
- [ ] Delete one conversation.
- [ ] Delete a batch.
- [ ] Undo and redo deletion.
- [ ] Rewind a long conversation.
- [ ] Checkpoint/WAL maintenance and graceful shutdown.

## Metrics and methodology

- [ ] Record wall-clock duration, CPU time, RSS, heap usage, bytes read/written, and
  resulting storage size where available.
- [ ] Run enough repetitions to report median, p95, and max.
- [ ] Separate setup/import time from steady-state operations.
- [ ] Drop/avoid caches deliberately for cold runs and document the method.
- [ ] Avoid comparing a cold backend to a warm backend.
- [ ] Run baselines from the pre-overhaul commit using the same harness.
- [ ] Store scripts and non-sensitive aggregate results under
  `autoresearch/exocortex-performance/`.
- [ ] Do not commit real conversation content or titles in result files.

## Performance gates

Finalize numeric thresholds during approval, then enforce them:

- [ ] Low-scale summary/list/open operations are no more than the agreed regression
  allowance versus JSON.
- [ ] Low-scale writes remain comparably fast and within an interactive latency
  budget.
- [ ] Large-conversation append time is effectively independent of historical
  transcript size.
- [ ] Large-scale startup and summary listing are materially faster than JSON.
- [ ] Large-scale recent-page reads are materially faster or at least no slower
  than valid display-page cache hits.
- [ ] Sidebar metadata mutations no longer rewrite multi-megabyte conversation or
  index files.
- [ ] SQLite RSS remains bounded while iterating 10,000+ conversations.
- [ ] Database and WAL size remain explainable and checkpoint correctly.
- [ ] Publish a before/after report with raw aggregate JSON and conclusions.

---

# Phase 4 — Repository foundation

- [ ] Add `ConversationRepository` interfaces for metadata, messages, replay,
  mutations, transactions, import/export, and health/integrity operations.
- [ ] Add a JSON repository adapter preserving current behavior.
- [ ] Add backend-independent domain types.
- [ ] Remove filesystem/index implementation details from repository callers.
- [ ] Add generation checks to mutation contracts.
- [ ] Add explicit transaction result/error types.
- [ ] Add repository lifecycle methods for startup and graceful shutdown.
- [ ] Add test factories that run the same contract tests against JSON and SQLite.
- [ ] Keep current IPC payloads and UI behavior unchanged.
- [ ] Commit the repository foundation only after JSON parity tests pass.

---

# Phase 5 — SQLite schema and infrastructure

## Database lifecycle

- [ ] Add an instance-aware database path helper.
- [ ] Create parent directories with safe permissions.
- [ ] Open exactly one daemon-owned writer connection per instance.
- [ ] Enable and verify foreign keys.
- [ ] Configure WAL, synchronous level, busy timeout, and checkpoints.
- [ ] Add `schema_migrations` and transactional migrations.
- [ ] Refuse unsupported future schema versions.
- [ ] Add clean close/checkpoint behavior.
- [ ] Add integrity-check and repair/report commands.
- [ ] Add online backup and restore-to-new-file behavior.
- [ ] Verify abrupt process exit and WAL recovery.

## Core schema

- [ ] `conversations` table for scalar metadata and generation.
- [ ] `messages` table with stable conversation-local ordering.
- [ ] `active_contexts` and any normalized active-context message/checkpoint rows.
- [ ] `folders` table with parent, pin, and order state.
- [ ] `folder_instructions` table.
- [ ] `unread_conversations` table.
- [ ] `queued_messages` and durable delivery receipt identity.
- [ ] `trash_entries`/undo/redo tables.
- [ ] `unwind_receipts` table.
- [ ] `subagent_notifications` table or an explicitly documented retained store.
- [ ] `btw_sessions` table or an explicitly documented retained store.
- [ ] Goal fields/state in conversation rows or a normalized goal table.
- [ ] Chrono and external-notification references represented safely even if their
  full state remains in a later migration phase.

## Large content

- [ ] Measure inline JSON versus separate blob rows for tool results.
- [ ] Measure inline image base64 versus separate blob rows/files.
- [ ] Ensure ordinary page queries do not read large content columns.
- [ ] Add content hashes and deduplication only if measurements justify complexity.
- [ ] Add orphan-blob cleanup and integrity checks if blobs are separated.

## Indexes and queries

- [ ] Sidebar/folder/order indexes.
- [ ] Conversation update/create-time indexes.
- [ ] Message page indexes.
- [ ] Queue order/target indexes.
- [ ] Goal/recovery indexes.
- [ ] Undo/redo order indexes.
- [ ] Optional title/content FTS with explicit exclusions.
- [ ] Explain/query-plan tests for scale-critical queries.

---

# Phase 6 — Import, shadow writes, and parity

## Importer

- [ ] Detect absent, partial, complete, and outdated imports.
- [ ] Import one conversation transactionally.
- [ ] Import folders/instructions before dependent conversations.
- [ ] Materialize sidebar and unwind overlays exactly once.
- [ ] Preserve message order and all optional fields.
- [ ] Preserve active contexts and checkpoints.
- [ ] Preserve unread state and queue receipts.
- [ ] Preserve undo/redo state where safely representable.
- [ ] Store source generation/hash for resumability and verification.
- [ ] Resume after interruption without duplication.
- [ ] Re-import changed JSON safely during shadow mode.
- [ ] Produce progress, skipped-file, corrupt-file, and mismatch reports.

## Shadow writes

- [ ] Keep JSON as the acknowledged canonical write during shadow mode.
- [ ] Apply the equivalent SQLite mutation after the JSON commit.
- [ ] Never acknowledge a SQLite-only mutation while JSON remains canonical.
- [ ] Persist and retry/report failed shadow operations.
- [ ] Do not silently hide divergence.
- [ ] Add deterministic fault injection before/after each side of a dual write.

## Parity verifier

- [ ] Compare complete conversation metadata.
- [ ] Compare ordered messages and hashes.
- [ ] Compare active context and replay hashes.
- [ ] Compare folders, order, and instructions.
- [ ] Compare unread and queue state.
- [ ] Compare goal and subagent policy state.
- [ ] Compare recent/older display pages and tool-output reads.
- [ ] Run incremental verification after every shadow mutation in tests.
- [ ] Run background/full verification for the copied 20+ real conversations.
- [ ] Require zero unexplained parity errors before Phase 7.

---

# Phase 7 — Sequential feature implementation and verification

For every feature below, complete these steps in order:

1. [ ] Add/identify JSON behavior tests and expected durable state.
2. [ ] Add the same repository contract test for SQLite.
3. [ ] Implement the SQLite read/write transaction.
4. [ ] Add restart/reopen verification.
5. [ ] Add fault-injection/crash-boundary coverage where the feature acknowledges a
   durable mutation.
6. [ ] Run parity against the JSON backend.
7. [ ] Exercise the real daemon handler/CLI path where applicable.
8. [ ] Mark the feature complete only after all seven checks pass.

## 7.1 Conversation creation and basic reads

- [ ] Generate unique conversation IDs.
- [ ] Create an empty conversation.
- [ ] Create with an initial user message atomically.
- [ ] Apply provider/model/effort/fast-mode defaults.
- [ ] Place a new conversation at the correct sidebar position/folder.
- [ ] Check existence without transcript loading.
- [ ] Read indexed metadata by ID.
- [ ] List and sort all summaries.
- [ ] List running/restart-recoverable summaries without persisting ephemeral state.
- [ ] Prewarm/load a conversation.

## 7.2 Message and history reads

- [ ] Read a complete canonical conversation for provider replay/export.
- [ ] Read the newest five user turns.
- [ ] Read older pages by stable cursor.
- [ ] Preserve absolute edit/unwind identities across pages.
- [ ] Omit historical image base64 from compact pages as currently required.
- [ ] Retain recent image payload behavior.
- [ ] Defer tool-result payloads.
- [ ] Load requested tool outputs only.
- [ ] Compose folder and conversation system instructions.
- [ ] Build render/display snapshots with current semantics.
- [ ] Support late-join streaming snapshots without duplicating durable rounds.

## 7.3 Conversation metadata mutations

- [ ] Rename conversation and record undo where currently supported.
- [ ] Generate and persist pending/final titles through existing titlegen behavior.
- [ ] Mark/unmark conversation.
- [ ] Pin/unpin conversation.
- [ ] Change provider/model atomically and normalize effort.
- [ ] Change effort.
- [ ] Change fast mode.
- [ ] Set/replace/clear conversation system instructions.
- [ ] Set subagent policy and max-depth state.
- [ ] Preserve timestamps and generation increments.
- [ ] Ensure no metadata mutation rewrites historical message rows.

## 7.4 Goals

Use synthetic worktree-only goals; do not copy live goals from main.

- [ ] Set goal with permission flags.
- [ ] Pause/resume goal.
- [ ] Complete/clear goal.
- [ ] Increment goal turns.
- [ ] Query active goals directly from indexed rows.
- [ ] Recover active goals after restart marker.
- [ ] Ensure goal continuation and queued-message rules retain current behavior.
- [ ] Verify no goal is accidentally activated by fixture migration.

## 7.5 Message append and assistant turns

- [ ] Append ordinary user message.
- [ ] Append ordinary assistant message.
- [ ] Append assistant tool-use and user tool-result messages atomically per durable
  round.
- [ ] Persist failed/aborted tool results.
- [ ] Persist image messages and content references.
- [ ] Persist provider-specific assistant data.
- [ ] Persist message metadata, timing, tokens, and queue/subagent receipt IDs.
- [ ] Persist completed rounds before the next provider call.
- [ ] Recover completed durable rounds after abort/crash.
- [ ] Ensure one append does not update/rewrite unrelated historical rows.

## 7.6 Context attribution and active context

- [ ] Persist last context-token totals.
- [ ] Persist per-message attribution with exact current semantics.
- [ ] Invalidate attribution after transcript-changing mutations.
- [ ] Persist active context/checkpoint state.
- [ ] Validate active context against canonical message prefixes.
- [ ] Install automatic and manual compaction checkpoints.
- [ ] Recover from invalid/stale checkpoints by replaying full canonical history.
- [ ] Preserve provider-native compaction payloads.
- [ ] Verify context-window identifiers and checkpoint hashes after migration.

## 7.7 Sidebar ordering and folders

- [ ] Bump unpinned conversation to top.
- [ ] Move conversation up/down.
- [ ] Move one conversation into/out of a folder.
- [ ] Move batches while preserving visual order.
- [ ] Preserve pinned sections during moves.
- [ ] Pin multiple sidebar items atomically.
- [ ] Create top-level folder.
- [ ] Create nested folder.
- [ ] Create folder around selected items.
- [ ] Rename folder.
- [ ] Pin/unpin folder.
- [ ] Move folders/sidebar items.
- [ ] Prevent folder ancestry cycles.
- [ ] Store and compose inherited folder instructions.
- [ ] Delete folder recursively.
- [ ] Delete folder by unwrapping children.
- [ ] Ensure sidebar operations update only targeted rows plus necessary ordering
  rows.

## 7.8 Clone behavior

- [ ] Clone complete visible/canonical messages.
- [ ] Clone valid active context with new conversation/window identity.
- [ ] Preserve provider/model/effort/fast mode and folder placement semantics.
- [ ] Apply clone title behavior.
- [ ] Do not copy ephemeral streaming/task state.
- [ ] Record clone undo behavior.
- [ ] Verify source and clone mutate independently.

## 7.9 Delete, trash, undo, and redo

- [ ] Delete one conversation softly.
- [ ] Delete multiple conversations as one undoable operation.
- [ ] Stop active work before deletion.
- [ ] Refuse deletion during an owned history unwind.
- [ ] Remove/update dependent queue and notification state transactionally.
- [ ] Remove unread/sidebar live state.
- [ ] Restore one conversation.
- [ ] Restore a deleted batch.
- [ ] Undo and redo metadata mutations.
- [ ] Undo and redo sidebar moves/pins/folders.
- [ ] Undo and redo clone deletion.
- [ ] Undo and redo recursive folder deletion.
- [ ] Preserve ordered undo/redo stacks across daemon restart.
- [ ] Verify failed delete transactions leave all live state unchanged.

## 7.10 Trim and rewind/unwind

- [ ] Trim oldest history entries.
- [ ] Trim/strip oldest thinking.
- [ ] Trim/strip oldest tool-result payloads.
- [ ] Preserve assistant tool-use/tool-result pairs.
- [ ] Clear stale active context and attribution after trim.
- [ ] Rewind by stable user identity/fingerprint.
- [ ] Reject stale rewind identities.
- [ ] Protect immutable compaction prefixes.
- [ ] Rewind valid active contexts to retained history.
- [ ] Serialize concurrent unwind attempts.
- [ ] Coalesce retries of the same unwind operation.
- [ ] Persist idempotent unwind receipts transactionally.
- [ ] Preserve queued intent through unwind failures.
- [ ] Verify crash at every unwind transaction boundary.

## 7.11 Unread and external inbox behavior

- [ ] Mark unread.
- [ ] Clear unread.
- [ ] Persist unread state across restart.
- [ ] Remove stale unread references.
- [ ] Append external inbox notification without starting a model turn.
- [ ] Preserve provenance/system-notice rendering.
- [ ] Mark externally updated conversations unread.

## 7.12 Durable message queue

- [ ] Queue ordinary conversation message.
- [ ] Queue next-turn and message-end timing.
- [ ] Queue global-idle draft/new-conversation messages.
- [ ] Update queued message.
- [ ] Reorder queued message.
- [ ] Remove queued message by stable ID.
- [ ] Preserve FIFO and wait-target behavior.
- [ ] Suspend/resume delivery without losing state.
- [ ] Atomically append accepted user intent and remove/receipt its queue entry.
- [ ] Deduplicate crash-window queue copies using transcript receipt IDs.
- [ ] Recover queued draft conversations after restart.
- [ ] Roll back in-memory behavior when transaction persistence fails.
- [ ] Publish authoritative queue snapshots after commit.

## 7.13 Subagent notification and activity integration

Use synthetic worktree-only subagent records.

- [ ] Persist pending subagent notification before child execution.
- [ ] Detect whether the child task reached durable history.
- [ ] Recover/replay running child work after restart.
- [ ] Settle successful and failed child outcomes.
- [ ] Deduplicate parent notification delivery.
- [ ] Cancel deliberate aborts without notifying parent.
- [ ] Preserve scoped subagent policy and nesting budget.
- [ ] Keep active task/process catalogs ephemeral while projecting counts onto
  summaries.

## 7.14 BTW persistence integration

- [ ] Start BTW session against a conversation snapshot.
- [ ] Persist accepted/closed session receipts as currently required.
- [ ] Recover accepted-session dedupe after daemon restart.
- [ ] Isolate multiple conversations' BTW sessions.
- [ ] Remove BTW state safely when its conversation is deleted.

## 7.15 Chrono integration

Use synthetic non-executing schedules or harmless commands only; do not copy live
main schedules.

- [ ] Validate conversation existence through SQLite metadata.
- [ ] Create conversation-target wake schedule.
- [ ] Create owner-bound command schedule.
- [ ] Persist/reload schedule and pending occurrence state if migrated in this
  overhaul.
- [ ] Deduplicate delivered wakes using transactional receipt IDs.
- [ ] Cancel dependent schedules when a conversation is deleted.
- [ ] Recover/prune stale owner/target references on startup.
- [ ] Verify no copied main Chrono schedule is installed or executed.

## 7.16 External notification integration

Use synthetic routes only; do not copy live main subscriptions.

- [ ] Validate subscription targets through SQLite metadata.
- [ ] Persist routes/receipts in SQLite if included in the approved schema.
- [ ] Publish inbox, model-wake, and command-soft-wake deliveries.
- [ ] Deduplicate event and queued-message receipts.
- [ ] Remove dependent routes when a conversation is deleted.
- [ ] Recover/prune stale routes on startup.
- [ ] Verify no copied main subscription is activated.

## 7.17 Search and inspection

- [ ] Search conversation title/metadata with indexed queries.
- [ ] Add FTS content search only after explicit scope/size rules are approved.
- [ ] Exclude image base64 and raw tool output by default.
- [ ] Report database/schema/import/parity health.
- [ ] Report conversation row/message/blob sizes.
- [ ] Export one conversation to normalized JSON.
- [ ] Export the complete instance for rollback/backup.

- [ ] Require every Phase 7 subsection to be complete before canonical cutover.

---

# Phase 8 — Canonical SQLite read cutover

- [ ] Add an explicit backend/cutover state machine rather than scattered flags.
- [ ] Require completed import and zero parity errors before enabling SQLite reads.
- [ ] Switch summary/sidebar reads.
- [ ] Switch existence/metadata reads.
- [ ] Switch recent/older history page reads.
- [ ] Switch deferred tool-output reads.
- [ ] Switch provider replay/active-context reads.
- [ ] Retain JSON read fallback.
- [ ] Run the 20+ real-conversation migration verification again.
- [ ] Run all feature tests against SQLite reads plus JSON writes/shadow writes.
- [ ] Run low- and large-scale profiles.
- [ ] Fix every unexplained correctness or performance regression before Phase 9.

---

# Phase 9 — Canonical SQLite write cutover

- [ ] Require all Phase 7 transactional feature tests to pass.
- [ ] Back up JSON and SQLite before first canonical write cutover.
- [ ] Switch conversation/message/metadata writes.
- [ ] Switch folder/sidebar writes.
- [ ] Switch queue receipt transactions.
- [ ] Switch trim/unwind writes.
- [ ] Switch trash/undo/redo writes.
- [ ] Switch goals, subagent notifications, BTW, unread, and approved integration
  state.
- [ ] Stop acknowledging JSON-only writes.
- [ ] Keep optional JSON export/shadow output for rollback observation.
- [ ] Test daemon crash/restart during every critical transaction.
- [ ] Verify WAL recovery and integrity after forced process termination.
- [ ] Run all shared/daemon/TUI tests.
- [ ] Run all repository contracts against canonical SQLite.
- [ ] Run the 20+ real-conversation verification again.
- [ ] Run low- and large-scale profiles again.
- [ ] Document the exact rollback procedure and test it end to end.

---

# Phase 10 — Remove obsolete projection/index/sidecar machinery

Do this only after the approved bake-in period.

- [ ] Remove runtime dependency on `conversations-index.json`.
- [ ] Remove display-page projection reads.
- [ ] Remove display-page writes/backfill workers/build cleanup.
- [ ] Remove `.sidebar` overlays.
- [ ] Remove `.unwind` overlays.
- [ ] Remove mtime/ctime/generation freshness repair used only by those files.
- [ ] Remove queue tombstone compensation replaced by transactions.
- [ ] Remove full-conversation rewrite paths from normal operation.
- [ ] Retain explicit JSON import/export compatibility.
- [ ] Add migration cleanup that archives rather than silently deletes old JSON.
- [ ] Re-run feature parity and performance gates after deleting compatibility code.

---

# Phase 11 — End-to-end validation

## Automated validation

- [ ] Root workspace typecheck passes.
- [ ] Shared tests pass.
- [ ] Full daemon tests pass or only documented pre-existing unrelated failures
  remain.
- [ ] TUI tests pass.
- [ ] Repository contract tests pass for SQLite.
- [ ] Import/resume/idempotency tests pass.
- [ ] Fault-injection and crash-recovery tests pass.
- [ ] History pagination and deferred tool-output tests pass.
- [ ] Handler/CLI integration tests pass.
- [ ] No test reads or writes the live main config unintentionally.

## Real fixture validation

- [ ] At least 20 eligible main conversations copied safely.
- [ ] All copied source hashes verified.
- [ ] All migrated transcript hashes verified.
- [ ] All per-field parity checks pass.
- [ ] Every copied conversation opens at newest history.
- [ ] Every copied conversation can page older history where available.
- [ ] Tool outputs load correctly where available.
- [ ] No excluded goal/subscription/Chrono state appears in the worktree.

## Sequential feature smoke test

Using a worktree-only conversation, exercise and record results for:

- [ ] Create conversation.
- [ ] Send/persist messages without invoking unsafe external effects.
- [ ] Rename conversation.
- [ ] Mark/unmark conversation.
- [ ] Pin/unpin conversation.
- [ ] Move conversation up/down.
- [ ] Create/rename/pin folder.
- [ ] Move conversation into/out of folder.
- [ ] Set/clear system instructions.
- [ ] Set model/effort/fast mode.
- [ ] Set/pause/resume/complete a synthetic goal.
- [ ] Queue/update/move/unqueue a message.
- [ ] Clone conversation.
- [ ] Trim history.
- [ ] Rewind history.
- [ ] Delete conversation.
- [ ] Undo deletion.
- [ ] Redo deletion and restore again.
- [ ] Delete folder recursively and undo.
- [ ] Delete folder by unwrap and undo.
- [ ] Restart daemon and verify all durable state.

## xenv/exotest validation

- [ ] Start the worktree daemon/TUI through `xenv` plus `exotest`.
- [ ] Verify startup migration/progress output is understandable.
- [ ] Open multiple migrated real conversations.
- [ ] Navigate recent and older pages.
- [ ] Expand deferred tool outputs.
- [ ] Exercise sidebar operations and observe correct UI updates.
- [ ] Restart only the worktree test daemon and verify recovery.
- [ ] Never restart the main Exocortex daemon for testing.
- [ ] Stop the test daemon and remove the temporary xenv after validation.

---

# Phase 12 — Final performance report

- [ ] Run low-scale JSON baseline and SQLite final profiles on the same machine.
- [ ] Run 10,000+ scale JSON baseline and SQLite final profiles on the same machine.
- [ ] Compare cold and warm startup.
- [ ] Compare reads, writes, sidebar mutations, delete/undo, and rewind.
- [ ] Compare RSS/heap and bytes written.
- [ ] Compare total storage including JSON projections versus SQLite/WAL/blobs.
- [ ] Confirm every agreed low-scale regression threshold.
- [ ] Confirm every agreed large-scale improvement threshold.
- [ ] Explain any operation that did not improve.
- [ ] Check in benchmark scripts and non-sensitive aggregate results.
- [ ] Add a concise conclusions document with commands needed to reproduce results.

---

# Phase 13 — Documentation, review, and handoff

- [ ] Update `docs/architecture-roadmap.md` with completed storage items only after
  implementation is accepted.
- [ ] Document schema and migration versions.
- [ ] Document data locations and per-instance isolation.
- [ ] Document startup migration, progress, and failure recovery.
- [ ] Document backup/export/restore and rollback.
- [ ] Document integrity-check and parity-report commands.
- [ ] Document removal/archival of obsolete JSON and display projections.
- [ ] Update operator/developer documentation.
- [ ] Ensure this TODO accurately reflects completed and deferred items.
- [ ] Commit all work in reviewable phase checkpoints.
- [ ] Leave the worktree and test fixture available for user inspection.
- [ ] Provide the user with:
  - implementation summary
  - schema/migration summary
  - list of migrated real fixture IDs/counts without transcript content
  - feature test matrix
  - test results
  - benchmark report
  - known limitations and deferred work
  - exact checkout/test instructions
- [ ] Do not merge or clean the worktree until the user explicitly approves it.

## Final completion gate

- [ ] Every required checkbox above is complete or explicitly marked deferred with
  user approval and a reason.
- [ ] At least 20 safe real conversations migrated with zero unexplained parity
  mismatches.
- [ ] Sequential feature matrix passes.
- [ ] Low-scale performance is within agreed comparable thresholds.
- [ ] Large-scale performance is materially improved.
- [ ] SQLite canonical reads and writes survive restart/crash tests.
- [ ] Rollback is proven.
- [ ] User has inspected the worktree and approved merge/cleanup.
