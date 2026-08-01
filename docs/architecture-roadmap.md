# Architecture Migration Roadmap

This document records the architecture work identified during the July/August
2026 audit of Exocortex's live storage, daemon, and IPC behavior. It is a roadmap,
not a commitment to perform every item exactly as written. Re-measure before each
large phase and update the design when the evidence changes.

## Why this work exists

The main scaling problems are caused by data layout and repeated work, not by Bun
or TypeScript execution speed:

- Thousands of conversations are stored as whole JSON documents.
- Appending a message or completing a tool round can rewrite a multi-megabyte
  conversation from beginning to end.
- Canonical JSON cannot be paged, so a separate display-page projection and
  freshness protocol are needed.
- Some model-round bookkeeping repeatedly scans and hashes the complete provider
  history.
- Sidebar mutations send the complete sidebar state over IPC.
- State that should be updated atomically is split across canonical files,
  sidecars, queues, indexes, and crash-recovery receipts.

At the time of the audit, the main conversation corpus was approximately:

- 3,300 conversations
- 2.33 GB of canonical JSON
- 242 KB median conversation size
- 1.74 MB p95 conversation size
- 96 MB largest conversation
- 337 MB and roughly 10,000 files of display-page projections

These numbers are a historical snapshot. They are useful for understanding the
motivation but must not be treated as permanent benchmarks.

## First optimization pass: completed

Commit `843e5b3` landed the immediate containment work:

- Active-goal restart recovery filters summary metadata before loading complete
  transcripts.
- Existence and indexed-metadata reads no longer require transcript loading.
- Clean full transcripts and render snapshots use a bounded LRU cache.
- Dirty, streaming, unwinding, and active-task conversations are not evicted.
- Model/tool diagnostics are gated by performance profiling.
- Model-request diagnostics no longer repeat every historical tool result.
- Diagnostic records and retention are bounded.

This reduces the immediate startup/memory failure mode. It does not eliminate
full-file rewrites, the projection stack, repeated full-history computation, or
full-sidebar IPC.

## Architectural principles

1. **Migrate conversation storage as one system.** Migrating only
   `conversations-index.json` leaves the expensive transcript writes and most
   consistency machinery intact.
2. **Preserve rollback throughout the migration.** JSON remains canonical until
   SQLite parity has been observed in real use.
3. **Use one database per Exocortex instance/worktree.** Do not introduce
   multi-daemon writer coordination unless shared conversations become an
   explicit product requirement.
4. **Keep secrets separate.** Provider credentials and other secrets do not
   belong in the conversation database.
5. **Retain paging from the beginning.** No new canonical API should require
   loading a complete transcript to show recent history.
6. **Make mutations explicit and transactional.** Avoid exposing long-lived
   mutable conversation objects as the future repository API.
7. **Do not rewrite the daemon in another language to solve storage design
   problems.** A Rust or Go port would preserve the same I/O and algorithmic
   multipliers unless the data model changed first.

---

# Workstream 1: Conversation repository and SQLite storage

## Goal

Replace whole-document JSON persistence with a normalized, page-addressable,
transactional store behind a narrow repository interface.

## Repository boundary

Introduce a `ConversationRepository` before changing the canonical format. The
repository should distinguish cheap metadata reads from transcript operations:

```text
hasConversation(id)
getConversationMetadata(id)
listConversationMetadata(query/order/page)
getMessagePage(id, cursor, limit)
getProviderReplay(id, checkpoint/cursor)
appendMessages(id, expectedGeneration, messages)
updateConversationMetadata(id, patch)
replaceActiveContext(id, expectedGeneration, context)
rewindConversation(id, expectedGeneration, boundary)
delete/restoreConversation(...)
transaction(...)
```

Callers should not need to know whether the implementation is JSON, SQLite, or a
temporary parity wrapper around both.

Avoid designing the new API around `get(id): MutableConversation`. Long-lived
mutable references make cache eviction and concurrent mutation difficult to
reason about. Prefer immutable snapshots plus generation-checked operations.

## Candidate SQLite schema

The final schema may differ, but it should have equivalent normalized concepts:

```text
conversations
  id PRIMARY KEY
  provider, model, effort, fast_mode
  title, marked, pinned, sort_order, folder_id
  created_at, updated_at
  last_context_tokens
  goal_json
  subagent_policy_json
  generation

messages
  conversation_id
  sequence
  role
  content_json or content reference
  metadata_json
  provider_data_json
  context_tokens_json
  PRIMARY KEY (conversation_id, sequence)

active_contexts
  conversation_id PRIMARY KEY
  checkpoint fields
  replay payload or payload reference

folders
folder_instructions
unread_conversations
queued_messages
undo_log
unwind_receipts
```

Large content may deserve separate tables or content-addressed blobs:

```text
tool_results
images
content_blobs
```

That decision should be based on measured read/write behavior. At minimum, recent
conversation pages and sidebar metadata must not deserialize historical base64 or
large tool outputs.

## Required capabilities

- Append new messages without rewriting historical messages.
- Fetch the newest N turns and older pages directly.
- Load tool output only when requested by the client/model path that needs it.
- Update title, goal, pin, order, folder, unread state, and similar metadata with
  targeted row updates.
