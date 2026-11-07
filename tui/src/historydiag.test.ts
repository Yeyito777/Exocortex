import { describe, expect, test } from "bun:test";
import { historyNavigationSnapshot, logHistoryNavigation } from "./historydiag";
import { createInitialState } from "./state";

describe("history navigation diagnostics", () => {
  test("a snapshot carries the window's cursors and what is drawn", () => {
    const state = createInitialState();
    state.convId = "conv";
    state.historyStartIndex = 4;
    state.historyHasOlder = true;
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 1_000;
    state.pendingHistoryNavigation = "history_gg";
    state.layout.historyViewportRows = [null, { lineIndex: 3, startCol: 0, displayPrefixWidth: 0, endCol: 10 }, { lineIndex: 9, startCol: 0, displayPrefixWidth: 0, endCol: 10 }];
    expect(historyNavigationSnapshot(state, 5_000)).toMatchObject({
      convId: "conv", startIndex: 4, hasOlder: true, loadingOlder: true, loadingAgeMs: 4_000,
      pendingNavigation: "history_gg", shownRows: [3, 9], provisional: null,
    });
  });

  test("each reason logs at most once a second", () => {
    const state = createInitialState();
    expect(logHistoryNavigation("test reason", state, {}, 10_000)).toBe(true);
    expect(logHistoryNavigation("test reason", state, {}, 10_500)).toBe(false);
    expect(logHistoryNavigation("other test reason", state, {}, 10_500)).toBe(true);
    expect(logHistoryNavigation("test reason", state, {}, 11_001)).toBe(true);
  });
});
