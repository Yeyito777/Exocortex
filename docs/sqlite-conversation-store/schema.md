# SQLite Conversation Schema

Canonical database: `<dataDir>/exocortex.sqlite3`

Current schema version: **2**

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
subagent policy/depth, `storage_generation`, summary message counts, compact
display count, and `deleted_at`.

`folder_id` intentionally has no foreign key. A soft-deleted conversation must
retain its historical folder membership while its folder is temporarily absent
from the live tree but recoverable from the undo stack. The domain layer validates
folder IDs when projecting live summaries.

### `messages`

One row per `(conversation_id, sequence)`, `WITHOUT ROWID`. Fields are split so
small attribution/checkpoint changes do not rewrite large content:

- role and canonical `content_json`
- metadata, provider data, context-token attribution, and user checkpoint JSON
- explicit `has_*` bits preserving the semantic distinction between an absent
  optional property and a present JSON `null` (schema v2)
- indexed real-user/replay-history flags
- byte size, content hash, and normalized message hash

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
  is_error)` — direct deferred tool-result lookup; tied to canonical message rows.

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

Content/image/tool-output FTS is intentionally absent. Title search uses bounded
metadata-only queries; raw tool outputs and base64 are never indexed.

## SQLite configuration

The daemon owns one connection per instance and verifies:

```text
journal_mode = WAL
synchronous = NORMAL
foreign_keys = ON
busy_timeout = 5000 ms
wal_autocheckpoint = 1000 pages
```

Clean shutdown truncates the WAL. Online backup checkpoints, uses `VACUUM INTO`
a new path, and quick-checks the result before publishing it.
