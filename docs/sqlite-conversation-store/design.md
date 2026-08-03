# SQLite Conversation Store Design

Status: approved implementation design, 2026-08-01

## Repository boundary

The daemon keeps its existing `Conversation` domain model and IPC payloads. Storage
is selected at the `persistence.ts` boundary:

- `json-persistence.ts` is the compatibility/import/rollback adapter.
- `sqlite-conversation-store.ts` is the normalized canonical repository.
- `persistence.ts` is a narrow backend facade. Production defaults to SQLite;
  tests may explicitly select JSON to preserve migration compatibility coverage.

The repository owns lifecycle, summaries, conversations, messages, folders,
unread state, queue state, undo/redo, BTW state, paging, import/export, backup,
and integrity operations. Finalized realtime-call transcripts and model-hidden call
boundary markers are ordinary canonical messages. Streaming blocks, realtime media
sessions, transport state, process/task catalogs, live leases, and subscriber state
remain ephemeral.

## Connection and transaction model

One daemon process owns one lazily opened `bun:sqlite` connection to
`<dataDir>/exocortex.sqlite3`.

Connection policy:

- `journal_mode=WAL`
- `synchronous=NORMAL`
- `foreign_keys=ON`
- `busy_timeout=5000`
- bounded automatic checkpointing plus an explicit truncate checkpoint on clean
  close/backup
- all schema migrations and multi-row mutations use transactions

SQLite serializes writes. Repository reads return newly deserialized immutable
snapshots from a committed database state; callers then own the returned mutable
`Conversation` object until the next save. Each durable conversation mutation
increments `storage_generation`. Overlay/unwind operations compare the expected
loaded generation before committing.

## Message identity and append behavior

A message is identified by `(conversation_id, sequence)`, where `sequence` is a
zero-based, gap-free position in canonical history. Sequence values are stable
for append and metadata changes. Transcript cuts delete a suffix; trim operations
may resequence only inside their transaction.

Message fields are separate columns (`role`, content, metadata, provider data,
context attribution, and checkpoint), so attribution updates never rewrite a
large content value. Full message content is selected only for provider replay,
export, a requested page, or a requested tool output.

The repository remembers the persisted object references for each loaded
conversation. An ordinary append inserts only the suffix and updates scalar
metadata. Explicit transcript mutations force comparison/replacement from their
first changed message. This makes append I/O proportional to new content rather
than the historical transcript bytes.

## Realtime calls and concurrent transcript writers

Realtime transport is intentionally outside the repository. WebRTC/Bidi sessions,
SDP, PCM/audio bytes, live transcript deltas, participant rosters, active-speaker
segments, adapter connections, utterance idempotency caches, and active call state
are process-owned and restart-unsafe. The configured default call voice remains in
editable instance configuration.

Only finalized semantic history crosses the repository boundary:

- finalized user and assistant utterances are stored as normal messages with
  `metadata.kind=realtime_transcript`;
- authenticated source/speaker attribution and call/adapter provenance live in the
  message's `metadata_json` and therefore survive paging, export, and rollback;
- start/end lifecycle markers are stored as model-hidden system messages with
  `metadata.kind=realtime_call_status`; they remain auditable/displayable but are
  excluded from the summary's user-visible message count;
- raw audio, partial transcript deltas, and a resumable active-call record are never
  stored in SQLite.

A realtime backend handoff promotes the already-persisted user transcript in place
instead of appending a duplicate user request. That path marks message content dirty,
so SQLite compares hashes and atomically rewrites from the first changed sequence.
The orchestrator's turn merge retains messages appended by calls or other subsystems
while a provider stream is active. SQLite still receives one ordered canonical
history at each flush; ephemeral streaming mirrors are merged for display but are
not independently persisted.

Daemon restart stops active call transports before closing the repository. Persisted
transcripts and boundary markers survive; an in-progress call itself is not resumed.
The instance-aware restart supervisor reopens the same per-instance database.

## Display paging

