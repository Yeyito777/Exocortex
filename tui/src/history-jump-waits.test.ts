import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleEvent, type DaemonActions } from "./events";
import { advanceHistoryNavigation, applyHistoryAction, stripAnsi } from "./historycursor";
import { beginOlderHistoryLoad, LOST_OLDER_PAGE_MS } from "./historypagination";
import type { Event } from "./protocol";
import { createInitialState, type RenderState } from "./state";

// gg waits for older history while the window does not start at the first
// entry. Whatever happens to the pages it asked for (a cached reopen with a
// stale "has older", a page dropped because the window moved, a request lost,
// a reload), it must keep asking and land on the first entry.

const daemon: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};
type Entry = Extract<Event, { type: "conversation_history_loaded" }>["entries"][number];

/** The daemon's history: 40 entries, prompts and replies, the first prompt marked. */
const ENTRIES: Entry[] = Array.from({ length: 40 }, (_, index) => index % 2 === 0
  ? { type: "user", text: index === 0 ? "the very first prompt" : `prompt ${index}` }
  : { type: "ai", blocks: [{ type: "text", text: Array.from({ length: 6 }, (_, line) => `reply ${index} line ${line}`).join("\n") }], metadata: null });

function relayout(state: RenderState): void {
  const rendered = buildMessageLines(state, 80);
  state.historyLines = rendered.lines;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyCopyLines = rendered.copyLines;
  state.historyMessageBounds = rendered.messageBounds;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
}

/** A conversation opened at entry `start` (a cached copy's window), history focused, cursor at the bottom. */
function opened(start: number, hasOlder = start > 0): RenderState {
  const state = createInitialState();
  state.cols = 80;
  state.sidebar.open = false;
  state.layout.messageAreaHeight = 10;
  handleEvent({
    type: "conversation_loaded", convId: "conv", provider: state.provider, model: state.model, effort: state.effort,
    fastMode: state.fastMode, entries: ENTRIES.slice(start), historyStartIndex: start, historyStartUserIndex: start / 2,
    historyTotalEntries: ENTRIES.length, hasOlderHistory: hasOlder, toolOutputsIncluded: false,
  } as Event, state, daemon);
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  relayout(state);
  state.historyCursor = { row: state.historyLines.length - 1, col: 0 };
  return state;
}

interface Request { reqId: string; before: number }

/** The TUI's side of the wire: what main.ts sends for a waiting jump. */
function client(state: RenderState) {
  const sent: Request[] = [];
  let next = 0;
  const request = () => {
    const older = beginOlderHistoryLoad(state, 15);
    if (!older) return;
    const reqId = `older-${++next}`;
    state.historyLoadingRequestId = reqId;
    sent.push({ reqId, before: older.beforeEntryIndex });
  };
  return { sent, advance: (now = Date.now()) => advanceHistoryNavigation(state, request, now) };
}

/** The daemon's answer to a request: up to 15 entries before `before`, or a page cut short. */
function answer(state: RenderState, request: Request, override: Partial<Extract<Event, { type: "conversation_history_loaded" }>> = {}): void {
  const start = Math.max(0, request.before - 15);
  handleEvent({
    type: "conversation_history_loaded", convId: "conv", reqId: request.reqId, requestSource: "viewport",
    entries: ENTRIES.slice(start, request.before), historyStartIndex: start, historyStartUserIndex: start / 2,
    historyEndIndex: request.before, historyTotalEntries: ENTRIES.length, hasOlderHistory: start > 0, ...override,
  } as Event, state, daemon);
  relayout(state);
}

function gg(state: RenderState): void {
  applyHistoryAction("history_gg", state);
}

function expectAtFirstEntry(state: RenderState): void {
  expect(state.pendingHistoryNavigation).toBeNull();
  expect(state.historyCursor.row).toBe(0);
  expect(stripAnsi(state.historyLines[0]!)).toContain("the very first prompt");
}

/** Answer every request the jump makes until it lands; at most `limit` round trips. */
function serve(state: RenderState, wire: ReturnType<typeof client>, limit = 10): void {
  for (let round = 0; round < limit && state.pendingHistoryNavigation; round++) {
    wire.advance();
    const request = wire.sent.at(-1);
    if (!request || !state.historyLoadingOlder) continue;
    answer(state, request);
    wire.advance();
  }
}

