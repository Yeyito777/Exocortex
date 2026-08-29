import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import {
  activeDurableSleepAssistant,
  activeDurableSleepMetadataStartedAt,
  durableSleepMetadataFrame,
} from "./durable-sleep-metadata";

function sleepingState(streaming = false) {
  const state = createInitialState();
  state.convId = "conv-sleep";
  state.sidebar.conversations = [{
    id: state.convId,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    title: "Durable sleep",
    marked: false,
    pinned: false,
    streaming,
    unread: false,
    sortOrder: 0,
    tasks: [{
      id: "chrono:sleep:sleep-call",
      kind: "chrono",
      title: "Sleeping",
      startedAt: 2_000,
      dueAt: 602_000,
      chronoMode: "sleep",
    }],
  }];
  const assistant = {
    role: "assistant" as const,
    blocks: [{
      type: "tool_call" as const,
      toolCallId: "sleep-call",
      toolName: "chrono",
      input: { action: "sleep", duration: "10m" },
      summary: "sleep: 10m",
    }],
    metadata: {
      startedAt: 1_000,
      endedAt: 2_100,
      model: state.model,
      tokens: 12,
    },
  };
  state.messages.push(assistant);
  return { state, assistant };
}

describe("durable Chrono sleep metadata", () => {
  test("recovers the live assistant clock from the durable task and tool-call ids", () => {
    const { state, assistant } = sleepingState();

    expect(activeDurableSleepAssistant(state)).toBe(assistant);
    expect(activeDurableSleepMetadataStartedAt(state)).toBe(1_000);
    expect(durableSleepMetadataFrame(state, 6_999)).toBe(5);
  });

  test("does not treat an ordinary connected Chrono sleep as suspended", () => {
    const { state } = sleepingState(true);

    expect(activeDurableSleepAssistant(state)).toBeNull();
    expect(durableSleepMetadataFrame(state, 6_999)).toBeNull();
  });

  test("requires the active sleep task to match the committed tool call", () => {
    const { state } = sleepingState();
    state.sidebar.conversations[0].tasks![0].id = "chrono:sleep:another-call";

    expect(activeDurableSleepAssistant(state)).toBeNull();
  });
});
