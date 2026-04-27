import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { buildMessageLines } from "./conversation";
import { getViewStartFor } from "./chatscroll";
import { handleEvent } from "./events";
import { buildDisplayRows } from "./sidebar";
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

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
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
    ...overrides,
  };
}

function renderHistoryForTest(state: ReturnType<typeof createInitialState>, cols = 120): void {
  const rendered = buildMessageLines(state, cols);
  state.historyLines = rendered.lines;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyMessageBounds = rendered.messageBounds;
}

function placeHistoryCursorOnText(state: ReturnType<typeof createInitialState>, text: string): void {
  const row = state.historyLines.findIndex((line) => stripAnsi(line).includes(text));
  expect(row).toBeGreaterThanOrEqual(0);
  state.historyCursor = { row, col: stripAnsi(state.historyLines[row]).indexOf(text) };
}

describe("openable file path activation", () => {
  test("Enter on a generated image path requests detached open", () => {
    const path = "/home/yeyito/Workspace/Exocortex/.worktrees/image-generation-tool/config/data/instances/image-generation-tool/generated-images/example.png";
    const state = createInitialState();
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.showToolOutput = true;
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "tool_result", toolCallId: "1", toolName: "generate_image", output: path, isError: false }],
      metadata: null,
    }];

    renderHistoryForTest(state);
    placeHistoryCursorOnText(state, "/home/yeyito");

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "open_target", target: path });
  });

  test("Enter on a generic openable filepath in assistant text requests detached open", () => {
    const path = "/tmp/reference-dragon.png";
    const state = createInitialState();
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "text", text: `The image file is: ${path}` }],
      metadata: null,
    }];

    renderHistoryForTest(state);
    placeHistoryCursorOnText(state, path);

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "open_target", target: path });
  });

  test("Enter on a link in assistant text requests detached open", () => {
    const url = "https://example.com/reference";
    const state = createInitialState();
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "text", text: `Reference: ${url}` }],
      metadata: null,
    }];

    renderHistoryForTest(state);
    placeHistoryCursorOnText(state, url);

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "open_target", target: url });
  });
});

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

function typePromptText(state: ReturnType<typeof createInitialState>, text: string): void {
  for (const char of text) {
    expect(handleFocusedKey({ type: "char", char }, state)).toEqual({ type: "handled" });
  }
}

describe("autocomplete with vim Escape", () => {
  test("Escape after tab-completing a macro enters normal mode without undoing the completion", () => {
    const state = createInitialState();

    typePromptText(state, "/g");
    expect(state.autocomplete?.type).toBe("command");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/go");

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });

    expect(state.vim.mode).toBe("normal");
    expect(state.autocomplete).toBeNull();
    expect(state.inputBuffer).toBe("/go");
    expect(state.cursorPos).toBe(2);
  });

  test("Escape after tab-completing a command enters normal mode without undoing the completion", () => {
    const state = createInitialState();

    typePromptText(state, "/m");
    expect(state.autocomplete?.type).toBe("command");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/model");

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });

    expect(state.vim.mode).toBe("normal");
    expect(state.autocomplete).toBeNull();
    expect(state.inputBuffer).toBe("/model");
    expect(state.cursorPos).toBe(5);
  });

  test("Escape after tab-completing a mid-message macro enters normal mode without undoing the completion", () => {
    const state = createInitialState();

    typePromptText(state, "please /g");
    expect(state.autocomplete?.type).toBe("macro");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("please /go");

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });

    expect(state.vim.mode).toBe("normal");
    expect(state.autocomplete).toBeNull();
    expect(state.inputBuffer).toBe("please /go");
    expect(state.cursorPos).toBe(9);
  });
});

