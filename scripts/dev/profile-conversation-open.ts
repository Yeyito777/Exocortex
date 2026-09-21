// Read-only profiling against an explicitly supplied conversation database.
// Prints timings and sizes, never transcript text.
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { createInitialState } from "../../tui/src/state";
import { pushDisplayEntries } from "../../tui/src/events/display";
import { render, invalidateHistoryRenderCache } from "../../tui/src/render";
import { createPendingAI } from "../../tui/src/messages";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/dev/profile-conversation-open.ts DATABASE");
const store = new SqliteConversationStore({ path, readonly: true });
const ids = store.db.query<{ id: string }, []>(
  "SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12",
).all();
const stdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
try {
  for (const { id } of ids) {
    const t = performance.now();
    const page = store.loadDisplayPage(id, 5)!;
    const loadMs = performance.now() - t;
    const state = createInitialState();
    state.cols = 160;
    state.rows = 50;
    state.convId = id;
    pushDisplayEntries(state, [...page.pinnedEntries, ...page.entries]);
    state.pendingAI = createPendingAI();
    let start = performance.now();
    render(state);
    const coldRenderMs = performance.now() - start;
    invalidateHistoryRenderCache(state);
    start = performance.now();
    render(state);
    stdout(JSON.stringify({ id, entries: page.entries.length, bytes: JSON.stringify(page).length,
      loadMs, coldRenderMs, warmRenderMs: performance.now() - start }) + "\n");
  }
} finally {
  process.stdout.write = stdout;
  store.close();
}
