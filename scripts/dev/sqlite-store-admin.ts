#!/usr/bin/env bun
/**
 * Inspect, validate, back up, restore, and export one instance's SQLite store.
 *
 * By default, shared path detection selects the worktree from which this script
 * is running. Use --database for an explicit target. Tests may instead point
 * EXOCORTEX_CONFIG_DIR at a fully isolated config root.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SqliteConversationStore,
  sqliteConversationStorePath,
} from "../../daemon/src/sqlite-conversation-store";

function usage(): never {
  console.error(`Usage:
  sqlite-store-admin.ts [--database PATH] diagnostics
  sqlite-store-admin.ts [--database PATH] check
  sqlite-store-admin.ts [--database PATH] checkpoint [PASSIVE|FULL|RESTART|TRUNCATE]
  sqlite-store-admin.ts [--database PATH] search QUERY [LIMIT]
  sqlite-store-admin.ts [--database PATH] backup DESTINATION.sqlite3
  sqlite-store-admin.ts [--database PATH] restore-to-new SOURCE.sqlite3 DESTINATION.sqlite3
  sqlite-store-admin.ts [--database PATH] export-one CONVERSATION_ID DESTINATION.json
  sqlite-store-admin.ts [--database PATH] export-all DESTINATION_DIRECTORY

Examples:
  bun scripts/dev/sqlite-store-admin.ts check
  bun scripts/dev/sqlite-store-admin.ts --database /path/exocortex.sqlite3 diagnostics`);
  process.exit(2);
}

const args = process.argv.slice(2);
let databasePath = sqliteConversationStorePath();
if (args[0] === "--database") {
  if (!args[1]) usage();
  databasePath = resolve(args[1]);
  args.splice(0, 2);
}
const [command, ...rest] = args;
if (!command) usage();
if (!existsSync(databasePath)) throw new Error(`SQLite conversation store does not exist: ${databasePath}`);

const store = new SqliteConversationStore({ path: databasePath });
try {
  switch (command) {
    case "diagnostics":
      console.log(JSON.stringify(store.diagnostics(), null, 2));
      break;
    case "check": {
      const report = { diagnostics: store.diagnostics(), integrity: store.integrityCheck() };
      console.log(JSON.stringify(report, null, 2));
      if (!report.integrity.ok) process.exitCode = 1;
      break;
    }
    case "checkpoint": {
      const mode = (rest[0] ?? "PASSIVE").toUpperCase();
      const checkpointModes = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"] as const;
      if (!checkpointModes.includes(mode as typeof checkpointModes[number])) usage();
      store.checkpoint(mode as typeof checkpointModes[number]);
      console.log(JSON.stringify({ ok: true, mode, diagnostics: store.diagnostics() }, null, 2));
      break;
    }
    case "search": {
      if (!rest[0]) usage();
      const limit = rest[1] ? Number(rest[1]) : 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("LIMIT must be an integer from 1 through 1000");
      const results = store.searchTitles(rest[0], limit).map(({ id, title, provider, model, updatedAt, folderId }) => ({
        id, title, provider, model, updatedAt, folderId,
      }));
      console.log(JSON.stringify({ query: rest[0], count: results.length, results }, null, 2));
      break;
    }
    case "backup": {
      if (rest.length !== 1) usage();
      console.log(JSON.stringify({ path: store.backup(rest[0]), integrity: store.integrityCheck() }, null, 2));
      break;
    }
    case "restore-to-new": {
      if (rest.length !== 2) usage();
      console.log(JSON.stringify({ path: store.restoreToNewFile(rest[0], rest[1]) }, null, 2));
      break;
    }
    case "export-one": {
      if (rest.length !== 2) usage();
      const value = store.exportConversation(rest[0]);
      if (!value) throw new Error(`Conversation not found: ${rest[0]}`);
      const destination = resolve(rest[1]);
      writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ id: rest[0], path: destination }, null, 2));
      break;
    }
    case "export-all": {
      if (rest.length !== 1) usage();
      const manifest = store.exportAll(rest[0]);
      console.log(JSON.stringify({ destination: resolve(rest[0]), manifest }, null, 2));
      break;
    }
    default:
      usage();
  }
} finally {
  store.close();
}
