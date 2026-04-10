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
  test("renders buffered system messages after the live assistant message", () => {
    const { state, render } = plainLines();
    state.pendingAI!.blocks.push({ type: "text", text: "streaming reply" });

    handleEvent({ type: "system_message", convId: "conv-1", text: "tail notice", color: "warning" }, state, null as never);

    expect(state.messages).toHaveLength(0);
    expect(state.systemMessageBuffer).toHaveLength(1);

    const lines = render().join("\n");
    expect(lines.indexOf("streaming reply")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("tail notice")).toBeGreaterThan(lines.indexOf("streaming reply"));
  });

  test("keeps retry notices in the live tail instead of inserting them above the continued stream", () => {
    const { state, render } = plainLines();
    state.pendingAI!.blocks.push({ type: "text", text: "before retry" });

    handleEvent({
      type: "stream_retry",
      convId: "conv-1",
      attempt: 1,
      maxAttempts: 3,
      errorMessage: "temporary issue",
      delaySec: 2,
    }, state, null as never);

    expect(state.messages).toHaveLength(0);
    expect(state.systemMessageBuffer).toHaveLength(1);
    expect(state.messages.find(msg => msg.role === "system")).toBeUndefined();

    state.pendingAI!.blocks.push({ type: "text", text: "after retry" });

    const lines = render().join("\n");
    expect(lines.indexOf("after retry")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("retrying in 2s")).toBeGreaterThan(lines.indexOf("after retry"));
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
    expect(state.systemMessageBuffer).toHaveLength(1);
    expect(state.systemMessageBuffer[0].text).toBe("Fast mode disabled.");

    const lines = render().join("\n");
    expect(lines.indexOf("assistant still streaming")).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("Fast mode disabled.")).toBeGreaterThan(lines.indexOf("assistant still streaming"));
  });

  test("clears buffered notices when switching to a different conversation", () => {
    const { state, render } = plainLines();
    state.pendingAI!.blocks.push({ type: "text", text: "streaming reply" });
    handleEvent({ type: "system_message", convId: "conv-1", text: "old tail notice", color: "warning" }, state, null as never);

    expect(state.systemMessageBuffer).toHaveLength(1);

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
    expect(state.systemMessageBuffer).toHaveLength(0);
    expect(render().join("\n")).not.toContain("old tail notice");
  });
});
