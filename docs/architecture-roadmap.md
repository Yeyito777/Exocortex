# Architecture Migration Roadmap

This is the ordered list of remaining architecture work for Exocortex.

## 1. Add a workspace for every conversation

Give every conversation a persistent, isolated default working directory under
the instance's gitignored data directory.

- [ ] Add `conversationWorkspacesDir()` and `conversationWorkspaceDir(id)` path
  helpers.
- [ ] Store main-instance workspaces at:
  `config/data/workspaces/<conversation-id>/`.
- [ ] Store linked-worktree instance workspaces under that instance's existing
  namespaced `dataDir()`, for example:
  `config/data/instances/<instance>/workspaces/<conversation-id>/`.
- [ ] Keep the entire workspace root covered by the existing `config/data/`
  gitignore rule.
- [ ] Validate conversation IDs before using them as directory names and refuse
  paths that escape the workspace root.
- [ ] Create the directory when a new conversation is created.
- [ ] Lazily create workspaces for existing conversations on first use.
- [ ] Use restrictive directory permissions where the platform supports them.
- [ ] Add a `WorkspaceService` that owns path resolution, creation, inspection,
  trash, restore, and cleanup.

### Tool and agent execution

- [ ] Add `cwd` to the conversation/tool execution context.
- [ ] Resolve the cwd from the active conversation ID at the start of every turn.
- [ ] Pass the explicit cwd through every filesystem and process tool, including:
  - bash and its isolated/background runners
  - read, write, edit, patch, glob, and grep
  - external CLI tools launched through bash
- [ ] Stop filesystem tools from implicitly using the daemon-wide
  `process.cwd()`.
- [ ] Do not call `process.chdir()` per conversation; it is process-global and is
  unsafe when conversations execute concurrently.
- [ ] Make each native subagent use its own child conversation workspace rather
  than inheriting the parent's workspace.
- [ ] Make conversation-owned Chrono commands use their owner's workspace.
- [ ] Define a separate service workspace for ownerless daemon/Chrono operations.
- [ ] Include the effective conversation workspace path in the model's environment
  instructions and relevant status/debug output.
- [ ] Deprecate the daemon-wide `agent.workingDirectory` as the default for
  conversation turns, retaining a clearly defined compatibility role only if
  needed for ownerless operations.

### Workspace lifecycle

- [ ] Stop active tools and background processes before moving or deleting a
  workspace.
- [ ] Move a deleted conversation's workspace to trash rather than deleting it
  immediately.
- [ ] Restore the workspace when conversation deletion is undone.
- [ ] Decide whether cloning a conversation creates an empty workspace, copies the
  workspace, or offers an explicit choice; avoid silently copying very large
  directories.
- [ ] Decide whether conversation export/import includes the workspace and provide
  explicit archive options.
- [ ] Report workspace size in conversation/instance inspection commands.
- [ ] Detect and safely prune orphaned workspace directories.
- [ ] Add tests for creation, lazy migration, relative paths, subagent isolation,
  background processes, trash/restore, unsafe IDs, and concurrent conversations.
- [ ] Treat the workspace as a cwd and lifecycle boundary, not as a security
  sandbox; absolute paths and symlinks require their existing safety policy.
- [ ] Keep workspace file contents out of SQLite. Store only lifecycle metadata if
  the repository needs it; derive the normal path from instance and conversation
  identity.

## 2. Introduce a conversation repository

Create a storage boundary before changing the canonical storage format.

- [ ] Define a `ConversationRepository` interface.
- [ ] Separate cheap metadata operations from transcript operations:
  - `hasConversation(id)`
  - `getConversationMetadata(id)`
  - `listConversationMetadata(query, order, page)`
  - `getMessagePage(id, cursor, limit)`
  - `getProviderReplay(id, checkpoint)`
  - `appendMessages(id, expectedGeneration, messages)`
  - `updateConversationMetadata(id, patch)`
  - `replaceActiveContext(id, expectedGeneration, context)`
  - `rewindConversation(id, expectedGeneration, boundary)`
  - delete, restore, and transaction operations
- [ ] Implement the repository against the existing JSON/index/sidecar storage.
- [ ] Move persistence knowledge out of handlers and orchestration code.
- [ ] Add behavior-focused repository contract tests.
- [ ] Return immutable snapshots and use generation-checked mutations instead of
  exposing long-lived mutable conversation objects.

## 3. Add normalized SQLite storage

Use one SQLite database per Exocortex instance/worktree.

- [ ] Add versioned SQLite schema migrations.
- [ ] Create normalized tables for:
  - conversations and sidebar metadata
  - ordered messages
  - active contexts and checkpoints
  - folders and folder instructions
  - unread state
  - queued messages and delivery receipts
  - undo records
  - unwind receipts
