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

## 2. Retire JSON compatibility storage after the SQLite bake-in

Keep the current JSON importer/exporter and pre-cutover corpus through the accepted
release. Retirement is a separate, explicit operation rather than part of cutover.

- [ ] Agree on the first release after which the legacy corpus may be archived.
- [ ] Create and verify a current SQLite backup and normalized JSON export before
  changing compatibility files.
- [ ] Add an archive command with a dry run, exact paths, sizes, and explicit
  confirmation; never silently delete rollback data.
- [ ] Remove runtime reads/writes of `conversations-index.json`, `display-pages/`,
  `.sidebar`, `.unwind`, and legacy trash metadata after the bake-in.
- [ ] Remove display-page backfill and filesystem generation/mtime repair paths that
  exist only for JSON operation.
- [ ] Remove queue tombstone compensation and repeated whole-conversation JSON
  serialization from the normal runtime.
- [ ] Keep a standalone importer for old v1-v18 corpora even after the JSON runtime
  backend is retired.
- [ ] Decide whether one release artifact must retain the full JSON compatibility
  backend for emergency rollback.
- [ ] Rebaseline startup, append, storage, backup, restore, and export after deleting
  compatibility code.

## 3. Make model-round history bookkeeping incremental

Stop rescanning and rehashing complete provider history on every tool/model round.

- [ ] Assign or cache immutable content signatures for stored messages.
- [ ] Cache token/category breakdowns by content signature.
- [ ] Recompute attribution only for new or edited messages.
- [ ] Avoid repeatedly hashing historical image base64 and tool output.
- [ ] Store provider calibration at a turn or checkpoint level where possible.
- [ ] Update only attribution records whose values changed.
- [ ] Instrument full-history walks so regressions are visible.
- [ ] Benchmark tool-heavy, image-heavy, compacted, and very large conversations.

## 4. Replace full-sidebar IPC with revisioned deltas

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

## 5. Split daemon responsibilities into services

Extract boundaries around ownership and transaction behavior rather than merely
moving code to reduce file sizes.

- [ ] Create `ConversationService` for conversation invariants and mutations.
- [ ] Create `WorkspaceService` for conversation cwd and workspace lifecycle.
- [ ] Create `SidebarService` for folders, ordering, pinning, and revisions.
- [ ] Create `QueueService` for durable intent, dispatch, and receipts.
- [ ] Create `SchedulerService` for Chrono lifecycle.
- [ ] Create `NotificationRegistry` for external and subagent notification state.
- [ ] Create `ConversationEventPublisher` for post-commit event publication.
- [ ] Formalize a `RealtimeCallService` boundary that owns ephemeral media/session
  state and commits only finalized transcript/status messages through
  `ConversationService`.
- [ ] Replace shared mutable-conversation reconciliation between orchestrator,
  realtime calls, queues, and external events with generation-aware mutation APIs.
- [ ] Make command-family handlers validate input and call services.
- [ ] Keep UI payload construction outside the repository.
- [ ] Publish events only after the durable mutation commits.
- [ ] Stop orchestration and call code from reaching through multiple persistence
  layers.
- [ ] Reduce the responsibilities currently concentrated in:
  - `handler.ts`
  - `conversations.ts`
  - `persistence.ts`
  - `exocortex-tool-runtime.ts`
  - `orchestrator.ts`

## 6. Add versioned runtime schemas for IPC

Use runtime validation rather than relying only on TypeScript protocol types.

- [ ] Parse every inbound command before dispatch.
- [ ] Define explicit protocol versions and client capabilities.
- [ ] Centralize defaults, enums, ID constraints, and mutually exclusive options.
- [ ] Validate realtime adapter identity, participant trust, SDP/audio size, MIME type,
  timestamps, and utterance idempotency fields before they reach call transports.
- [ ] Share or derive TypeScript types from the runtime schemas.
- [ ] Validate daemon events in development and tests.
- [ ] Roll out sidebar deltas through capability negotiation.
- [ ] Move scattered handler validation into schemas and service-level invariants.

## 7. Add worktree-instance lifecycle management

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

## 8. Finish diagnostics storage improvements

- [ ] Buffer diagnostic writes asynchronously.
- [ ] Write one tool-call batch instead of one append per result.
- [ ] Compress closed daily diagnostic files.
- [ ] Separate temporary performance profiling from always-on operational metrics.
- [ ] Make retention and daily caps configurable if needed.
- [ ] Prefer request-level aggregates and bounded samples over verbose event copies.
- [ ] Do not migrate the historical verbose JSONL shape into SQLite unchanged.

## 9. Move remaining small JSON state only when transactions require it

Do not migrate remaining small files solely to replace JSON. Move them only when
they need atomic updates with conversation state.

- [ ] Evaluate moving Chrono schedules into the per-instance database.
- [ ] Evaluate moving external notification routes when route/receipt updates require
  atomic conversation mutations.
- [ ] Keep human-edited user configuration—including audio/call preferences—in an
  appropriate editable format.
- [ ] Keep provider credentials and other secrets outside the conversation
  database.

## Decisions to make during implementation

- [ ] Define clone behavior for conversation workspaces.
- [ ] Define workspace inclusion in export, import, backup, and restore.
- [ ] Decide whether workspace size warnings or quotas are needed.
- [ ] Define the compatibility/deprecation path for `agent.workingDirectory`.
- [ ] Set the exact release/date for retiring the JSON runtime backend and archiving
  pre-cutover rollback files.
- [ ] Decide whether conversation data will ever be shared across worktree
  instances.
- [ ] Set sidebar snapshot paging thresholds.
- [ ] Define FTS scope and privacy/size rules for tool output.
- [ ] Decide whether token attribution belongs per message, turn, checkpoint, or a
  hybrid of those levels.
- [ ] Classify diagnostics as temporary profiling or long-lived operational data.
