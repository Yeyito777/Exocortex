import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
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
    expect(stripAnsi(buildMessageLines(state, 120).lines[0])).toContain("Gpt-5.4 | 0 tokens |");
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
    expect(lines.some(line => line.includes("Gpt-5.4 | 0 tokens |"))).toBe(true);
  });

  test("does not count idle time between an interrupted turn and its replay", () => {
    const minute = 60_000;
    const replayStartedAt = 21 * minute;
    const state = createInitialState();
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
    expect(lines).toContain("  Gpt-5.4 | 500 tokens | 11m 0s");
    expect(lines.at(-1)).toBe("  Gpt-5.4 | 0 tokens | 1s");
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
    expect(lines.some(line => line.includes("Gpt-5.4 | 0 tokens |"))).toBe(true);
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

    handleEvent({ type: "error", convId: "conv-replay", message: "No conversation history to replay." }, state, null as never);

    expect(state.pendingAI).toBeNull();
    expect(state.messages.at(-1)).toMatchObject({ role: "system", text: "✗ No conversation history to replay." });
  });
});
