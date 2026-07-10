import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { beginOlderHistoryLoad, shouldLoadOlderHistory } from "./historypagination";

describe("conversation history pagination", () => {
  test("starts one request at the current absolute cursor", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.historyStartIndex = 40;
    state.historyHasOlder = true;

    expect(beginOlderHistoryLoad(state, 10)).toEqual({
      convId: "conv-1",
      beforeEntryIndex: 40,
      turns: 10,
    });
    expect(state.historyLoadingOlder).toBe(true);
    expect(beginOlderHistoryLoad(state, 10)).toBeNull();
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
});
