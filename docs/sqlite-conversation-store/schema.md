# SQLite Conversation Schema

Canonical database: `<dataDir>/exocortex.sqlite3`

Current schema version: **7**

## Lifecycle tables

- `schema_migrations(version, name, applied_at)` — ordered transactional schema
  migrations; future versions are rejected.
- `store_metadata(key, value, updated_at)` — canonical-backend and resumable
  import state.
- `import_sources(conversation_id, source_size, source_mtime_ms,
  source_generation, source_sha256, imported_at)` — stable legacy-source identity.

## Canonical conversation tables

### `conversations`

One live or soft-deleted row per conversation. It stores provider/model/effort,
fast mode, timestamps, context total, marked/pinned/order/folder/title, goal,
subagent policy/depth, exact per-conversation `tool_policy_json`,
`storage_generation`, summary message counts, compact display count, and
`deleted_at`.

`folder_id` intentionally has no foreign key. A soft-deleted conversation must
retain its historical folder membership while its folder is temporarily absent
from the live tree but recoverable from the undo stack. The domain layer validates
folder IDs when projecting live summaries.

### `messages`

One row per `(conversation_id, sequence)`, `WITHOUT ROWID`. Fields are split so
small attribution/checkpoint changes do not rewrite large content:

- role and compact `content_json`
- metadata, provider data, context-token attribution, and user checkpoint JSON
- explicit `has_*` bits preserving the semantic distinction between an absent
  optional property and a present JSON `null` (schema v2)
- indexed real-user/replay-history flags
- byte size, content hash, and normalized message hash

Realtime call support requires no schema version bump. Finalized transcript and
lifecycle messages use the existing `metadata_json` column for
`realtimeCallId`, adapter/source identity, authenticated speaker attribution, and
`kind` (`realtime_transcript` or `realtime_call_status`). Raw call audio, SDP,
partial deltas, participant rosters, and active transport state have no table.

`conversations.message_count` is derived with domain semantics rather than raw row
count. In particular, model-hidden `realtime_call_status` rows remain canonical and
auditable while being excluded from that summary count.

`content_json` contains ordinary text and block structure. Large tool-result bodies
and image base64 are replaced by empty placeholders and stored in `message_blobs`.
A full load joins those blobs and reconstructs the exact original message before it
leaves the repository.

`messages` cascades when a conversation is permanently removed. Normal user
operations use soft delete, so rows remain available for instant restore.

### `active_contexts`

One optional row per conversation with indexed replay/window/hash cursors and the
complete versioned provider replay payload. Loads validate it against canonical
message prefixes before use.

## Transactional derived tables

- `display_entries(conversation_id, pinned, entry_index, user_index, type,
  payload_json)` — compact page-addressable display rows, rebuilt only from an
  affected user-turn suffix on append and fully rebuilt after destructive edits.
  Tool output is omitted. Old image base64 is stripped at query time.
- `tool_outputs(conversation_id, message_sequence, ordinal, tool_call_id, output,
  is_error)` — direct deferred tool-result identity lookup. As of schema v5 its
  legacy `output` column is intentionally empty; payload bytes are not duplicated.
- `message_blobs(conversation_id, message_sequence, kind, ordinal, payload_json,
  payload_bytes, content_hash)` — separately selected tool-result and image payloads
  introduced in schema v6. Its composite foreign key cascades from `messages`, so
  deleting a message/conversation cannot leave orphan payloads.

These are rebuildable but are committed in the same transaction as message
changes, so readers never observe a projection generation different from
canonical history.

## Sidebar and user-state tables

- `folders` — nested folder metadata/order (self-referencing deferred FK).
- `folder_instructions` — inherited instructions, cascading with folders.
- `unread_conversations` — live unread membership and order timestamp.
- `sidebar_history(stack, position, entry_json)` — ordered `undo` and `redo`
  stacks for all existing sidebar history entry variants.

## Queue, rewind, and BTW

- `queued_messages` — stable ID, target conversation/draft ID, FIFO position,
  timing, source, timestamp, and complete versioned payload.
- `unwind_receipts` — idempotent operation ID, user identity, resulting display
  count, and exact superseded queue IDs. Rewind and queue deletion share a
  transaction in SQLite; legacy tombstone APIs map to this table for compatibility.
- `btw_sessions` and `btw_receipts` — conversation-owned panel state and accepted
  session dedupe. These may load before conversation summaries, so they do not
  use a conversation FK; deletion integration removes them transactionally.

## Critical indexes

- `conversations_live_sidebar_idx`: live folder/pin/order listing
- `conversations_live_updated_idx`: recent/indexed metadata listing
- `conversations_goal_idx`: non-null goal recovery candidates
- `messages_page_idx`: real-user sequence bounds
- `display_user_page_idx`: user-turn cursor to display-entry range
- queue position/target indexes
- undo/redo descending stack index

Schema v4 maintains `conversation_title_fts`, an FTS5 title-only index synchronized
by insert/update/delete triggers. Content/image/tool-output FTS is intentionally
absent; raw tool outputs and base64 are never indexed.

## SQLite configuration

The daemon owns one connection per instance and verifies:

```text
journal_mode = WAL
synchronous = NORMAL
foreign_keys = ON
busy_timeout = 5000 ms
wal_autocheckpoint = 1000 pages
```

Clean shutdown—including an instance-local restart—stops active realtime transports,
flushes conversations, closes the connection, and truncates the WAL. Online backup
checkpoints, uses `VACUUM INTO` a new path, and quick-checks the result before
publishing it.

## Migration history

1. Normalized conversation, message, page, folder, queue, undo, unwind, BTW, and
   import schema.
2. Optional-message-field presence bits.
3. Constant-time canonical content-byte totals on conversation rows.
4. Trigger-maintained FTS5 title index.
5. Removal of duplicate tool-output payload bytes from the direct lookup table.
6. Separate message payload rows for tool results and image base64.

Each migration is transactional. Startup rejects a database whose highest version
is newer than the binary and leaves both SQLite and legacy JSON data untouched on
failure.

## Inspection

Run the instance-aware administration script from the repository root:

```bash
bun scripts/dev/sqlite-store-admin.ts check
bun scripts/dev/sqlite-store-admin.ts diagnostics
bun scripts/dev/sqlite-store-admin.ts --database /explicit/path/exocortex.sqlite3 check
```

Diagnostics report schema/database/WAL sizes, live and soft-deleted rows, message
and blob counts/bytes, display/tool references, queue and undo counts, and import
state without reading transcript text.
