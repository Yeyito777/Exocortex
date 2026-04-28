import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "./events";
import type { ConversationSummary } from "./messages";
import { createInitialState } from "./state";

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title: "Existing chat",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    ...overrides,
  };
}

describe("conversation_updated", () => {
  test("ignores a null summary from a malformed daemon event", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.sidebar.conversations = [summary()];

    expect(() => {
      handleEvent({ type: "conversation_updated", summary: null } as never, state, daemon);
    }).not.toThrow();

    expect(state.sidebar.conversations).toEqual([summary()]);
  });
});