- Atomically accept a queued message and record its transcript receipt.
- Atomically perform rewind, delete/restore, folder, and undo operations.
- Use generation checks to reject stale writes.
- Support consistent backups and explicit schema migrations.
- Allow future FTS5 title/content search while excluding image base64 and, by
  default, raw tool-result payloads.

## Migration sequence

### Phase 1: Repository extraction

- Define repository contracts and behavior-focused tests.
- Implement those contracts using the existing JSON/index/sidecar code.
- Move storage knowledge out of handlers and orchestration code incrementally.
- Preserve current wire behavior.

### Phase 2: SQLite shadow import and writes

- Add versioned SQLite schema migrations.
- Import existing JSON without changing JSON canonicality.
- Shadow-write every supported mutation to SQLite.
- Record parity failures without blocking the canonical JSON operation.
- Compare metadata, message counts, ordered transcript hashes, active context,
  and generations.
- Make the importer resumable and idempotent.

### Phase 3: Move metadata/sidebar reads

- Read conversation summaries, folders, unread state, goals, and ordering from
  SQLite.
- Keep JSON writes and a rollback switch.
- Measure startup, sidebar load, and reorder behavior on a copy of the real
  corpus.

### Phase 4: Move paged message reads

- Serve recent and older history directly from `messages`.
- Serve deferred tool output through targeted reads.
- Keep the display-page store available as a fallback until parity is proven.

### Phase 5: Move canonical writes and complex mutations

- Append user/assistant/tool messages transactionally.
- Move active-context/checkpoint writes.
- Move rewind, queue receipt, delete/restore, folder, and undo operations.
- Make SQLite canonical only after sustained parity and recovery testing.
- Retain old JSON as rollback/export data for at least one release.

### Phase 6: Remove compatibility machinery

After a bake-in period, remove or substantially reduce:

- `conversations-index.json`
- `display-pages/`
- Display-index backfill workers
- `.sidebar` overlays
- `.unwind` overlays
- Generation/mtime freshness repair logic that exists only for cross-file state
- Queue tombstone compensation superseded by database transactions
- Repeated whole-file JSON serialization paths

Do not combine the first SQLite release with deletion of the rollback path.

## Storage migration acceptance criteria

- Crash at any mutation boundary without losing an acknowledged user message.
- Restart recovery is idempotent.
- Import can be interrupted and resumed.
- Every conversation's ordered transcript hash matches the JSON source during
  shadow mode.
- Recent-page and full-export views agree.
- Large conversations append in time proportional to new content, not historical
  size.
- Memory remains bounded when walking the complete sidebar or corpus.
- Backup, restore, export, and schema rollback procedures are documented and
  tested.

---

# Workstream 2: Incremental per-round history bookkeeping

## Problem

Context-token attribution and related provider bookkeeping can walk, categorize,
hash, and serialize the entire provider input history on each model/tool round.
For a conversation with `r` model rounds and `n` historical bytes, this trends
toward repeated `O(r × n)` work.

## Plan

- Assign or cache immutable content signatures per message.
- Cache category/token breakdowns by signature.
- Recompute only new or edited messages.
- Avoid hashing old image base64 and tool output repeatedly.
- Store provider calibration at a turn/checkpoint level where possible instead of
  rewriting attribution on every historical message.
- In SQLite, update only attribution rows whose values changed.
- Instrument full-history walks so regressions are visible.

Profile this after the immediate restart fix; the old full-corpus loading bug
distorted memory and event-loop measurements.

---

# Workstream 3: Revisioned sidebar IPC and backpressure

## Problem

Sidebar reorder/folder/pin operations currently send complete conversation and
folder arrays. During the audit, a compact full-sidebar event was approximately
1.3–1.4 MB. The daemon may serialize it per client, and replaceable updates can
accumulate without explicit coalescing/backpressure policy.

## Target protocol

```text
sidebar_snapshot {
  revision,
  conversations,
  folders
}

sidebar_delta {
  baseRevision,
  revision,
  conversationUpserts,
  conversationDeletes,
  folderUpserts,
  folderDeletes,
  orderChanges
}
```

## Plan

- Give sidebar state a monotonic revision.
- Apply a delta only when the client's revision matches `baseRevision`.
- Request/send a fresh snapshot after a revision gap.
- Coalesce replaceable pending deltas per client.
- Serialize identical broadcasts once and reuse the bytes.
- Respect socket write backpressure and bound each client's pending output.
- Disconnect or resynchronize clients that cannot keep up.
- Consider paging the initial sidebar if the archive grows substantially.
- Preserve full snapshots as a recovery mechanism, not the normal mutation path.

In-memory title search over a few thousand summaries is not the current priority;
shipping all summaries repeatedly is the larger problem.

---

# Workstream 4: Service boundaries and smaller command handlers

Several modules currently combine unrelated responsibilities. Split them around
behavior and ownership while introducing the repository, rather than moving code
solely to reduce line counts.

Candidate boundaries:

```text
ConversationRepository    durable primitives and transactions
ConversationService       domain mutations and invariants
SidebarService            folders, pinning, ordering, revisions
QueueService              durable intent, dispatch, and receipts
SchedulerService          Chrono lifecycle
NotificationRegistry      external/subagent notification state
ConversationEventPublisher
```

Desired result:

- Command-family handlers validate input and call services.
- Services own invariants and transaction boundaries.
- The repository owns persistence but not UI payload construction.
- Event publication occurs after durable commit.
- Orchestration does not reach through several persistence layers directly.

Likely extraction targets include `handler.ts`, `conversations.ts`,
`persistence.ts`, `exocortex-tool-runtime.ts`, and `orchestrator.ts`.

---

# Workstream 5: Versioned runtime schemas at the IPC boundary

The shared TypeScript protocol does not by itself validate untrusted runtime JSON.
Validation is currently distributed across large handler branches.

Use the existing Zod dependency, or an equivalent runtime-schema system, to:

- Parse every inbound command before dispatch.
- Define explicit protocol versions and capabilities.
- Centralize defaults, enums, ID constraints, and mutually exclusive options.
- Share or derive TypeScript types from runtime schemas.
- Validate daemon events in development/tests.
- Introduce sidebar deltas through capability negotiation rather than implicit
  client assumptions.

---

# Workstream 6: Worktree-instance lifecycle and garbage collection

## Problem

Worktree isolation prevents daemons from corrupting one another's state, but
deleted worktrees can leave complete instance data behind. At audit time,
`config/data/instances` contained roughly 898 MB in apparently orphaned instance
directories.

## Plan

Persist instance metadata such as:

- Instance/worktree name and path
- Git common directory
- Creation time
- Last daemon start and last data mutation
- Schema/storage version
- Approximate storage usage
- Active PID/socket identity

Add lifecycle commands resembling:

```text
exo instances list
exo instances inspect <name>
exo instances prune
```

Pruning must:

- Refuse to delete an instance with a live daemon/socket.
- Detect whether the corresponding Git worktree still exists.
- Show what will be deleted and how much space it uses.
- Require explicit confirmation unless a separately designed retention policy
  applies.
- Clean runtime, diagnostics, and data consistently.

SQLite does not remove the need for this; otherwise orphaned directories merely
become orphaned database files.

---

# Workstream 7: Finish diagnostics architecture

The first pass added gating, delta-only tool-result records, retention, and daily
caps. Remaining optional work:

- Buffer writes asynchronously.
- Write one tool-call batch rather than one append per result.
- Compress closed daily files.
- Separate temporary performance profiling from genuinely always-on operational
  metrics.
- Make retention and caps configurable if product needs differ.
- Prefer request-level aggregates and bounded samples over verbose event copies.
- Do not import the historical multi-gigabyte JSONL shape into SQLite unchanged.

---

# Workstream 8: Move small JSON state only when transactions justify it

The following files were small and are not performance migration priorities:

- Chrono schedules
- External notification routes
- Folders and folder instructions
- Unread state
- Message queue
- General user config
- Token statistics

Chrono, notifications, folders, unread state, and the queue may eventually belong
in the per-instance database because transactions with conversations become
simpler. Move them when that correctness benefit is needed, not merely to replace
small JSON files.

Keep user configuration human-editable where practical. Keep secrets and provider
credentials separate from general application state.

---

# Recommended execution order

1. [x] Land immediate startup, cache, existence-read, and diagnostics containment.
2. [ ] Define `ConversationRepository` contracts and JSON-backed implementation.
3. [ ] Add SQLite schema, resumable importer, shadow writes, and parity reporting.
4. [ ] Move metadata/sidebar reads to SQLite.
5. [ ] Move paged message and deferred tool-output reads.
6. [ ] Make message and active-context writes canonical in SQLite.
7. [ ] Move rewind, queue receipts, delete/restore, folder, and undo transactions.
8. [ ] Add revisioned sidebar deltas, serialization reuse, and backpressure.
9. [ ] Incrementalize token-attribution/full-history bookkeeping.
10. [ ] Bake in, verify rollback/export, then remove projection/index/sidecar
    compatibility code.
11. [ ] Complete service extraction and runtime IPC schemas.
12. [ ] Add instance inspection and safe pruning.
13. [ ] Finish optional diagnostics buffering/compression/configuration.

## Open decisions to resolve with measurements

- Whether tool results/images should be normal SQLite rows, compressed blobs, or
  content-addressed files.
- SQLite journal/synchronous settings appropriate for acknowledged-message
  durability.
- How long JSON rollback exports remain after SQLite becomes canonical.
- Whether any conversation data should ever be shared across worktree instances.
- Sidebar snapshot paging thresholds.
- FTS scope and privacy/size rules for tool output.
- Whether attribution belongs per message, per turn, per checkpoint, or in a
  hybrid model.
- Which diagnostics are temporary profiling versus long-lived operational data.

## Non-goals

- An index-only migration presented as a complete storage fix.
- A language rewrite before fixing the data model.
- Deleting JSON/projection compatibility during the first SQLite release.
- Putting credentials in the conversation database.
- Making all `config/` JSON into database tables without a transactional or
  performance reason.
