import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state";
import {
  applyConversationScrollPositions,
  captureConversationScrollPositions,
  parseConversationScrollPositions,
} from "./persistence";

describe("conversation scroll persistence", () => {
  test("serializes stable normalized positions and restores them", () => {
    const state = createInitialState();
    state.conversationScroll.positions.set("z-last", 1);
    state.conversationScroll.positions.set("a-first", 0.25);

    const serialized = captureConversationScrollPositions(state);
    expect(serialized).toEqual({ "a-first": 0.25, "z-last": 1 });

    const restored = createInitialState();
    applyConversationScrollPositions(restored, serialized);
    expect([...restored.conversationScroll.positions]).toEqual([
      ["a-first", 0.25],
      ["z-last", 1],
    ]);
  });

  test("rejects malformed or out-of-range percentages", () => {
    expect(parseConversationScrollPositions({ valid: 0.5 })).toEqual({ valid: 0.5 });
    expect(parseConversationScrollPositions({ invalid: -0.1 })).toBeNull();
    expect(parseConversationScrollPositions({ invalid: 1.1 })).toBeNull();
    expect(parseConversationScrollPositions({ invalid: "0.5" })).toBeNull();
    expect(parseConversationScrollPositions(null)).toBeNull();
  });

  test("keeps prompt anchors and rejects malformed ones", () => {
    expect(parseConversationScrollPositions({ a: { userIndex: 5, rowOffset: -2 }, b: 1 }))
      .toEqual({ a: { userIndex: 5, rowOffset: -2 }, b: 1 });
    expect(parseConversationScrollPositions({ a: { userIndex: -1, rowOffset: 0 } })).toBeNull();
    expect(parseConversationScrollPositions({ a: { userIndex: 1.5, rowOffset: 0 } })).toBeNull();
    expect(parseConversationScrollPositions({ a: { userIndex: 1 } })).toBeNull();
  });
});
