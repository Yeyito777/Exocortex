#!/usr/bin/env bun
/** Copy ONE conversation transactionally into a NEW isolated database.
 * Source is attached mode=ro, including resolved clone blobs. No canonical JSON
 * materialization and no production migrations/writes/provider/daemon contact.
 * bun scripts/dev/snapshot-archive-fixture.ts SOURCE_DB ID NEW_DB
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { Database } from "bun:sqlite";

const [source, id, destination] = process.argv.slice(2);
if (!source || !id || !destination) throw new Error("Expected SOURCE_DB ID NEW_DB");
const path = resolve(destination);
if (existsSync(path)) throw new Error("Refusing to overwrite a snapshot");
const store = new SqliteConversationStore({ path });
store.close();
// SQLITE_OPEN_READWRITE | SQLITE_OPEN_URI. Bun's default connection does not
// enable URI filenames; explicitly enable mode=ro for the attached source.
const db = new Database(path, 2 | 64);
db.exec("PRAGMA foreign_keys=ON");
let needsEnrollment = false;
try {
  const uri = pathToFileURL(resolve(source)); uri.searchParams.set("mode", "ro");
  db.query("ATTACH DATABASE ? AS original").run(uri.href);
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM original.conversations WHERE id=? AND deleted_at IS NULL").get(id)) throw new Error("Conversation not found");
    for (const table of ["folders", "folder_instructions"]) db.exec(`INSERT INTO main.${table} SELECT * FROM original.${table}`);
    db.query("INSERT INTO main.conversations SELECT * FROM original.conversations WHERE id=?").run(id);
    for (const table of ["messages", "tool_outputs", "active_contexts", "display_entries", "unwind_receipts"]) {
      db.query(`INSERT INTO main.${table} SELECT * FROM original.${table} WHERE conversation_id=?`).run(id);
    }
    const catalog = db.query("SELECT 1 FROM original.sqlite_master WHERE type='table' AND name='checkpoint_integrity'").get();
    if (catalog) {
      for (const table of ["message_integrity", "checkpoint_integrity", "display_integrity"]) {
        db.query(`INSERT INTO main.${table} SELECT * FROM original.${table} WHERE conversation_id=?`).run(id);
      }
    } else needsEnrollment = true;
    db.query(`INSERT INTO main.message_blobs
      SELECT conversation_id, message_sequence, kind, ordinal, payload_json, payload_bytes, content_hash
      FROM original.resolved_message_blobs WHERE conversation_id=?`).run(id);
  })();
  db.exec("DETACH DATABASE original");
  console.log(JSON.stringify({ path, id, messages: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(id)!.n }));
} finally { db.close(); }
// The source may predate the checksum catalog. Only this NEW owned snapshot is
// enrolled, after all rows have been copied; no source checksum is rewritten.
if (needsEnrollment) {
  const enrolled = new SqliteConversationStore({path});
  try { enrolled.db.transaction(() => enrolled.initializeIntegrityBaselines())(); }
  finally { enrolled.close(); }
}
