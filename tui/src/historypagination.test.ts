import { describe, expect, test } from "bun:test";
import { createInitialState, type RenderState } from "./state";
import {
  beginOlderHistoryLoad,
  beginOpeningFillHold,
  MAX_HISTORY_REQUEST_TURNS,
  OPENING_FILL_HOLD_MS,
  openingHistoryTurns,
  shouldHoldOpeningFrame,
  shouldLoadOlderHistory,
} from "./historypagination";
import { handleEvent, type DaemonActions } from "./events";
import { render } from "./render";
import type { DisplayEntry, Event } from "./protocol";

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

/** Render without writing to the test runner's terminal; returns whether a frame was presented. */
function renderQuietly(state: RenderState): boolean {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return render(state);
  } finally {
    process.stdout.write = write;
  }
}

/** The shortest ordinary turns: a one-line prompt and a one-line reply. */
function shortTurns(count: number, withMetadata: boolean): DisplayEntry[] {
  return Array.from({ length: count }, (_, index): DisplayEntry[] => [
    { type: "user", text: `q${index}` },
    {
      type: "ai",
      blocks: [{ type: "text", text: `a${index}` }],
      metadata: withMetadata ? { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 3 } : null,
    },
  ]).flat();
}

function openedWindow(rows: number, entries: DisplayEntry[], hasOlderHistory = true): RenderState {
  const state = createInitialState();
  state.convId = "conv-1";
  state.rows = rows;
  state.cols = 200;
  const event: Extract<Event, { type: "conversation_loaded" }> = {
    type: "conversation_loaded",
    convId: "conv-1",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    entries,
    historyStartIndex: hasOlderHistory ? 400 : 0,
    historyStartUserIndex: hasOlderHistory ? 200 : 0,
    historyTotalEntries: 400 + entries.length,
    hasOlderHistory,
    contextTokens: 100,
    toolOutputsIncluded: false,
  };
  handleEvent(event, state, daemon);
  return state;
}

describe("conversation history pagination", () => {
  test("starts one request at the current absolute cursor", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 40;
    state.historyHasOlder = true;

    expect(beginOlderHistoryLoad(state, 10)).toEqual({
      convId: "conv-1",
      beforeEntryIndex: 40,
      beforeBlockIndex: 0,
      turns: 10,
    });
    expect(state.historyLoadingOlder).toBe(true);
    expect(beginOlderHistoryLoad(state, 10)).toBeNull();
  });

  test("continues from a block cursor inside the first loaded entry", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 0;
    state.historyStartBlockIndex = 12;
    state.historyHasOlder = true;

    expect(beginOlderHistoryLoad(state, 15)).toEqual({
      convId: "conv-1",
      beforeEntryIndex: 0,
      beforeBlockIndex: 12,
      turns: 15,
    });
  });

  test("requests on demand when scrolling within half a viewport of the top", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 20;
    state.historyHasOlder = true;
    state.layout = { ...state.layout, totalLines: 100, messageAreaHeight: 20 };

    state.scrollOffset = 69; // viewStart = 11
    expect(shouldLoadOlderHistory(state)).toBe(false);
    state.scrollOffset = 70; // viewStart = 10
    expect(shouldLoadOlderHistory(state)).toBe(true);
  });

  test("sizes the opening request to the terminal height within the daemon's limit", () => {
    expect(openingHistoryTurns(24)).toBe(10);
    expect(openingHistoryTurns(51)).toBe(15);
    expect(openingHistoryTurns(86)).toBe(25);
    expect(openingHistoryTurns(150)).toBe(40);
    // Older daemons reject more than 100 turns; never ask for fewer than 5.
    expect(openingHistoryTurns(2_000)).toBe(MAX_HISTORY_REQUEST_TURNS);
    expect(openingHistoryTurns(0)).toBe(5);
    expect(openingHistoryTurns(Number.NaN)).toBe(10);
    // Coarse buckets keep the SSH history-cache key stable across small resizes.
    expect(openingHistoryTurns(77)).toBe(openingHistoryTurns(80));
  });

  for (const rows of [40, 86, 150]) {
    for (const withMetadata of [true, false]) {
      test(`one opening response of the shortest turns fills a ${rows}-row screen${withMetadata ? "" : " (no metadata)"}`, () => {
        const state = openedWindow(rows, shortTurns(openingHistoryTurns(rows), withMetadata));
        beginOpeningFillHold(state);

        // The first paint is presented immediately and is already full: later
        // pages only extend scrollback above the viewport.
        expect(renderQuietly(state)).toBe(true);
        expect(state.layout.totalLines).toBeGreaterThanOrEqual(state.layout.messageAreaHeight);
        expect(state.historyOpeningFillUntil).toBeNull();
      });
    }
  }

  test("holds the first paint of a short opening window until older history fills it", () => {
    const state = openedWindow(86, shortTurns(2, true));
    const openedAt = Date.now();
    beginOpeningFillHold(state, openedAt);
    expect(state.historyOpeningFillUntil).toBe(openedAt + OPENING_FILL_HOLD_MS);

    // Painting now would show a partial, top-anchored screen that the
    // backfill would push down, so the opening spinner stays up instead.
    expect(renderQuietly(state)).toBe(false);
    expect(state.layout.totalLines).toBeLessThan(state.layout.messageAreaHeight);
    expect(shouldLoadOlderHistory(state)).toBe(true);

    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = "history-1";
    handleEvent({
      type: "conversation_history_loaded",
      reqId: "history-1",
      convId: "conv-1",
      requestSource: "initial-backfill",
      entries: shortTurns(40, true),
      historyStartIndex: 320,
      historyStartUserIndex: 160,
      historyEndIndex: 400,
      historyTotalEntries: 404,
      hasOlderHistory: true,
    }, state, daemon);

    expect(renderQuietly(state)).toBe(true);
    expect(state.layout.totalLines).toBeGreaterThanOrEqual(state.layout.messageAreaHeight);
    expect(state.historyOpeningFillUntil).toBeNull();
  });

  test("paints a short opening window once the hold cap expires", () => {
    const state = openedWindow(86, shortTurns(2, true));
    beginOpeningFillHold(state, Date.now() - OPENING_FILL_HOLD_MS);

    expect(renderQuietly(state)).toBe(true);
    expect(state.historyOpeningFillUntil).toBeNull();
  });

  test("never holds a conversation whose whole history is on screen", () => {
    const state = openedWindow(86, shortTurns(2, true), false);
    beginOpeningFillHold(state);

    expect(renderQuietly(state)).toBe(true);
    expect(state.historyOpeningFillUntil).toBeNull();
  });

  test("only an opening window is ever held", () => {
    const state = openedWindow(86, shortTurns(2, true));
    expect(state.historyOpeningFillUntil).toBeNull();
    expect(shouldHoldOpeningFrame(state)).toBe(false);
    expect(renderQuietly(state)).toBe(true);
  });
});