describe("gg waiting on older history", () => {
  test("asks for the page before the window at once and lands on the first entry", () => {
    const state = opened(30);
    const wire = client(state);
    gg(state);
    expect(state.pendingHistoryNavigation).toBe("history_gg");
    serve(state, wire);
    expect(wire.sent.map(request => request.before)).toEqual([30, 15]);
    expectAtFirstEntry(state);
  });

  test("a window already at the first entry lands even if the copy still says there is older history", () => {
    const state = opened(0, true);
    const wire = client(state);
    gg(state);
    wire.advance();
    expect(wire.sent).toEqual([]);
    expectAtFirstEntry(state);
  });

  test("an empty older page means nothing older: the jump lands", () => {
    const state = opened(4);
    const wire = client(state);
    gg(state);
    wire.advance();
    answer(state, wire.sent[0]!, { entries: [], historyStartIndex: 4, hasOlderHistory: true });
    wire.advance();
    expect(wire.sent).toHaveLength(1);
    expect(state.historyLines.some(line => stripAnsi(line).includes("the very first prompt"))).toBe(false);
    expect(state.historyHasOlder).toBe(false);
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(state.historyCursor.row).toBe(0);
  });

  test("a page dropped because the window moved is asked for again from the new window", () => {
    const state = opened(30);
    const wire = client(state);
    gg(state);
    wire.advance();
    // A refresh moved the window before the answer came: it no longer fits.
    answer(state, wire.sent[0]!, { historyEndIndex: 29 });
    expect(state.pendingHistoryNavigation).toBe("history_gg");
    expect(state.historyLoadingOlder).toBe(false);
    serve(state, wire);
    expect(wire.sent.length).toBeGreaterThan(1);
    expectAtFirstEntry(state);
  });

  test("a request that is never answered is asked for again", () => {
    const state = opened(30);
    const wire = client(state);
    gg(state);
    const askedAt = Date.now();
    wire.advance(askedAt);
    expect(wire.advance(askedAt + LOST_OLDER_PAGE_MS - 1)).toBe("none");
    expect(wire.sent).toHaveLength(1);
    expect(wire.advance(askedAt + LOST_OLDER_PAGE_MS + 1)).toBe("resend");
    expect(wire.sent).toHaveLength(2);
    // The lost request's late answer no longer counts.
    answer(state, wire.sent[0]!);
    expect(state.historyStartIndex).toBe(30);
    serve(state, wire);
    expectAtFirstEntry(state);
  });

  test("a cached reopen: the open's answer reloads the window and the jump pages on from it", () => {
    // The copy's window starts at 20; gg is pressed before the answer lands.
    const state = opened(20);
    const wire = client(state);
    gg(state);
    wire.advance();
    expect(wire.sent.map(request => request.before)).toEqual([20]);
    // The answer replaces the copy (a newer window, starting at 30).
    handleEvent({
      type: "conversation_loaded", convId: "conv", provider: state.provider, model: state.model, effort: state.effort,
      fastMode: state.fastMode, entries: ENTRIES.slice(30), historyStartIndex: 30, historyStartUserIndex: 15,
      historyTotalEntries: ENTRIES.length, hasOlderHistory: true, toolOutputsIncluded: false,
    } as Event, state, daemon);
    relayout(state);
    expect(state.pendingHistoryNavigation).toBe("history_gg");
    // The copy's page arrives late and is not the request in flight any more.
    answer(state, wire.sent[0]!);
    serve(state, wire);
    expect(wire.sent.map(request => request.before)).toEqual([20, 30, 15]);
    expectAtFirstEntry(state);
  });

  test("an unconfirmed cached copy does not hold the jump back", () => {
    const state = opened(30);
    state.provisionalOpen = {
      convId: "conv", reqId: "open", current: false, paintedAt: Date.now(), loadedKey: "", live: null,
      backfillKey: null, cachedBackfillReqId: null, intent: null, scrollOffset: 0, confirmed: null,
    };
    const wire = client(state);
    gg(state);
    expect(wire.advance()).toBe("request");
    expect(wire.sent).toHaveLength(1);
  });
});
