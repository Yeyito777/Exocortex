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
3. If no completed import exists and legacy JSON exists, import folders and folder
   instructions, then each conversation through the v1-v18 compatibility loader.
4. Fold `.sidebar` and `.unwind` overlays by importing the compatibility loader's
   materialized `Conversation` result.
5. Import unread, queue, BTW, and undo/redo snapshots when present.
6. Verify counts/hashes and mark the import complete.
7. Read summaries directly from indexed rows and continue daemon startup.

A crash before step 6 is safe: completed conversation source hashes are skipped,
and a partially imported conversation cannot exist because each unit is a
transaction. A corrupt source is reported and leaves the overall import
incomplete rather than silently disappearing.

## Canonical cutover

Production's default backend is `sqlite`. `EXOCORTEX_CONVERSATION_STORE=json` is
an explicit compatibility switch for rollback/baseline operation. The switch is
read once by the persistence facade; callers do not combine backends.

Once SQLite is canonical:

- all ordinary reads/writes target SQLite only;
- legacy JSON and projections are not updated;
- JSON remains a point-in-time rollback snapshot;
- normalized JSON export is the way to create a newer rollback snapshot.

## Backup

1. Run integrity and foreign-key checks.
2. Checkpoint WAL.
3. Use SQLite online backup into a new temporary file.
4. Open and quick-check the temporary backup.
5. Atomically rename it to the requested backup destination.

Never restore over an open database. Restore validates a source backup and copies
it to a new path. The operator then stops only the target instance, swaps paths,
and restarts that instance.

## JSON export

One-conversation export reproduces the current v18 normalized object. Full export
writes one JSON file per live conversation plus folders, instructions, unread,
queue, BTW, and undo/redo metadata into a new directory. It never writes into an
existing legacy corpus unless an explicit empty destination is supplied.

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

No automatic cleanup removes JSON, sidecars, display pages, or a database. Archive
cleanup is a separate command and remains deferred until the user accepts this
worktree and an agreed bake-in release has passed.
