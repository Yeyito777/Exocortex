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
});
