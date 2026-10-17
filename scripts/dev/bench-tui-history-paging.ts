// Read-only benchmark of scrolling up through a long conversation: older pages
// arrive through the real conversation_history_loaded handler while the view is
// scrolled up. Prints timings only, never transcript text.
//
//   EXOCORTEX_CONFIG_DIR=$(mktemp -d) bun scripts/dev/bench-tui-history-paging.ts DATABASE CONV_ID [--pages N]
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { createInitialState } from "../../tui/src/state";
import { render } from "../../tui/src/render";
import { handleEvent } from "../../tui/src/events";
import { OLDER_HISTORY_PAGE_TURNS } from "../../tui/src/historypagination";
import type { Event } from "../../tui/src/protocol";

const args = process.argv.slice(2);
const [path, convId] = args;
if (!path || !convId) throw new Error("Usage: bun scripts/dev/bench-tui-history-paging.ts DATABASE CONV_ID [--pages N]");
const maxPages = args.includes("--pages") ? Number(args[args.indexOf("--pages") + 1]) : Infinity;
const store = new SqliteConversationStore({ path, readonly: true });
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (() => true) as typeof process.stdout.write;
const out = (line: object) => realWrite(JSON.stringify(line) + "\n");
const daemon = new Proxy({}, { get: () => () => undefined }) as never;

const state = createInitialState();
state.cols = 180;
state.rows = 50;
state.sidebar.open = false;
state.convId = convId;
const first = store.loadDisplayPage(convId, 15)!;
handleEvent({
  type: "conversation_loaded", convId, provider: first.provider, model: first.model, effort: first.effort,
  fastMode: first.fastMode, entries: [...first.pinnedEntries, ...first.entries], historyStartIndex: first.startIndex,
  historyStartUserIndex: first.startUserIndex, historyTotalEntries: first.totalEntries, hasOlderHistory: first.hasOlder,
  contextTokens: first.contextTokens, toolOutputsIncluded: false,
} as Event, state, daemon);
state.conversationScroll.pendingRestore = null;
render(state);
state.scrollOffset = Math.max(1, state.layout.totalLines - state.layout.messageAreaHeight);

for (let page = 1; page <= maxPages && state.historyHasOlder; page++) {
  const reqId = `page-${page}`;
  state.historyLoadingOlder = true;
  state.historyLoadingStartedAt = Date.now() - page * 80;
  state.historyLoadingRequestId = reqId;
  let t = performance.now();
  render(state);
  const spinnerFrameMs = performance.now() - t;
  const older = store.loadDisplayPage(convId, OLDER_HISTORY_PAGE_TURNS, state.historyStartIndex)!;
  t = performance.now();
  handleEvent({
    type: "conversation_history_loaded", reqId, convId, entries: older.entries,
    historyStartIndex: older.startIndex, historyStartUserIndex: older.startUserIndex,
    historyEndIndex: state.historyStartIndex, historyTotalEntries: older.totalEntries, hasOlderHistory: older.hasOlder,
    ...(older.startBlockIndex > 0 ? { historyStartBlockIndex: older.startBlockIndex } : {}),
  } as Event, state, daemon);
  const applyMs = performance.now() - t;
  t = performance.now();
  render(state);
  const renderMs = performance.now() - t;
  if (page % 10 === 1 || !state.historyHasOlder) {
    out({ page, messages: state.messages.length, rows: state.layout.totalLines,
      spinnerFrameMs: +spinnerFrameMs.toFixed(1), applyMs: +applyMs.toFixed(1), renderMs: +renderMs.toFixed(1) });
  }
}
store.close();