function buildToolToggleState(showToolOutput: boolean) {
  const state = createInitialState();
  state.cols = 80;
  state.layout.messageAreaHeight = 8;
  state.showToolOutput = showToolOutput;
  state.toolOutputsLoaded = true;
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

  test("Ctrl+O requests tool outputs before expanding when historical outputs were omitted", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.toolOutputsLoaded = false;
    state.toolOutputsLoading = false;

    const result = handleFocusedKey({ type: "ctrl-o" }, state);

    expect(result).toEqual({ type: "load_tool_outputs", convId: "conv-1" });
    expect(state.showToolOutput).toBe(false);
    expect(state.toolOutputsLoading).toBe(true);
    expect(state.showToolOutputAfterLoad).toBe(true);
  });

  test("tool_outputs_loaded fills outputs and completes the deferred expand", () => {
    const state = buildToolToggleState(false);
    state.convId = "conv-1";
    state.toolOutputsLoaded = false;
    state.toolOutputsLoading = true;
    state.showToolOutputAfterLoad = true;
    const assistant = state.messages[0];
    if (assistant.role !== "assistant") throw new Error("expected assistant");
    if (assistant.blocks[2].type !== "tool_result") throw new Error("expected tool result");
    assistant.blocks[2].output = "";
    state.scrollOffset = 5;
    state.historyCursor = { row: 29, col: 0 };
    state.historyVisualAnchor = { row: 29, col: 0 };

    handleEvent({
      type: "tool_outputs_loaded",
      convId: "conv-1",
      outputs: [{ toolCallId: "1", output: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") }],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.showToolOutput).toBe(true);
    expect(state.toolOutputsLoaded).toBe(true);
    expect(state.toolOutputsLoading).toBe(false);
    expect(state.showToolOutputAfterLoad).toBe(false);
    expect(topVisibleLine(state)).toBe("  after 28");
    if (assistant.blocks[2].type !== "tool_result") throw new Error("expected tool result");
    expect(assistant.blocks[2].output).toContain("line 20");
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
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} } as never);

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

describe("sidebar marked navigation", () => {
  test("[ and ] jump to the previous and next marked conversations in the sidebar", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      { ...conversation("conv-1", 1), marked: true },
      conversation("conv-2", 2),
      { ...conversation("conv-3", 3), marked: true },
      conversation("conv-4", 4),
      { ...conversation("conv-5", 5), marked: true },
    ];
    state.sidebar.selectedIndex = 2;
    state.sidebar.selectedId = "conv-3";

    expect(handleFocusedKey({ type: "char", char: "]" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-5");

    expect(handleFocusedKey({ type: "char", char: "]" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-1");

    expect(handleFocusedKey({ type: "char", char: "[" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-5");

    expect(handleFocusedKey({ type: "char", char: "[" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-3");
  });

  test("[ and ] do nothing when no other conversations are marked", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-1", 1),
      { ...conversation("conv-2", 2), marked: true },
      conversation("conv-3", 3),
    ];
    state.sidebar.selectedIndex = 1;
    state.sidebar.selectedId = "conv-2";

    expect(handleFocusedKey({ type: "char", char: "]" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-2");

    expect(handleFocusedKey({ type: "char", char: "[" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-2");
  });
});

function selectedSidebarScreenPosition(state: ReturnType<typeof createInitialState>): number {
  const rows = buildDisplayRows(state.sidebar);
  const selectedDisplayRow = rows.findIndex((row) => row.type === "entry" && row.convIdx === state.sidebar.selectedIndex);
  return selectedDisplayRow - state.sidebar.scrollOffset;
}

describe("sidebar Ctrl scrolling", () => {
  function setupSidebarScrollState() {
    const state = createInitialState();
    state.rows = 8;
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.layout.totalLines = 100;
    state.layout.messageAreaHeight = 10;
    state.scrollOffset = 7;
    state.sidebar.conversations = Array.from({ length: 12 }, (_, i) => conversation(`conv-${i + 1}`, i + 1));
    state.sidebar.selectedIndex = 4;
    state.sidebar.selectedId = "conv-5";
    return state;
  }

  test("Ctrl+E/Y use chat-history sticky-cursor scrolling on the sidebar", () => {
    const state = setupSidebarScrollState();
    state.sidebar.scrollOffset = 0;
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "conv-1";

    expect(handleFocusedKey({ type: "ctrl-e" }, state)).toEqual({ type: "handled" });

    // Ctrl+E scrolls the sidebar down one row; because the selected row would
    // leave the viewport, the selection is clamped to the new top edge.
    expect(state.sidebar.scrollOffset).toBe(1);
    expect(state.sidebar.selectedId).toBe("conv-2");
    expect(state.scrollOffset).toBe(7);

    expect(handleFocusedKey({ type: "ctrl-y" }, state)).toEqual({ type: "handled" });

    // Ctrl+Y scrolls back up one row while the selected row sticks to the same
    // buffer row because it remains visible.
    expect(state.sidebar.scrollOffset).toBe(0);
    expect(state.sidebar.selectedId).toBe("conv-2");
    expect(state.scrollOffset).toBe(7);
  });

  test("Ctrl+D/U move the sidebar selection by the same amount as the viewport", () => {
    const state = setupSidebarScrollState();
    state.sidebar.scrollOffset = 0;
    state.sidebar.selectedIndex = 4;
    state.sidebar.selectedId = "conv-5";

    expect(handleFocusedKey({ type: "ctrl-d" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.scrollOffset).toBe(3);
    expect(state.sidebar.selectedId).toBe("conv-8");
    expect(state.scrollOffset).toBe(7);

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.scrollOffset).toBe(0);
    expect(state.sidebar.selectedId).toBe("conv-5");
  });

  test("Ctrl+F/B use Vim page edge placement", () => {
    const state = setupSidebarScrollState();
    state.sidebar.scrollOffset = 0;
    state.sidebar.selectedIndex = 4;
    state.sidebar.selectedId = "conv-5";

    expect(handleFocusedKey({ type: "ctrl-f" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.scrollOffset).toBe(4);
    expect(state.sidebar.selectedId).toBe("conv-5");
    expect(selectedSidebarScreenPosition(state)).toBe(0);

    expect(handleFocusedKey({ type: "ctrl-b" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.scrollOffset).toBe(0);
    expect(state.sidebar.selectedId).toBe("conv-6");
    expect(selectedSidebarScreenPosition(state)).toBe(5);
  });

  test("Ctrl+D/U snap sidebar chrome off the viewport edge", () => {
    const state = setupSidebarScrollState();
    state.sidebar.conversations = Array.from({ length: 12 }, (_, i) =>
      conversation(`conv-${i + 1}`, i + 1, { pinned: i < 2 }),
    );
    state.sidebar.scrollOffset = 0;
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "conv-1";

    expect(handleFocusedKey({ type: "ctrl-d" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-3");
    expect(state.sidebar.scrollOffset).toBe(4);
    expect(selectedSidebarScreenPosition(state)).toBe(0);

    expect(handleFocusedKey({ type: "ctrl-d" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-6");
    expect(state.sidebar.scrollOffset).toBe(7);
    expect(selectedSidebarScreenPosition(state)).toBe(0);

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-3");
    expect(state.sidebar.scrollOffset).toBe(4);
    expect(selectedSidebarScreenPosition(state)).toBe(0);

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-1");
    expect(state.sidebar.scrollOffset).toBe(1);
    expect(selectedSidebarScreenPosition(state)).toBe(0);
  });
});

describe("sidebar visible jumps", () => {
  function setupSidebarJumpState() {
    const state = createInitialState();
    state.rows = 8;
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-1", 1),
      conversation("conv-2", 2),
      conversation("conv-3", 3),
      conversation("conv-4", 4),
      conversation("conv-5", 5),
      conversation("conv-6", 6),
      conversation("conv-7", 7),
      conversation("conv-8", 8),
    ];
    return state;
  }

  test("Shift+H jumps to the top visible conversation and repeats by scrolling half a page", () => {
    const state = setupSidebarJumpState();
    state.sidebar.scrollOffset = 2;
    state.sidebar.selectedIndex = 4;
    state.sidebar.selectedId = "conv-5";

    expect(handleFocusedKey({ type: "char", char: "H" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-3");
    expect(state.sidebar.scrollOffset).toBe(2);

    expect(handleFocusedKey({ type: "char", char: "H" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-1");
    expect(state.sidebar.scrollOffset).toBe(0);
  });

  test("Shift+L jumps to the bottom visible conversation and repeats by scrolling half a page", () => {
    const state = setupSidebarJumpState();
    state.sidebar.selectedIndex = 1;
    state.sidebar.selectedId = "conv-2";

    expect(handleFocusedKey({ type: "char", char: "L" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-6");
    expect(state.sidebar.scrollOffset).toBe(0);

    expect(handleFocusedKey({ type: "char", char: "L" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-8");
    expect(state.sidebar.scrollOffset).toBe(2);
  });

  test("Shift+M jumps to the middle visible conversation", () => {
    const state = setupSidebarJumpState();
    state.sidebar.scrollOffset = 1;
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "conv-1";

    expect(handleFocusedKey({ type: "char", char: "M" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-4");
    expect(state.sidebar.scrollOffset).toBe(1);
  });

  test("visible jumps skip section chrome and land on actual conversations", () => {
    const state = createInitialState();
    state.rows = 6;
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      { ...conversation("conv-1", 1), pinned: true },
      { ...conversation("conv-2", 2), pinned: true },
      conversation("conv-3", 3),
      conversation("conv-4", 4),
    ];
    state.sidebar.selectedIndex = 2;
    state.sidebar.selectedId = "conv-3";

    expect(handleFocusedKey({ type: "char", char: "H" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-1");

    expect(handleFocusedKey({ type: "char", char: "L" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-2");
  });
});
