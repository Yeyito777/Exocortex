import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
import { turnRequestId } from "./request-ids";
import { stripAnsi } from "./historycursor";
import { startReplayConversation, type ReplayConversationActions } from "./replay";

function fakeDaemon(calls: Array<{ convId: string; startedAt: number }>): ReplayConversationActions {
  return {
    replayConversation(convId, startedAt) {
      calls.push({ convId, startedAt });
    },
  };
}

describe("startReplayConversation", () => {
  test("creates pending assistant metadata immediately before daemon events arrive", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.model = "gpt-5.4";
    const calls: Array<{ convId: string; startedAt: number }> = [];

    const ok = startReplayConversation(state, fakeDaemon(calls), 1234);

    expect(ok).toBe(true);
    expect(calls).toEqual([{ convId: "conv-replay", startedAt: 1234 }]);
    expect(state.pendingAI).toEqual({
      role: "assistant",
      blocks: [],
      metadata: { startedAt: 1234, endedAt: null, model: "gpt-5.4", tokens: 0 },
    });
    expect(state.pendingAIHydratedFromSnapshot).toBe(false);
    expect(state.pendingAICommittedIndex).toBeNull();
    expect(buildMessageLines(state, 120).lines.map(stripAnsi)).toEqual([expect.stringContaining("Working"), expect.stringContaining("Gpt-5.4 | 0.0 tokens/s |")]);
  });

  test("pins the replay placeholder to the bottom like a normal send", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.scrollOffset = 5;
    const calls: Array<{ convId: string; startedAt: number }> = [];

    startReplayConversation(state, fakeDaemon(calls), 1234);

    expect(state.scrollOffset).toBe(0);
  });

  test("shows replay metadata immediately even after a historical terminal notice", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.model = "gpt-5.4";
    state.messages.push({ role: "system", text: "✗ Interrupted", color: "error", metadata: null });
    const calls: Array<{ convId: string; startedAt: number }> = [];

    startReplayConversation(state, fakeDaemon(calls), 1234);

    const lines = buildMessageLines(state, 120).lines.map(stripAnsi);
    expect(lines.some(line => line.includes("✗ Interrupted"))).toBe(true);
    expect(lines.some(line => line.includes("Gpt-5.4 | 0.0 tokens/s |"))).toBe(true);
  });

  test("does not count idle time between an interrupted turn and its replay", () => {
    const minute = 60_000;
    const replayStartedAt = 21 * minute;
    const state = createInitialState();
    // Every footer in view (folded, the interrupted part and its notice fold into the live turn).
    state.showTurnWork = true;
    state.convId = "conv-replay";
    state.model = "gpt-5.4";
    state.messages.push(
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Partial answer" }],
        metadata: { startedAt: 0, endedAt: 11 * minute, model: "gpt-5.4", tokens: 500 },
      },
      { role: "system", text: "✗ Interrupted", color: "error", metadata: null },
    );
    const calls: Array<{ convId: string; startedAt: number }> = [];

    startReplayConversation(state, fakeDaemon(calls), replayStartedAt);
    state.pendingAI!.metadata!.endedAt = replayStartedAt + 1_000;

    const lines = buildMessageLines(state, 120).lines.map(stripAnsi);
    expect(lines).toContain("  Gpt-5.4 | — tokens/s | 11m 0s");
    expect(lines.at(-1)).toBe("  Gpt-5.4 | — tokens/s | 1s");
  });

  test("shows daemon-started replay metadata immediately after a historical terminal notice", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    state.model = "gpt-5.4";
    state.messages.push({ role: "system", text: "✗ Daemon restarted", color: "error", metadata: null });

    handleEvent({
      type: "streaming_started",
      convId: "conv-replay",
      provider: "openai",
      model: "gpt-5.4",
      snapshotKind: "start",
      startedAt: 1234,
    }, state, null as never);

    const lines = buildMessageLines(state, 120).lines.map(stripAnsi);
    expect(lines.some(line => line.includes("✗ Daemon restarted"))).toBe(true);
    expect(lines.some(line => line.includes("Gpt-5.4 | 0.0 tokens/s |"))).toBe(true);
  });

  test("does nothing without an active conversation", () => {
    const state = createInitialState();
    const calls: Array<{ convId: string; startedAt: number }> = [];

    const ok = startReplayConversation(state, fakeDaemon(calls), 1234);

    expect(ok).toBe(false);
    expect(calls).toEqual([]);
    expect(state.pendingAI).toBeNull();
  });

  test("clears the optimistic metadata-only assistant on daemon preflight errors", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    const calls: Array<{ convId: string; startedAt: number }> = [];
    startReplayConversation(state, fakeDaemon(calls), 1234);

    handleEvent({ type: "error", reqId: turnRequestId(1234, 1), convId: "conv-replay", message: "No conversation history to replay." }, state, null as never);

    expect(state.pendingAI).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ No conversation history to replay." });
  });

  test("keeps the live turn when an unrelated error names the conversation", () => {
    const state = createInitialState();
    state.convId = "conv-replay";
    startReplayConversation(state, fakeDaemon([]), 1234);

    // e.g. /instructions rejected mid-stream, or an older-history page failing.
    handleEvent({ type: "error", convId: "conv-replay", message: "Cannot rewrite conversation history while it is streaming." }, state, null as never);
    handleEvent({ type: "error", reqId: "history_3_99", convId: "conv-replay", message: "history failed" }, state, null as never);
    // A failure of an earlier send is not about this turn either.
    handleEvent({ type: "error", reqId: turnRequestId(1000, 1), convId: "conv-replay", message: "Already streaming" }, state, null as never);

    expect(state.pendingAI?.metadata?.startedAt).toBe(1234);
  });
});
