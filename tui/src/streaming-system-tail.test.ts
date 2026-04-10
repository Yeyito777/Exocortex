import { describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { buildMessageLines } from "./conversation";
import { handleEvent } from "./events";
import { createPendingAI, type ProviderInfo } from "./messages";
import { createInitialState } from "./state";

const providers: ProviderInfo[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.4",
    allowsCustomModels: true,
    supportsFastMode: true,
    models: [
      {
        id: "gpt-5.4",
        label: "Gpt-5.4",
        maxContext: 272_000,
        supportedEfforts: [{ effort: "medium", description: "Balanced" }],
        defaultEffort: "medium",
      },
    ],
  },
];

function plainLines(width = 80) {
  const state = createInitialState();
  state.convId = "conv-1";
  state.pendingAI = createPendingAI(Date.now(), "gpt-5.4");
  return {
    state,
    render: () => buildMessageLines(state, width).lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, "")),
  };
}

describe("streaming system-message tail", () => {
  test("inserts daemon system messages inline instead of buffering them in the live tail", () => {
    const { state, render } = plainLines();
    state.pendingAI!.blocks.push({ type: "text", text: "streaming reply" });

    handleEvent({ type: "system_message", convId: "conv-1", text: "tail notice", color: "warning" }, state, null as never);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "assistant" });
    expect(state.messages[1]).toMatchObject({ role: "system", text: "tail notice" });
    expect(state.streamingTailMessages).toHaveLength(0);

    const lines = render().join("\n");
    expect(lines.indexOf("streaming reply")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("tail notice")).toBeGreaterThan(lines.indexOf("streaming reply"));
  });

  test("keeps retry notices inline between the previous attempt and the continued stream", () => {
    const { state, render } = plainLines();
    state.pendingAI!.blocks.push(
      { type: "tool_call", toolCallId: "call-1", toolName: "edit", input: { file_path: "/tmp/demo" }, summary: "Edit /tmp/demo" },
      { type: "text", text: "partial attempt text" },
    );

    handleEvent({
      type: "stream_retry",
      convId: "conv-1",
      attempt: 1,
      maxAttempts: 3,
      errorMessage: "temporary issue",
      delaySec: 2,
    }, state, null as never);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "assistant" });
    expect(state.messages[1]).toMatchObject({ role: "system" });
    expect(state.streamingTailMessages).toHaveLength(0);

    state.pendingAI!.blocks.push({ type: "text", text: "after retry" });

    const lines = render().join("\n");
    expect(lines.indexOf("Edit /tmp/demo")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("retrying in 2s")).toBeGreaterThan(lines.indexOf("Edit /tmp/demo"));
    expect(lines.indexOf("after retry")).toBeGreaterThan(lines.indexOf("retrying in 2s"));
    expect(lines).not.toContain("partial attempt text");
  });

  test("buffers TUI slash-command notices during streaming so they render below the live assistant reply", () => {
    const { state, render } = plainLines();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.fastMode = true;
    state.pendingAI!.blocks.push({ type: "text", text: "assistant still streaming" });

    const result = tryCommand("/fast off", state);

    expect(result).toEqual({ type: "fast_mode_changed", enabled: false });
    expect(state.messages).toHaveLength(0);
    expect(state.streamingTailMessages).toHaveLength(1);
    expect(state.streamingTailMessages[0].text).toBe("Fast mode disabled.");

    const lines = render().join("\n");
    expect(lines.indexOf("assistant still streaming")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("Fast mode disabled.")).toBeGreaterThan(lines.indexOf("assistant still streaming"));
  });

  test("reconciles terminal stream errors at the inline assistant position on streaming_stopped", () => {
    const { state } = plainLines();
    state.pendingAI!.blocks.push({ type: "text", text: "partial reply" });
    state.pendingAI!.metadata!.tokens = 42;

    handleEvent({ type: "system_message", convId: "conv-1", text: "✗ Timed out (stale stream)", color: "error" }, state, null as never);

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({ role: "assistant" });
    expect(state.messages[1]).toMatchObject({ role: "system", text: "✗ Timed out (stale stream)" });
    expect(state.pendingAICommittedIndex).toBe(0);

    handleEvent({
      type: "streaming_stopped",
      convId: "conv-1",
      persistedBlocks: [{ type: "text", text: "sanitized reply" }],
    }, state, null as never);

    expect(state.pendingAI).toBeNull();
    expect(state.pendingAICommittedIndex).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "sanitized reply" }],
      metadata: expect.objectContaining({ tokens: 42 }),
    });
    expect(state.messages[1]).toMatchObject({ role: "system", text: "✗ Timed out (stale stream)" });
  });

  test("clears buffered notices when switching to a different conversation", () => {
    const { state, render } = plainLines();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.fastMode = true;
    state.pendingAI!.blocks.push({ type: "text", text: "streaming reply" });
    tryCommand("/fast off", state);

    expect(state.streamingTailMessages).toHaveLength(1);

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-2",
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      fastMode: false,
      entries: [],
      contextTokens: null,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {} });

    expect(state.convId).toBe("conv-2");
    expect(state.streamingTailMessages).toHaveLength(0);
    expect(render().join("\n")).not.toContain("Fast mode disabled.");
  });
});