- [ ] Decide how to store large tool results and images:
  - ordinary SQLite rows
  - compressed blobs
  - content-addressed files
- [ ] Ensure recent message pages and sidebar reads never deserialize historical
  image base64 or large tool results.
- [ ] Add indexes for conversation ordering, folders, message paging, and
  generation checks.
- [ ] Add optional FTS5 title/content search without indexing image base64 or raw
  tool-result payloads by default.
- [ ] Choose and document SQLite journal and synchronous settings appropriate for
  acknowledged-message durability.
- [ ] Add consistent backup, restore, and export operations.

## 4. Build a safe JSON-to-SQLite migration

Keep JSON canonical until SQLite parity has been demonstrated in real use.

### Import and shadow mode

- [ ] Build a resumable, idempotent JSON importer.
- [ ] Import existing conversations without changing canonical reads or writes.
- [ ] Shadow-write supported mutations to SQLite after their JSON operation.
- [ ] Record parity failures without blocking the canonical JSON operation.
- [ ] Compare both stores using:
  - conversation metadata
  - ordered message counts
  - ordered transcript hashes
  - active-context/checkpoint state
  - storage generations
- [ ] Add commands or reports for migration progress and parity failures.

### Switch reads

- [ ] Move conversation metadata and sidebar reads to SQLite.
- [ ] Move folder, unread, goal, and ordering reads to SQLite.
- [ ] Move recent and older message-page reads to SQLite.
- [ ] Move deferred tool-output reads to SQLite.
- [ ] Keep runtime switches that can restore JSON reads during the bake-in period.

### Switch writes

- [ ] Append user, assistant, and tool messages transactionally in SQLite.
- [ ] Move active-context and checkpoint writes.
- [ ] Move metadata and sidebar mutations.
- [ ] Move rewind operations.
- [ ] Atomically accept a queued message and record its transcript receipt.
- [ ] Move delete, restore, folder, and undo operations into transactions.
- [ ] Make SQLite canonical only after sustained parity and recovery testing.
- [ ] Keep JSON rollback/export data for at least one release after cutover.

### Remove compatibility storage

After the rollback period:

- [ ] Remove `conversations-index.json`.
- [ ] Remove `display-pages/` and its backfill workers.
- [ ] Remove `.sidebar` overlays.
- [ ] Remove `.unwind` overlays.
- [ ] Remove generation/mtime repair logic that exists only for cross-file state.
- [ ] Remove queue tombstone compensation replaced by database transactions.
- [ ] Remove repeated whole-conversation JSON serialization paths.

### Storage migration completion criteria

- [ ] A crash at any mutation boundary cannot lose an acknowledged user message.
- [ ] Restart recovery is idempotent.
- [ ] Import can be interrupted and resumed safely.
- [ ] Every ordered transcript hash matches during shadow mode.
- [ ] Recent-page and full-export views agree.
- [ ] Appending to a large conversation takes time proportional to new content,
  not historical conversation size.
- [ ] Walking the complete sidebar or corpus keeps memory bounded.
- [ ] Backup, restore, export, schema migration, and rollback are tested.

## 5. Make model-round history bookkeeping incremental

Stop rescanning and rehashing complete provider history on every tool/model round.

- [ ] Assign or cache immutable content signatures for stored messages.
- [ ] Cache token/category breakdowns by content signature.
- [ ] Recompute attribution only for new or edited messages.
- [ ] Avoid repeatedly hashing historical image base64 and tool output.
- [ ] Store provider calibration at a turn or checkpoint level where possible.
- [ ] Update only attribution records whose values changed.
- [ ] Instrument full-history walks so regressions are visible.
- [ ] Benchmark tool-heavy, image-heavy, compacted, and very large conversations.

## 6. Replace full-sidebar IPC with revisioned deltas

Send complete sidebar state only for initial synchronization and recovery.

- [ ] Add a monotonic sidebar revision.
- [ ] Define a `sidebar_snapshot` event containing the revision and complete state.
- [ ] Define a `sidebar_delta` event containing:
  - base revision
  - new revision
  - conversation upserts and deletions
  - folder upserts and deletions
  - order changes
- [ ] Apply deltas only when the client has the expected base revision.
- [ ] Request a fresh snapshot after a revision gap.
- [ ] Add capability negotiation so old clients continue receiving supported
  protocol events during rollout.
- [ ] Coalesce replaceable pending deltas per client.
- [ ] Serialize identical broadcasts once and reuse the encoded bytes.
- [ ] Respect socket write backpressure.
- [ ] Bound each client's pending output and resynchronize or disconnect clients
  that cannot keep up.