`display_entries` is a transactionally maintained, disposable index inside the
same database—not a second canonical file tree. It contains compact display
entries, user-turn ordinals, and canonical entry ordinals. Tool-result bodies are
omitted and images older than the recent-image window are stripped at read time.

On append, only the display suffix beginning at the last affected real user turn
is rebuilt. Destructive edits rebuild the affected suffix or, where identity is
uncertain, the whole projection. Page queries locate user-turn bounds with an
index and select only overlapping rows. Provider replay always reads `messages`,
never `display_entries`.

## Active context

The active provider replay is stored in `active_contexts` as one versioned JSON
payload plus its indexed cursor/hash/window metadata. It is validated against
canonical message prefixes after deserialization. User checkpoint references
remain message fields. Invalid checkpoints are discarded exactly as in the JSON
adapter and force full canonical replay.

## Large content policy

Schema v6 keeps ordinary text and content-block structure in `messages.content_json`
but moves tool-result bodies and image base64 into `message_blobs`. The compact
message row retains an empty placeholder; full loads reconstruct the original value
from blob rows. `tool_outputs` keeps only lookup identity, so payload bytes are not
duplicated. Summary, sidebar, page, and ordinary message queries select no blob
column. Composite foreign keys cascade blob deletion from canonical messages, and
content hashes make integrity/diagnostic reporting possible. No base64 or raw tool
output is indexed by FTS.

## Generation and faults

Every save, unwind, delete, restore, queue snapshot, and stack mutation runs in a
transaction. Conversation saves update metadata, changed message rows, tool
output rows, display rows, active context, and generation in one commit.
Transactions either return success after commit or throw before in-memory callers
acknowledge. SQLite's rollback journal/WAL semantics supply crash atomicity;
tests inject failures inside transactions and reopen the database.

## Schema migration policy

`schema_migrations(version, name, applied_at)` records each migration. Startup
runs missing migrations in order inside transactions and refuses a database with
a version newer than the binary supports. A failed migration rolls back and the
daemon exits with the database and legacy JSON untouched.

## Backup, restore, and integrity

The repository exposes:

- `PRAGMA quick_check` and full foreign-key checks
- checkpoint plus SQLite online backup to a new file
- restore validation into a new file (never overwrite an open database)
- normalized JSON export for one conversation or the full instance, including
  soft-deleted conversations and ordered undo/redo history

Backups and exports use temporary destinations followed by atomic rename where
the filesystem permits it.

## Backend/cutover state

The backend is one explicit value:

- `json`: compatibility and baseline testing
- `sqlite`: canonical production reads/writes; auto-import legacy JSON only when
  the database has no completed import

There is no ambiguous per-call mix of canonical backends. Import is resumable and
idempotent. It treats live and soft-deleted JSON conversations as distinct source
states, preserves deleted message rows plus ordered undo/redo stacks, and refuses a
source ID found in both directories rather than choosing nondeterministically. A
trash-only corpus still imports and can be undone after cutover. Legacy JSON is
read-only once SQLite is canonical and remains the rollback snapshot until a
separately approved cleanup. Full normalized export recreates the same live/trash
layout so rollback retains delete undo.

The approved repository design deliberately uses an instance-level direct cutover
rather than dual writes. A JSON-first/SQLite-second shadow mutation cannot be atomic
across the filesystem and SQLite and would introduce its own durable retry log and
split-brain recovery protocol. Instead, the fixture verifier proves parity before
cutover, SQLite transactions become the only acknowledged writes, and backup plus
normalized JSON export provide current rollback snapshots.

## Windows/Bun compatibility

The design uses `bun:sqlite`, SQL supported by SQLite, path helpers from shared,
and no Unix locking assumptions. WAL may leave `-wal`/`-shm` files beside the
database. Backup/restore closes or checkpoints explicitly rather than copying a
live trio with filesystem-specific semantics. The short Unix-socket fallback for
deep linked-worktree paths changes only IPC transport location; `dataDir()` and the
canonical database path remain instance-namespaced and unchanged.
