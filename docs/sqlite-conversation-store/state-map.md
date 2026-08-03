# Conversation Persistence Inventory and State Map

## Public conversation behavior

`conversations.ts` owns the in-memory domain behavior and exposes:

- lifecycle: create, create-with-message, get, indexed existence, clone, remove,
  remove-many, undo, redo, load, flush, and cache management
- metadata: provider/model, effort, fast mode, title, marked, pinned, sort order,
  folder, system instructions, subagent policy, and timestamps
- goals: set, status transitions, clear, turn count, and restart-recoverable lists
- history: trim, unwind, complete replay, render snapshots, paged display history,
  deferred tool outputs, context attribution, active context, finalized realtime
  transcripts/call markers, and in-place realtime delegation promotion
- sidebar: summary/folder lists, folder CRUD, nested moves, batch moves, pinning,
  recursive delete, unwrap delete, and folder instructions
- inbox state: unread and external inbox notices
- durable queue functions re-exported from `message-queue.ts`

`handler.ts` maps IPC commands for every user-visible operation, including
creation/send/replay/compact, all metadata and sidebar mutations, queue CRUD,
load/history/tool-output reads, BTW, goals, realtime-call lifecycle/media adapter
commands, external notifications, and account operations. IPC shapes remain outside
the repository; finalized call history reaches storage through ordinary conversation
mutations.

## Existing file inventory

| Existing path | Existing role | SQLite destination / disposition |
|---|---|---|
| `data/conversations/<id>.json` v1-v18 | canonical conversation and messages | `conversations`, `messages`, `active_contexts`; retained read-only as import/rollback |
| `data/conversations/<id>.sidebar` | targeted canonical sidebar overlay | folded during import; direct `conversations` row update afterward |
| `data/conversations/<id>.unwind` | targeted transcript cut + queue tombstones | folded during import; `unwind_receipts` and one transaction afterward |
| `data/conversations-index.json` v3 | summary acceleration and freshness metadata | eliminated; indexed `conversations` query |
| `data/display-pages/**` v2 | disposable compact display projection | eliminated at runtime; `display_entries` inside SQLite |
| `data/folders.json` | folder tree/order | `folders` |
| `data/folder-instructions.json` | inherited folder text | `folder_instructions` |
| `data/unread.json` | unread conversation IDs | `unread_conversations` |
| `data/message-queue.json` | durable daemon queue | `queued_messages` |
| `data/btw.json` | BTW sessions and accepted receipts | `btw_sessions`, `btw_receipts` |
| `data/trash/<id>.json` | soft-deleted transcript | SQLite soft-delete (`deleted_at`) with messages retained |
| `data/trash/trash.json` | undo stack | `sidebar_history` with stack=`undo` |
| `data/trash/redo.json` | redo stack | `sidebar_history` with stack=`redo` |
| `data/subagent-notifications.json` | child completion delivery state | retained external file in this pass; existence/deletion integration tested |
| `data/chrono.json` | schedules/occurrences | retained Chrono-owned file; conversation IDs validated through repository |
| `data/external-notifications.json` | source routes/subscriptions/receipts | retained service-owned file; targets validated/pruned through repository |
| `data/external-notification-soft-wakes.json` | command wake delivery | retained service-owned file |
| `config.json` `audio.callVoice` / `audio.micGainDb` | editable realtime/TUI preference | retained human-editable instance configuration; never stored in SQLite |
| finalized realtime transcript/status messages | previously normal conversation JSON messages with provenance metadata | canonical `messages` rows; metadata round-trips through `metadata_json` without a schema migration |
| live WebRTC/Bidi call, SDP, audio, transcript deltas, roster/speaker windows | process-owned media/session state | ephemeral; never imported/exported or resumed |
| runtime interrupted/goal markers | restart coordination | retained ephemeral/runtime file; candidate IDs filtered by SQLite summaries |
| sockets, PIDs, logs, diagnostics, token stats | runtime/accounting | unchanged and never imported |
| credentials/secrets | authentication | unchanged and forbidden from SQLite |

## Canonical versus derived state

Canonical SQLite state:

- scalar conversation metadata and generation
- ordered stored messages and all message fields, including finalized realtime
  transcript provenance/speaker attribution and call boundary markers
- active context/checkpoints
- folder/order/instruction state
- unread state
- queue entries and durable receipt identities
- undo/redo stack and soft-delete state
- unwind receipts
- BTW sessions/receipts

Derived/rebuildable state:

- message count and summary query projections (`realtime_call_status` markers are
  intentionally excluded from the visible message count)
- compact display entries
- extracted tool-output lookup rows
- optional FTS title index

Ephemeral state:

- live streaming blocks and sequence counters
- active realtime-call manager/transport state, SDP, audio, partial transcripts,
  participant/speaker windows, and adapter/utterance dedupe caches
- AbortControllers and history-unwind leases
- active subagent/background processes and projected task counts
- connected clients/subscriptions and render caches

Rollback-only after cutover:

- canonical JSON files, index, `.sidebar`/`.unwind`, display-page trees, and legacy
  trash metadata. The importer/exporter understands these, but normal SQLite
  operation does not mutate them.

## Startup/recovery paths

Startup currently loads/repairs the JSON summary index, folders/instructions,
unread, queue + unwind tombstones, notification routes, external soft wakes,
Chrono, pending titles, interrupted stream markers, active-goal markers, and
subagent notification delivery. SQLite changes the first four: schema/open and
resumable import happen first, then indexed summary/folder/unread/queue reads.
Remaining service startup order stays the same and uses indexed existence checks.
The display-page backfill worker is disabled for SQLite. Instance-local restart closes
active realtime transports, flushes/then closes SQLite, and reopens the same namespaced
database; finalized call messages recover with ordinary history, but no live media
session is reconstructed.

## Legacy schema handling

JSON conversation versions 1 through 18 are progressively upgraded by the
compatibility adapter. Import always calls that adapter, so SQLite schema
migrations do not duplicate eighteen historical message migrations. The SQLite
schema begins at version 1 and stores the normalized current domain shape.
