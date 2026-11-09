import { describe, expect, test } from "bun:test";
import { getViewStart } from "../chatscroll";
import { handleEvent, type DaemonActions } from "../events";
import { beginOlderHistoryLoad, MAX_HISTORY_REQUEST_TURNS, OLDER_HISTORY_PAGE_TURNS, olderHistoryPageTurns, shouldLoadOlderHistory } from "../historypagination";
import type { Event } from "../protocol";
import { advanceDeferredHistoryRender, render } from "../render";
import { createInitialState, type RenderState } from "../state";
import { applyConversationScrollPositions, captureConversationScrollPositions } from "./persistence";
import { prepareConversationOpen } from "./position";

const daemon = new Proxy({}, { get: () => () => {} }) as DaemonActions;

const TURNS = 40;
type Entries = Extract<Event, { type: "conversation_loaded" }>["entries"];

function turnEntries(convId: string, from: number, to: number): Entries {
  const entries: Entries = [];
  for (let turn = from; turn < to; turn++) {
    entries.push({ type: "user", text: `${convId} prompt ${turn}` });
    const reply = Array.from({ length: 6 }, (_, line) => `${convId} reply ${turn} line ${line}`).join("\n");
    entries.push({ type: "ai", blocks: [{ type: "text", text: reply }], metadata: null });
  }
  return entries;
}

/** Render, then let the idle ticks lay out the rest of the loaded rows. */
function silently(state: RenderState): void {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    render(state);
    while (advanceDeferredHistoryRender(state)) render(state);
  } finally { process.stdout.write = write; }
}

/** A daemon window of whole turns [from, TURNS) and its pages, as main.ts drives them. */
function open(state: RenderState, convId: string, from: number): void {
  prepareConversationOpen(state, convId);
  handleEvent({
    type: "conversation_loaded",
    reqId: `open-${convId}-${from}`,
    convId,
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    entries: turnEntries(convId, from, TURNS),
    contextTokens: 100,
    toolOutputsIncluded: true,
    historyStartIndex: from * 2,
    historyStartUserIndex: from,
    historyTotalEntries: TURNS * 2,
    hasOlderHistory: from > 0,
  }, state, daemon);
  silently(state);
  // The opening backfill, then whatever pages the TUI still asks for.
  let turns: number | null = 10;
  while (turns !== null) {
    const request = beginOlderHistoryLoad(state, turns);
    if (!request) break;
    const end = request.beforeEntryIndex / 2;
    const start = Math.max(0, end - request.turns);
    state.historyLoadingRequestId = `page-${start}`;
    handleEvent({
      type: "conversation_history_loaded",
      reqId: `page-${start}`,
      convId,
      requestSource: "viewport",
      entries: turnEntries(convId, start, end),
      historyStartIndex: start * 2,
      historyStartUserIndex: start,
      historyEndIndex: end * 2,
      historyTotalEntries: TURNS * 2,
      hasOlderHistory: start > 0,
    }, state, daemon);
    silently(state);
    turns = shouldLoadOlderHistory(state) ? OLDER_HISTORY_PAGE_TURNS : null;
  }
}

function topRow(state: RenderState): string {
  return (state.historyLines[getViewStart(state)] ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();
}

function newState(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 30;
  return state;
}

/** Open the long conversation, read back through every older page, and stop in turn 5. */
function readDeepInto(state: RenderState): string {
  open(state, "long", 30);
  while (state.historyStartIndex > 0) {
    const request = beginOlderHistoryLoad(state, OLDER_HISTORY_PAGE_TURNS)!;
    const end = request.beforeEntryIndex / 2;
    const start = Math.max(0, end - request.turns);
    state.historyLoadingRequestId = `scroll-${start}`;
    handleEvent({
      type: "conversation_history_loaded",
      reqId: `scroll-${start}`,
      convId: "long",
      entries: turnEntries("long", start, end),
      historyStartIndex: start * 2,
      historyStartUserIndex: start,
      historyEndIndex: end * 2,
      historyTotalEntries: TURNS * 2,
      hasOlderHistory: start > 0,
    }, state, daemon);
    silently(state);
  }
  const row = state.historyLines.findIndex(line => line.includes("long reply 5 line 2"));
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - row;
  silently(state);
  const top = topRow(state);
  expect(top).toContain("long reply 5");
  return top;
}

describe("reopening a conversation scrolled into older pages", () => {
  test("switching away and back shows the row that was at the top", () => {
    const state = newState();
    const before = readDeepInto(state);

    open(state, "other", 30);
    expect(topRow(state)).toContain("other");
    // Coming back opens the usual window: the last turns plus a backfill.
    open(state, "long", 30);

    expect(topRow(state)).toBe(before);
  });

  test("quitting and starting again shows the row that was at the top", () => {
    const state = newState();
    const before = readDeepInto(state);
    const saved = JSON.parse(JSON.stringify(captureConversationScrollPositions(state)));

    const restarted = newState();
    applyConversationScrollPositions(restarted, saved);
    open(restarted, "long", 30);

    expect(topRow(restarted)).toBe(before);
  });

  test("asks for the turns between the window and the saved prompt in one page", () => {
    const state = newState();
    state.convId = "long";
    state.historyStartIndex = 400;
    state.historyStartUserIndex = 200;
    state.historyHasOlder = true;
    state.conversationScroll.pendingRestore = {
      convId: "long", mode: "anchor", anchor: { userIndex: 160, rowOffset: 3 }, waitForInitialBackfill: true,
    };
    expect(shouldLoadOlderHistory(state)).toBe(true);
    expect(olderHistoryPageTurns(state)).toBe(40);
    state.conversationScroll.pendingRestore.anchor = { userIndex: 2, rowOffset: 0 };
    expect(olderHistoryPageTurns(state)).toBe(MAX_HISTORY_REQUEST_TURNS);
    state.conversationScroll.pendingRestore.anchor = { userIndex: 199, rowOffset: 0 };
    expect(olderHistoryPageTurns(state)).toBe(OLDER_HISTORY_PAGE_TURNS);
  });

  test("leaving before a saved position is put back keeps it", () => {
    const state = newState();
    readDeepInto(state);
    open(state, "other", 30);
    const saved = state.conversationScroll.positions.get("long");
    expect(saved).toMatchObject({ userIndex: 5 });
    // Reopened, but left again before the older pages arrived.
    prepareConversationOpen(state, "long");
    handleEvent({
      type: "conversation_loaded", reqId: "open-again", convId: "long", provider: "openai", model: "gpt-5.5",
      effort: "high", fastMode: false, entries: turnEntries("long", 30, TURNS), contextTokens: 100,
      toolOutputsIncluded: true, historyStartIndex: 60, historyStartUserIndex: 30,
      historyTotalEntries: TURNS * 2, hasOlderHistory: true,
    }, state, daemon);
    silently(state);
    prepareConversationOpen(state, "other");
    expect(state.conversationScroll.positions.get("long")).toEqual(saved);
  });
});
