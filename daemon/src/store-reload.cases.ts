/**
 * Conversations another process commits to the store while the daemon runs.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import {
  create,
  createFolder,
  deleteFolder,
  flush,
  getHistoryRev,
  getSummary,
  hasConversation,
  listFolders,
  moveConversationToFolder,
  reloadStoreChanges,
  remove,
} from "./conversations";
import { clearActiveJob, setActiveJob } from "./streaming";

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `test-reload-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

function stored(id: string, title: string): string {
  create(id, "openai", "gpt-5.4", title);
  flush(id);
  return id;
}

/** The other process: its own connection to the daemon's database. */
function otherProcess(write: (db: Database) => void): void {
  const db = new Database(join(dataDir(), "exocortex.sqlite3"));
  db.exec("PRAGMA busy_timeout=5000");
  try {
    write(db);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    if (hasConversation(id)) remove(id);
  }
});

describe("reloadStoreChanges", () => {
  test("reads a conversation another process changed and moves its history revision", () => {
    const id = stored(mkId("changed"), "before");
    const revision = getHistoryRev(id);
    otherProcess(db => db.query("UPDATE conversations SET title='after' WHERE id=?").run(id));
    expect(getSummary(id)?.title).toBe("before");

    expect(reloadStoreChanges([id], [])).toEqual({ changed: [id], removed: [], skipped: [] });

    expect(getSummary(id)?.title).toBe("after");
    expect(getHistoryRev(id)).not.toBe(revision);
  });

  test("picks up a conversation another process inserted", () => {
    const source = stored(mkId("source"), "source");
    const copy = mkId("inserted");
    otherProcess(db => db.query(`
      INSERT INTO conversations (id, provider, model, effort, fast_mode, created_at, updated_at, marked, pinned,
        sort_order, title, storage_generation)
      SELECT ?, provider, model, effort, fast_mode, created_at, updated_at, marked, pinned,
        sort_order + 1, 'inserted', storage_generation FROM conversations WHERE id=?
    `).run(copy, source));
    expect(hasConversation(copy)).toBe(false);

    reloadStoreChanges([copy], []);

    expect(hasConversation(copy)).toBe(true);
    expect(getSummary(copy)?.title).toBe("inserted");
  });

  test("drops a conversation another process deleted", () => {
    const id = stored(mkId("removed"), "gone");
    otherProcess(db => db.query("DELETE FROM conversations WHERE id=?").run(id));

    expect(reloadStoreChanges([], [id])).toEqual({ changed: [], removed: [id], skipped: [] });

    expect(hasConversation(id)).toBe(false);
  });

  test("keeps a removed ID the store still has", () => {
    const id = stored(mkId("still-stored"), "still here");

    expect(reloadStoreChanges([], [id]).removed).toEqual([]);

    expect(hasConversation(id)).toBe(true);
  });

  test("leaves a conversation with work in flight", () => {
    const changed = stored(mkId("busy-changed"), "before");
    const removed = stored(mkId("busy-removed"), "still running");
    otherProcess((db) => {
      db.query("UPDATE conversations SET title='after' WHERE id=?").run(changed);
      db.query("DELETE FROM conversations WHERE id=?").run(removed);
    });
    setActiveJob(changed, new AbortController(), Date.now());
    setActiveJob(removed, new AbortController(), Date.now());

    expect(reloadStoreChanges([changed], [removed]).skipped.sort()).toEqual([changed, removed].sort());

    expect(getSummary(changed)?.title).toBe("before");
    expect(hasConversation(removed)).toBe(true);
  });

  test("reads folders again and lets go of one that is gone", () => {
    const folder = createFolder("reload-folder");
    expect(folder).not.toBeNull();
    const id = stored(mkId("foldered"), "in a folder");
    moveConversationToFolder(id, folder!.id);
    flush(id);
    const added = `folder-test-${Date.now()}`;
    otherProcess((db) => {
      db.query(`INSERT INTO folders (id, name, parent_id, created_at, updated_at, pinned, sort_order)
        VALUES (?, 'added elsewhere', NULL, 1, 1, 0, 1)`).run(added);
      db.query("UPDATE conversations SET folder_id=NULL WHERE id=?").run(id);
      db.query("DELETE FROM folders WHERE id=?").run(folder!.id);
    });

    reloadStoreChanges([], []);

    expect(listFolders().some(entry => entry.id === added)).toBe(true);
    expect(listFolders().some(entry => entry.id === folder!.id)).toBe(false);
    expect(getSummary(id)?.folderId ?? null).toBeNull();
    deleteFolder(added);
  });
});
