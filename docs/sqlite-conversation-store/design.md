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
and integrity operations. Streaming blocks, process/task catalogs, live leases,
and subscriber state remain ephemeral.

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

The first schema keeps message content inline in a dedicated SQLite column. This
still prevents ordinary summary/page queries from reading it because SQLite
queries select explicit columns; tool output has a separately indexed extraction
row. A blob/content-addressed layer is intentionally deferred unless profiles
show that inline values cause unacceptable write amplification or fragmentation.
No base64 or tool output is indexed by FTS.

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
- normalized JSON export for one conversation or the full instance

Backups and exports use temporary destinations followed by atomic rename where
the filesystem permits it.

## Backend/cutover state

The backend is one explicit value:

- `json`: compatibility and baseline testing
- `sqlite`: canonical production reads/writes; auto-import legacy JSON only when
  the database has no completed import

There is no ambiguous per-call mix of canonical backends. Import is resumable and
idempotent. Legacy JSON is read-only once SQLite is canonical and remains the
rollback snapshot until a separately approved cleanup.

## Windows/Bun compatibility

The design uses `bun:sqlite`, SQL supported by SQLite, path helpers from shared,
and no Unix locking assumptions. WAL may leave `-wal`/`-shm` files beside the
database. Backup/restore closes or checkpoints explicitly rather than copying a
live trio with filesystem-specific semantics.
