import { describe, expect, test } from "bun:test";
import { tryCommand } from "./commands";
import { buildMessageLines } from "./conversation";
import { handleEvent } from "./events";
import { createPendingAI, type ProviderInfo } from "./messages";
import { createInitialState } from "./state";
import { theme } from "./theme";

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
    expect(state.messages[1]).toMatchObject({ role: "system", text: "tail notice", color: theme.warning });
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

  test("hydrates the live assistant snapshot from conversation_loaded", () => {
    const state = createInitialState();
    state.convId = "conv-1";

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      fastMode: false,
      entries: [{ type: "user", text: "hello" }],
      pendingAI: {
        blocks: [{ type: "text", text: "partial final reply" }],
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 7 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.messages).toEqual([{ role: "user", text: "hello", metadata: null }]);
    expect(state.pendingAI).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "partial final reply" }],
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 7 },
    });
  });

  test("streaming_started refreshes a previously loaded live snapshot with the latest blocks", () => {
    const state = createInitialState();
    state.convId = "conv-1";

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      fastMode: false,
      entries: [],
      pendingAI: {
        blocks: [{ type: "text", text: "older snapshot" }],
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 3 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    handleEvent({
      type: "streaming_started",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      startedAt: 1,
      blocks: [{ type: "text", text: "newer snapshot" }],
      tokens: 5,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.pendingAI).toMatchObject({
      blocks: [{ type: "text", text: "newer snapshot" }],
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 5 },
    });
  });

  test("same-conversation reload keeps only the newer local live tail instead of duplicating completed rounds", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "user", text: "hello", metadata: null });
    state.pendingAI = createPendingAI(1, "gpt-5.4");
    state.pendingAI.blocks.push(
      { type: "text", text: "planning" },
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "pwd" }, summary: "pwd" },
      { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
      { type: "text", text: "newer live tail" },
    );
    state.pendingAI.metadata!.tokens = 10;

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      fastMode: false,
      entries: [
        { type: "user", text: "hello" },
        {
          type: "ai",
          blocks: [
            { type: "text", text: "planning" },
            { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "pwd", timeout: 10000 }, summary: "$ pwd" },
            { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
          ],
          metadata: null,
        },
      ],
      pendingAI: {
        blocks: [{ type: "text", text: "older snapshot" }],
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 5 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    handleEvent({
      type: "streaming_started",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      startedAt: 1,
      blocks: [{ type: "text", text: "older snapshot" }],
      tokens: 5,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    handleEvent({ type: "text_chunk", convId: "conv-1", text: " + more" }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.messages).toMatchObject([
      { role: "user", text: "hello" },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "planning" },
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "pwd", timeout: 10000 }, summary: "$ pwd" },
          { type: "tool_result", toolCallId: "call-1", output: "", isError: false },
        ],
      },
    ]);
    expect(state.pendingAI).toMatchObject({
      blocks: [{ type: "text", text: "newer live tail + more" }],
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 10 },
    });
  });

  test("repeated same-conversation reloads stay stable instead of re-duplicating tool rounds", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "user", text: "hello", metadata: null });
    state.pendingAI = createPendingAI(1, "gpt-5.4");
    state.pendingAI.blocks.push(
      { type: "thinking", text: "Thinking..." },
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "pwd && date", timeout: 10000 }, summary: "$ pwd && date" },
      { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
      { type: "text", text: "long story once upon" },
    );

    const daemonLoad = {
      type: "conversation_loaded" as const,
      convId: "conv-1",
      provider: "openai" as const,
      model: "gpt-5.4" as const,
      effort: "medium" as const,
      fastMode: false,
      entries: [
        { type: "user" as const, text: "hello" },
        {
          type: "ai" as const,
          blocks: [
            { type: "thinking" as const, text: "Thinking..." },
            { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: { command: "pwd && date" }, summary: "$ pwd && date" },
            { type: "tool_result" as const, toolCallId: "call-1", toolName: "", output: "", isError: false },
          ],
          metadata: null,
        },
      ],
      pendingAI: {
        blocks: [{ type: "text" as const, text: "long story" }],
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4" as const, tokens: 1 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    };
    const daemonCatchup = {
      type: "streaming_started" as const,
      convId: "conv-1",
      provider: "openai" as const,
      model: "gpt-5.4" as const,
      startedAt: 1,
      blocks: [{ type: "text" as const, text: "long story" }],
      tokens: 1,
    };
    const daemon = { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };

    handleEvent(daemonLoad, state, daemon);
    handleEvent(daemonCatchup, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: " a time" }, state, daemon);

    handleEvent(daemonLoad, state, daemon);
    handleEvent(daemonCatchup, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: " in a land" }, state, daemon);

    expect(state.messages).toMatchObject([
      { role: "user", text: "hello" },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Thinking..." },
          { type: "tool_call", toolCallId: "call-1" },
          { type: "tool_result", toolCallId: "call-1", isError: false },
        ],
      },
    ]);
    expect(state.pendingAI).toMatchObject({
      blocks: [{ type: "text", text: "long story once upon a time in a land" }],
    });
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
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.convId).toBe("conv-2");
    expect(state.streamingTailMessages).toHaveLength(0);
    expect(render().join("\n")).not.toContain("Fast mode disabled.");
  });
});
