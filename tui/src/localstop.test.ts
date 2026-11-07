import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildMessageLines, invalidateCommittedHistoryCache, type BuildMessageLinesResult } from "./conversation";
import { handleEvent, type DaemonActions } from "./events";
import { showStoppedLocally } from "./localstop";
import { createPendingAI, type ConversationSummary } from "./messages";
import type { Event } from "./protocol";
import { startReplayConversation } from "./replay";
import { createInitialState, type RenderState } from "./state";
import { stripAnsi } from "./historycursor";
import { saveTurnWorkPreference } from "./diagnostics";

// A stop the user asked for stays in view until their next message or a replay.

const MODEL = "gpt-6-astra";
const RUN = 1_000;

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

function summary(streaming: boolean): ConversationSummary {
  return {
    id: "c", provider: "openai", model: MODEL, effort: "high", fastMode: false, createdAt: 1, updatedAt: 1,
    messageCount: 1, title: "VM", marked: false, pinned: false, streaming,
  } as ConversationSummary;
}

function rows(state: RenderState): string[] {
  return buildMessageLines(state, 100, { reuseArrays: true }).lines.map(line => stripAnsi(line).trimEnd()).filter(Boolean);
}

function freshMatchesIncremental(state: RenderState): void {
  const comparable = ({ revision: _revision, ...rest }: BuildMessageLinesResult) => rest;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const incremental = comparable(buildMessageLines(state, 100, { reuseArrays: true }));
    invalidateCommittedHistoryCache(state);
    expect(incremental).toEqual(comparable(buildMessageLines(state, 100)));
  } finally {
    clock.mockRestore();
  }
}

/** A turn mid-tool-call, stopped with Ctrl+Q before the daemon answers. */
function stoppedTurn(): RenderState {
  const state = createInitialState();
  state.convId = "c";
  state.model = MODEL;
  state.sidebar.conversations = [summary(true)];
  state.messages.push({ role: "user", text: "check the VM", metadata: { startedAt: 500, endedAt: 500, model: MODEL, tokens: 0 } });
  state.pendingAI = createPendingAI(RUN, MODEL);
  state.pendingAI.blocks.push(
    { type: "text", text: "On it." },
    { type: "tool_call", toolCallId: "a", toolName: "bash", input: { command: "uptime" }, summary: "uptime" },
    { type: "tool_result", toolCallId: "a", toolName: "bash", output: "up 3 days", isError: false },
    { type: "tool_call", toolCallId: "b", toolName: "bash", input: { command: "df -h" }, summary: "df -h" },
  );
  rows(state);
  showStoppedLocally(state, "c", RUN);
  return state;
}

/** What the daemon sends after it stopped the turn (main.ts drops its copy of the notice). */
function daemonConfirms(state: RenderState): void {
  handleEvent({
    type: "streaming_stopped", convId: "c",
    persistedBlocks: [{ type: "text", text: "On it." }, { type: "tool_call", toolCallId: "a", toolName: "bash", input: { command: "uptime" }, summary: "uptime" }, { type: "tool_result", toolCallId: "a", toolName: "bash", output: "up 3 days", isError: false }],
  } as Event, state, daemon);
  handleEvent({ type: "conversation_updated", summary: summary(false) } as Event, state, daemon);
}

afterEach(() => saveTurnWorkPreference(false));

describe("a stop stays in view", () => {
  test("Ctrl+Q shows the notice at once, folded, under Ctrl+O and under Ctrl+I", () => {
    const state = stoppedTurn();
    expect(rows(state).at(-1)).toContain("✗ Interrupted");
    expect(state.streamingTailMessages).toEqual([]);
    freshMatchesIncremental(state);
    state.showTurnWork = true;
    expect(rows(state).at(-1)).toContain("✗ Interrupted");
    state.showTurnWork = false;
    state.showToolOutput = true;
    expect(rows(state).at(-1)).toContain("✗ Interrupted");
  });

  test("the daemon's stop keeps the same rows, and a reload shows it too", () => {
    const state = stoppedTurn();
    const optimistic = rows(state);
    daemonConfirms(state);
    expect(rows(state)).toEqual(optimistic);
    freshMatchesIncremental(state);

    handleEvent({
      type: "conversation_loaded", convId: "c", provider: "openai", model: MODEL, effort: "high", fastMode: false,
      entries: [
        { type: "user", text: "check the VM", metadata: { startedAt: 500, endedAt: 500, model: MODEL, tokens: 0 } },
        { type: "ai", blocks: [{ type: "text", text: "On it." }, { type: "tool_call", toolCallId: "a", toolName: "bash", input: { command: "uptime" }, summary: "uptime" }, { type: "tool_result", toolCallId: "a", toolName: "bash", output: "up 3 days", isError: false }], metadata: { startedAt: RUN, endedAt: RUN + 2_000, model: MODEL, tokens: 10 } },
        { type: "system", text: "✗ Interrupted", color: "error", metadata: null },
      ],
      contextTokens: 100, toolOutputsIncluded: false,
    } as unknown as Event, state, daemon);
    const reloaded = rows(state);
    expect(reloaded.at(-1)).toContain("✗ Interrupted");
    expect(reloaded.filter(row => row.includes("✗ Interrupted"))).toHaveLength(1);
    freshMatchesIncremental(state);
  });

  test("the next message folds it with its turn; Ctrl+O still shows it", () => {
    const state = stoppedTurn();
    daemonConfirms(state);
    expect(rows(state).at(-1)).toContain("✗ Interrupted");
    handleEvent({ type: "user_message", convId: "c", text: "try again", startedAt: 5_000, queueId: "m1" } as Event, state, daemon);
    expect(rows(state).some(row => row.includes("Interrupted"))).toBe(false);
    freshMatchesIncremental(state);
    state.showTurnWork = true;
    expect(rows(state).some(row => row.includes("✗ Interrupted"))).toBe(true);
  });

  test("a replay folds it into the resumed turn", () => {
    const state = stoppedTurn();
    daemonConfirms(state);
    expect(rows(state).at(-1)).toContain("✗ Interrupted");
    startReplayConversation(state, { replayConversation() {} }, 5_000);
    expect(rows(state).some(row => row.includes("Interrupted"))).toBe(false);
    freshMatchesIncremental(state);
  });

  test("a replay the daemon starts folds it too", () => {
    const state = stoppedTurn();
    daemonConfirms(state);
    rows(state);
    handleEvent({ type: "streaming_started", convId: "c", provider: "openai", model: MODEL, snapshotKind: "start", startedAt: 5_000 } as Event, state, daemon);
    expect(rows(state).some(row => row.includes("Interrupted"))).toBe(false);
  });

  test("a stop before anything streamed leaves the prompt and the notice", () => {
    const state = createInitialState();
    state.convId = "c";
    state.sidebar.conversations = [summary(true)];
    state.messages.push({ role: "user", text: "check the VM", metadata: { startedAt: 500, endedAt: 500, model: MODEL, tokens: 0 } });
    state.pendingAI = createPendingAI(RUN, MODEL);
    showStoppedLocally(state, "c", RUN);
    expect(state.pendingAI).toBeNull();
    const shown = rows(state);
    expect(shown.at(-1)).toContain("✗ Interrupted");
    expect(shown.at(-2)).toContain("check the VM");
  });
});
