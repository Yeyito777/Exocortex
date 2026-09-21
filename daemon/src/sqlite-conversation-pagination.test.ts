import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation } from "./messages";
import { SqliteConversationStore } from "./sqlite-conversation-store";

let root: string;
let store: SqliteConversationStore;
afterEach(() => {
  store?.close();
  if (process.platform === "win32") Bun.gc(true);
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "exocortex-page-seek-"));
  store = new SqliteConversationStore({ path: join(root, "store.sqlite3") });
  const conv = createConversation("page-seek", "openai", "gpt-5.6-sol");
  conv.messages.push({ role: "system_instructions", content: "Pinned instructions", metadata: null });
  for (let i = 0; i < 30; i++) {
    conv.messages.push(
      { role: "user", content: `Question ${i}`, metadata: null },
      { role: "assistant", content: `Answer ${i}: ` + "large historical payload ".repeat(1000), metadata: null },
    );
  }
  store.save(conv);
  return conv;
}

test("opening and backfilling seek the covering user index, not the payload-bearing history", () => {
  const conv = fixture();
  const queries = spyOn(store.db, "query");
  let sql: string[];
  try {
    const newest = store.loadDisplayPage(conv.id, 5)!;
    expect(newest.startUserIndex).toBe(25);
    const older = store.loadDisplayPage(conv.id, 10, newest.startIndex)!;
    expect(older.startUserIndex).toBe(15);
    expect(older.endIndex).toBe(newest.startIndex);
    sql = queries.mock.calls.map(call => call[0]);
  } finally {
    queries.mockRestore();
  }
  expect(sql!.some(query => /COUNT\(\*\).*FROM display_entries/is.test(query))).toBe(false);
  const boundaryQueries = sql!.filter(query => /SELECT user_index FROM display_entries/.test(query));
  expect(boundaryQueries).toHaveLength(2);
  for (const query of boundaryQueries) {
    const plan = store.db.query<{ detail: string }, [string, number]>("EXPLAIN QUERY PLAN " + query)
      .all(conv.id, 50).map(row => row.detail).join("\n");
    expect(plan).toContain("COVERING INDEX display_user_page_idx");
    expect(plan).not.toContain("USE TEMP B-TREE");
  }
});

test("indexed user ordinals preserve page boundaries at every cursor after append and truncation", () => {
  const conv = fixture();
  const check = () => {
    const rows = store.db.query<{ entry_index: number; type: string }, [string]>(`
      SELECT entry_index, type FROM display_entries
      WHERE conversation_id=? AND pinned=0 ORDER BY entry_index
    `).all(conv.id);
    for (const cursor of [undefined, -1, ...Array.from({ length: rows.length + 2 }, (_, i) => i)]) {
      const end = Math.max(0, Math.min(cursor ?? rows.length, rows.length));
      const users = rows.filter(row => row.type === "user" && row.entry_index < end);
      for (const turns of [1, 5, 10, 100]) {
        const startUser = Math.max(0, users.length - turns);
        const start = users.length ? users[startUser]!.entry_index : 0;
        const page = store.loadDisplayPage(conv.id, turns, cursor)!;
        expect([page.startIndex, page.startUserIndex, page.endIndex, page.totalEntries, page.hasOlder])
          .toEqual([start, startUser, end, rows.length, start > 0]);
        expect(page.entries).toHaveLength(end - start);
        expect(page.pinnedEntries).toEqual([{ type: "system_instructions", text: "Pinned instructions" }]);
      }
    }
  };
  check();
  conv.messages.push({ role: "user", content: "Appended turn still streaming", metadata: null });
  store.save(conv);
  check();
  conv.messages.splice(11);
  store.save(conv);
  check();
});

test("empty and assistant-only conversations have no user ordinal", () => {
  const conv = fixture();
  conv.messages = [];
  store.save(conv);
  expect(store.loadDisplayPage(conv.id, 5)).toMatchObject({
    entries: [], startIndex: 0, startUserIndex: 0, endIndex: 0, hasOlder: false,
  });
  conv.messages.push({ role: "assistant", content: "No user turn", metadata: null });
  store.save(conv);
  expect(store.loadDisplayPage(conv.id, 5)).toMatchObject({
    startIndex: 0, startUserIndex: 0, endIndex: 1, hasOlder: false,
  });
  expect(store.loadDisplayPage(conv.id, 5)!.entries).toHaveLength(1);
  expect(store.loadDisplayPage("missing", 5)).toBeNull();
});