- [ ] Add initial-sidebar paging if archive growth makes snapshots too large.

## 7. Split daemon responsibilities into services

Extract boundaries around ownership and transaction behavior rather than merely
moving code to reduce file sizes.

- [ ] Create `ConversationService` for conversation invariants and mutations.
- [ ] Create `WorkspaceService` for conversation cwd and workspace lifecycle.
- [ ] Create `SidebarService` for folders, ordering, pinning, and revisions.
- [ ] Create `QueueService` for durable intent, dispatch, and receipts.
- [ ] Create `SchedulerService` for Chrono lifecycle.
- [ ] Create `NotificationRegistry` for external and subagent notification state.
- [ ] Create `ConversationEventPublisher` for post-commit event publication.
- [ ] Make command-family handlers validate input and call services.
- [ ] Keep UI payload construction outside the repository.
- [ ] Publish events only after the durable mutation commits.
- [ ] Stop orchestration code from reaching through multiple persistence layers.
- [ ] Reduce the responsibilities currently concentrated in:
  - `handler.ts`
  - `conversations.ts`
  - `persistence.ts`
  - `exocortex-tool-runtime.ts`
  - `orchestrator.ts`

## 8. Add versioned runtime schemas for IPC

Use runtime validation rather than relying only on TypeScript protocol types.

- [ ] Parse every inbound command before dispatch.
- [ ] Define explicit protocol versions and client capabilities.
- [ ] Centralize defaults, enums, ID constraints, and mutually exclusive options.
- [ ] Share or derive TypeScript types from the runtime schemas.
- [ ] Validate daemon events in development and tests.
- [ ] Roll out sidebar deltas through capability negotiation.
- [ ] Move scattered handler validation into schemas and service-level invariants.

## 9. Add worktree-instance lifecycle management

Track and safely remove state left by deleted or abandoned worktrees.

- [ ] Persist instance metadata:
  - instance/worktree name and path
  - Git common directory
  - creation time
  - last daemon start
  - last data mutation
  - schema/storage version
  - approximate storage usage
  - active PID/socket identity
- [ ] Add `exo instances list`.
- [ ] Add `exo instances inspect <name>`.
- [ ] Add `exo instances prune`.
- [ ] Refuse to prune an instance with a live daemon or socket.
- [ ] Detect whether the corresponding Git worktree still exists.
- [ ] Show the paths and storage size that will be removed.
- [ ] Include conversation workspace storage in inspection and pruning.
- [ ] Require explicit confirmation unless a separate retention policy is adopted.
- [ ] Clean runtime, diagnostics, and data consistently.

## 10. Finish diagnostics storage improvements

- [ ] Buffer diagnostic writes asynchronously.
- [ ] Write one tool-call batch instead of one append per result.
- [ ] Compress closed daily diagnostic files.
- [ ] Separate temporary performance profiling from always-on operational metrics.
- [ ] Make retention and daily caps configurable if needed.
- [ ] Prefer request-level aggregates and bounded samples over verbose event copies.
- [ ] Do not migrate the historical verbose JSONL shape into SQLite unchanged.

## 11. Move small JSON state only when transactions require it

Do not migrate small files solely to replace JSON. Move them when they need atomic
updates with conversation state.

- [ ] Evaluate moving Chrono schedules into the per-instance database.
- [ ] Evaluate moving external notification routes.
- [ ] Evaluate moving folders and folder instructions.
- [ ] Evaluate moving unread state.
- [ ] Evaluate moving the message queue and delivery receipts.
- [ ] Keep human-edited user configuration in an appropriate editable format.
- [ ] Keep provider credentials and other secrets outside the conversation
  database.

## Decisions to make during implementation

- [ ] Define clone behavior for conversation workspaces.
- [ ] Define workspace inclusion in export, import, backup, and restore.
- [ ] Decide whether workspace size warnings or quotas are needed.
- [ ] Define the compatibility/deprecation path for `agent.workingDirectory`.
- [ ] Select the large-content storage strategy for tool results and images.
- [ ] Select SQLite journal, synchronous, and backup settings.
- [ ] Set the JSON rollback retention period after SQLite cutover.
- [ ] Decide whether conversation data will ever be shared across worktree
  instances.
- [ ] Set sidebar snapshot paging thresholds.
- [ ] Define FTS scope and privacy/size rules for tool output.
- [ ] Decide whether token attribution belongs per message, turn, checkpoint, or a
  hybrid of those levels.
- [ ] Classify diagnostics as temporary profiling or long-lived operational data.
