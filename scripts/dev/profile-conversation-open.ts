// Read-only profiling against an explicitly supplied conversation database.
// Prints timings and sizes, never transcript text.
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { createInitialState } from "../../tui/src/state";
import { pushDisplayEntries } from "../../tui/src/events/display";
import { render, invalidateHistoryRenderCache } from "../../tui/src/render";
import { createPendingAI } from "../../tui/src/messages";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/dev/profile-conversation-open.ts DATABASE [--full]");
// --full simulates the non-deferred streaming/history-focused render path.
const full = process.argv.includes("--full");
const store = new SqliteConversationStore({ path, readonly: true });
const ids = store.db.query<{ id: string }, []>(
  "SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 12",
).all();
const stdout = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
try {
  for (const { id } of ids) {
    const t = performance.now();
    const loadCpuStart = process.cpuUsage();
    const page = store.loadDisplayPage(id, 5)!;
    const loadMs = performance.now() - t;
    const loadCpu = process.cpuUsage(loadCpuStart);
    const state = createInitialState();
    state.cols = 160;
    state.rows = 50;
    state.convId = id;
    pushDisplayEntries(state, [...page.pinnedEntries, ...page.entries]);
    if (full) state.pendingAI = createPendingAI();
    let start = performance.now();
    let cpuStart = process.cpuUsage();
    render(state);
    const coldRenderMs = performance.now() - start;
    const coldCpu = process.cpuUsage(cpuStart);
    invalidateHistoryRenderCache(state);
    start = performance.now();
    render(state);
    const warmRenderMs = performance.now() - start;
    // Reopening reconstructs objects from JSON; a second render of the same
    // objects alone hides the cache misses experienced when switching chats.
    state.messages = [];
    state.deferredHistoryRender = null;
    state.conversationScroll.pendingRestore = {
      convId: id, mode: "percentage", percentage: 1, waitForInitialBackfill: false,
    };
    pushDisplayEntries(state, JSON.parse(JSON.stringify([...page.pinnedEntries, ...page.entries])));
    invalidateHistoryRenderCache(state);
    start = performance.now();
    cpuStart = process.cpuUsage();
    render(state);
    const reopenRenderMs = performance.now() - start;
    const reopenCpu = process.cpuUsage(cpuStart);
    stdout(JSON.stringify({ id, entries: page.entries.length, bytes: JSON.stringify(page).length,
      full, loadMs, loadCpuMs: (loadCpu.user + loadCpu.system) / 1000,
      coldRenderMs, coldRenderCpuMs: (coldCpu.user + coldCpu.system) / 1000,
      warmRenderMs, reopenRenderMs, reopenRenderCpuMs: (reopenCpu.user + reopenCpu.system) / 1000 }) + "\n");
  }
} finally {
  process.stdout.write = stdout;
  store.close();
}
