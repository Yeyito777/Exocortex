import { describe, expect, test } from "bun:test";
import { createInitialState } from "./state";
import {
  activeDurableSleepAssistant,
  activeDurableSleepMetadataStartedAt,
  durableSleepMetadataFrame,
  inlineSleepMetadataEndedAt,
} from "./durable-sleep-metadata";
import { createPendingAI } from "./messages";

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
  test("recovers metadata for suspended waits through the same task/tool-call linkage", () => {
    const { state, assistant } = sleepingState();
    const task = state.sidebar.conversations[0].tasks![0];
    task.id = "chrono:wait:sleep-call";
    task.chronoMode = "wait";
    expect(activeDurableSleepAssistant(state)).toBe(assistant);
    expect(durableSleepMetadataFrame(state, 6_999)).toBe(5);
    state.messages[0].metadata!.workTimerStartedAt = 1_000;
    expect(activeDurableSleepAssistant(state)).toBeNull();
  });

  test("does not count suspended idle time as work with the new timer", () => {
    const { state } = sleepingState();
    state.messages[0].metadata!.workTimerStartedAt = 1_000;
    expect(activeDurableSleepAssistant(state)).toBeNull();
    expect(durableSleepMetadataFrame(state, 600_000)).toBeNull();
  });
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

  test("stops a streaming turn's clock while it sleeps inside a long Chrono call", () => {
    const { state } = sleepingState(true);
    state.pendingAI = createPendingAI(1_000, state.model);
    expect(inlineSleepMetadataEndedAt(state)).toBe(2_000);

    state.sidebar.conversations[0].tasks![0].dueAt = 2_000 + 5 * 60_000;
    expect(inlineSleepMetadataEndedAt(state)).toBeNull();
    state.sidebar.conversations[0].tasks![0].dueAt = 602_000;
    state.sidebar.conversations[0].streaming = false;
    expect(inlineSleepMetadataEndedAt(state)).toBeNull();
  });

  test("requires the active sleep task to match the committed tool call", () => {
    const { state } = sleepingState();
    state.sidebar.conversations[0].tasks![0].id = "chrono:sleep:another-call";

    expect(activeDurableSleepAssistant(state)).toBeNull();
  });
});
