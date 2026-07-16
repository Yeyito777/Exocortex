import { describe, expect, mock, test } from "bun:test";
import { startManualCompaction } from "./compact";
import { createInitialState } from "./state";

describe("startManualCompaction", () => {
  test("marks the TUI busy before dispatching the daemon request", () => {
    const state = createInitialState();
    state.convId = "conv-compact";
    state.scrollOffset = 12;
    const compactConversation = mock(() => {});

    const started = startManualCompaction(state, { compactConversation }, 123_456);

    expect(started).toBe(true);
    expect(state.pendingAI).toMatchObject({
      role: "assistant",
      blocks: [],
      metadata: { startedAt: 123_456, endedAt: null },
    });
    expect(state.contextCompactionStartedAt).toBe(123_456);
    expect(state.scrollOffset).toBe(0);
    expect(compactConversation).toHaveBeenCalledWith("conv-compact", 123_456);
  });

  test("does not dispatch without a conversation or while already busy", () => {
    const state = createInitialState();
    const compactConversation = mock(() => {});
    expect(startManualCompaction(state, { compactConversation }, 1)).toBe(false);

    state.convId = "conv-compact";
    state.pendingAI = { role: "assistant", blocks: [], metadata: null };
    expect(startManualCompaction(state, { compactConversation }, 2)).toBe(false);
    expect(compactConversation).not.toHaveBeenCalled();
  });
});
