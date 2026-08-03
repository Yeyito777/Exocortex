# Import, Cutover, Backup, and Rollback

## Safety invariants

1. Main-instance JSON is opened read-only by fixture tooling and import logic.
2. A worktree uses its own namespaced `dataDir`, database, socket, and runtime.
3. An import transaction is all-or-nothing per conversation.
4. Imported rows record source size, mtime, generation, and SHA-256.
5. A completed source hash is idempotent; changed sources can be re-imported only
   before canonical SQLite writes begin.
6. Live Chrono schedules, goals, subscriptions, queues, active BTW sessions, and
   subagent recovery records are excluded from the copied real fixture.

## First startup

1. Open `<dataDir>/exocortex.sqlite3` and apply schema migrations.
2. If `store_metadata.canonical_backend=sqlite` exists, do not scan JSON.
3. If no completed import exists, enumerate both live `conversations/*.json` and
   soft-deleted `trash/*.json` sources. Refuse an ambiguous ID present in both.
4. Import folders and folder instructions, then load every live and deleted
   conversation through the v1-v18 compatibility loader. Deleted sources are inserted
   with `deleted_at` set, their canonical messages retained, and no live summary.
5. Fold live `.sidebar` and `.unwind` overlays by importing the compatibility loader's
   materialized `Conversation` result. Finalized realtime transcript/status messages,
   including speaker and adapter provenance, require no special import because they
   are ordinary v18 messages whose metadata is preserved exactly.
6. Import unread, queue, BTW, and the normalized `trash/trash.json` undo and
   `trash/redo.json` redo stacks in their original order. This also runs when there
   are no live conversations and the legacy corpus consists only of trash/history.
7. Log bounded progress (every 100 sources or two seconds), verify counts/hashes,
   persist the final import report, and mark the import complete.
8. Read summaries directly from indexed rows and continue daemon startup.

A crash before the completion marker is safe: completed live and deleted source
hashes are skipped, source state (live versus deleted) is checked before reuse, and a
partially imported conversation cannot exist because each unit is a transaction.
Auxiliary state and both history stacks commit together only after all conversation
sources succeed. A corrupt or ambiguous source is reported and leaves the overall
import incomplete rather than silently disappearing. Fixture creation performs an
immediate strict source stability check; later fixture verification always checks
the immutable copied hashes and reports ordinary live-main source drift separately.

## Canonical cutover

Production's default backend is `sqlite`. `EXOCORTEX_CONVERSATION_STORE=json` is
an explicit compatibility switch for rollback/baseline operation. The switch is
read once by the persistence facade; callers do not combine backends.

Once SQLite is canonical:

- all ordinary reads/writes target SQLite only;
- legacy JSON and projections are not updated;
- JSON remains a point-in-time rollback snapshot;
- normalized JSON export is the way to create a newer rollback snapshot.

## Inspection, backup, and restore

The administration surface uses the current worktree's detected instance by
default. Pass `--database /explicit/path/exocortex.sqlite3` to target another store:

```bash
bun scripts/dev/sqlite-store-admin.ts diagnostics
bun scripts/dev/sqlite-store-admin.ts check
bun scripts/dev/sqlite-store-admin.ts backup /new/path/backup.sqlite3
bun scripts/dev/sqlite-store-admin.ts restore-to-new /path/backup.sqlite3 /new/path/restored.sqlite3
```

Backup first runs integrity and foreign-key checks, checkpoints WAL, uses
`VACUUM INTO` to create a temporary destination, opens and quick-checks it, then
atomically renames it. It never copies only the main file from an uncheckpointed
live WAL database.

Never restore over an open database. Restore validates a source backup and copies
it to a new path. The operator then stops only the target instance, swaps paths,
and restarts that instance. An instance-local daemon restart uses the same shutdown
order: stop active call transports, flush canonical messages, close/checkpoint the
SQLite connection, and let the instance supervisor reopen the same `dataDir()`.

## JSON export

One-conversation export reproduces the current v18 normalized object, including
finalized realtime transcript/status metadata. Full export writes live conversations
under `conversations/`, soft-deleted conversations under `trash/`, and undo/redo
metadata as `trash/trash.json` and `trash/redo.json`, alongside folders, instructions,
unread, queue, and BTW state. The result is directly usable as a JSON rollback tree;
delete undo remains functional after rollback. Active call transports, raw audio,
partial deltas, and participant/speaker windows are ephemeral and are intentionally
absent. Export never writes into an existing legacy corpus unless an explicit empty
destination is supplied.

```bash
bun scripts/dev/sqlite-store-admin.ts export-one <id> /new/path/conversation.json
bun scripts/dev/sqlite-store-admin.ts export-all /new/empty/export-directory
```

`export-one` refuses to overwrite an existing file; `export-all` refuses a non-empty
destination.

## Rollback

### To original pre-cutover JSON snapshot

1. Stop only the affected daemon instance.
2. Preserve `exocortex.sqlite3`, `-wal`, and `-shm` for diagnosis.
3. Set `EXOCORTEX_CONVERSATION_STORE=json` for that instance.
4. Start the instance and verify JSON index repair and conversation counts.

This intentionally loses SQLite-only changes made after cutover.

### To a current exported JSON snapshot

1. While SQLite is healthy, export to a new directory and verify its manifest.
2. Stop only the affected instance.
3. archive (do not delete) the old legacy conversation/data files.
4. install the verified export under that instance's data directory.
5. select the JSON backend and restart.

## Cleanup policy

No automatic cleanup removes JSON, sidecars, display pages, or a database. The
SQLite runtime does not read or update `conversations-index.json`, display-page
files, `.sidebar`, or `.unwind` after canonical cutover, but those rollback inputs
remain on disk. Archive cleanup is a separate future operation and remains deferred
until the user accepts this worktree and an agreed bake-in release has passed.
