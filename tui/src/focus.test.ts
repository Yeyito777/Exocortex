import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { buildMessageLines } from "./conversation";
import { getViewStartFor } from "./chatscroll";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
import type { ConversationSummary, ProviderInfo } from "./messages";

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
        supportedEfforts: [{ effort: "high", description: "Deep" }],
        defaultEffort: "high",
        supportsImages: true,
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "Gpt-5.3-codex-spark",
        maxContext: 128_000,
        supportedEfforts: [{ effort: "medium", description: "Balanced" }],
        defaultEffort: "medium",
        supportsImages: false,
      },
    ],
  },
];

function conversation(id: string, sortOrder: number): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    messageCount: 0,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder,
  };
}

describe("image paste guard", () => {
  test("Ctrl+V reports an error instead of attaching an image for unsupported models", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.3-codex-spark";

    const result = handleFocusedKey({ type: "ctrl-v" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.pendingImages).toHaveLength(0);
    expect(state.messages.at(-1)).toMatchObject({
      role: "system",
      text: expect.stringContaining("Image inputs are not supported by openai/gpt-5.3-codex-spark"),
    });
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function buildToolToggleState(showToolOutput: boolean) {
  const state = createInitialState();
  state.cols = 80;
  state.layout.messageAreaHeight = 8;
  state.showToolOutput = showToolOutput;
  state.messages = [{
    role: "assistant",
    blocks: [
      { type: "text", text: "before" },
      { type: "tool_call", toolCallId: "1", toolName: "bash", input: {}, summary: "echo hi" },
      {
        type: "tool_result",
        toolCallId: "1",
        output: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
        isError: false,
      },
      {
        type: "text",
        text: Array.from({ length: 40 }, (_, i) => `after ${i + 1}`).join("\n"),
      },
    ],
    metadata: null,
  }] as any;
  state.toolRegistry = [{ name: "bash", label: "$", color: "#d19a66" }];
  return state;
}

function topVisibleLine(state: ReturnType<typeof createInitialState>): string {
  const rendered = buildMessageLines(state, state.cols).lines.map(stripAnsi);
  const viewStart = getViewStartFor(rendered.length, state.layout.messageAreaHeight, state.scrollOffset);
  return rendered[viewStart] ?? "";
}

describe("tool output toggle scroll preservation", () => {
  test("Ctrl+O preserves the top visible line when expanding hidden tool output", () => {
    const state = buildToolToggleState(false);
    state.scrollOffset = 5;
    state.historyCursor = { row: 29, col: 0 };
    state.historyVisualAnchor = { row: 29, col: 0 };

    expect(topVisibleLine(state)).toBe("  after 28");

    const result = handleFocusedKey({ type: "ctrl-o" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.showToolOutput).toBe(true);
    expect(topVisibleLine(state)).toBe("  after 28");

    const rendered = buildMessageLines(state, state.cols).lines.map(stripAnsi);
    expect(rendered[state.historyCursor.row]).toBe("  after 28");
    expect(rendered[state.historyVisualAnchor.row]).toBe("  after 28");
    expect(state.layout.totalLines).toBe(rendered.length);
  });

  test("Ctrl+O preserves the top visible line when collapsing visible tool output", () => {
    const state = buildToolToggleState(true);
    state.scrollOffset = 5;
    state.historyCursor = { row: 49, col: 0 };
    state.historyVisualAnchor = { row: 49, col: 0 };

    expect(topVisibleLine(state)).toBe("  after 28");

    const result = handleFocusedKey({ type: "ctrl-o" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.showToolOutput).toBe(false);
    expect(topVisibleLine(state)).toBe("  after 28");

    const rendered = buildMessageLines(state, state.cols).lines.map(stripAnsi);
    expect(rendered[state.historyCursor.row]).toBe("  after 28");
    expect(rendered[state.historyVisualAnchor.row]).toBe("  after 28");
    expect(state.layout.totalLines).toBe(rendered.length);
  });
});

describe("sidebar top shortcuts", () => {
  test("Ctrl+3 focuses and opens the third conversation from the top outside prompt typing", () => {
    const state = createInitialState();
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-1", 1),
      conversation("conv-2", 2),
      conversation("conv-3", 3),
      conversation("conv-4", 4),
    ];

    const result = handleFocusedKey({ type: "f16" }, state);

    expect(result).toEqual({ type: "load_conversation", convId: "conv-3" });
    expect(state.sidebar.open).toBe(true);
    expect(state.panelFocus).toBe("sidebar");
    expect(state.sidebar.selectedIndex).toBe(2);
    expect(state.sidebar.selectedId).toBe("conv-3");
    expect(state.sidebar.previousEnteredId).toBeNull();
  });

  test("Ctrl+- focuses the previously entered conversation, not the last hovered one", () => {
    const state = createInitialState();
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.convId = "conv-1";
    state.sidebar.previousEnteredId = "conv-2";
    state.sidebar.conversations = [
      conversation("conv-1", 1),
      conversation("conv-2", 2),
      conversation("conv-3", 3),
      conversation("conv-4", 4),
    ];

    expect(handleFocusedKey({ type: "f16" }, state)).toEqual({ type: "load_conversation", convId: "conv-3" });
    const result = handleFocusedKey({ type: "f24" }, state);

    expect(result).toEqual({ type: "load_conversation", convId: "conv-2" });
    expect(state.sidebar.selectedIndex).toBe(1);
    expect(state.sidebar.selectedId).toBe("conv-2");
    expect(state.sidebar.previousEnteredId).toBe("conv-2");
  });

  test("conversation_loaded remembers the previously entered chat", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.sidebar.conversations = [
      conversation("conv-1", 1),
      conversation("conv-2", 2),
    ];

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-2",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: null,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {} } as never);

    expect(state.convId).toBe("conv-2");
    expect(state.sidebar.previousEnteredId).toBe("conv-1");
  });

  test("Ctrl+1 and Ctrl+- still insert symbols while typing in the prompt", () => {
    const state = createInitialState();

    const first = handleFocusedKey({ type: "f14" }, state);
    const second = handleFocusedKey({ type: "f24" }, state);

    expect(first).toEqual({ type: "handled" });
    expect(second).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("←—");
    expect(state.cursorPos).toBe(2);
    expect(state.sidebar.open).toBe(false);
    expect(state.panelFocus).toBe("chat");
  });
});
