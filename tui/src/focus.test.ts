import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { buildMessageLines } from "./conversation";
import { getViewStartFor } from "./chatscroll";
import { handleEvent } from "./events";
import { buildDisplayRows, renderSidebar, sidebarHitTest } from "./sidebar";
import { theme } from "./theme";
import { createInitialState } from "./state";
import { clearPrompt } from "./promptstate";
import type { ConversationSummary, FolderSummary, ProviderInfo } from "./messages";

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

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name: id,
    parentId: null,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    pinned: false,
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

test("Ctrl-C always quits, even when the sidebar has selection or prompts", () => {
  const state = createInitialState();
  state.panelFocus = "sidebar";
  state.sidebar.open = true;
  state.sidebar.conversations = [conversation("conv-a", 0)];
  state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
  state.sidebar.visualAnchor = { type: "conversation", id: "conv-a" };
  state.sidebar.pendingDeleteItem = { type: "conversation", id: "conv-a" };

  expect(handleFocusedKey({ type: "ctrl-c" }, state)).toEqual({ type: "quit" });

  state.sidebar.prompt = { purpose: "create_folder", input: "", cursorPos: 0, items: [] };
  expect(handleFocusedKey({ type: "ctrl-c" }, state)).toEqual({ type: "quit" });
});

test("Ctrl-A backgrounds the current tool even when a modal has focus", () => {
  const state = createInitialState();
  state.queuePrompt = { text: "queued", selection: "next-turn" };

  expect(handleFocusedKey({ type: "ctrl-a" }, state)).toEqual({ type: "background_tool" });
});

test("Ctrl-R requests sidebar redo when the sidebar is focused", () => {
  const state = createInitialState();
  state.panelFocus = "sidebar";
  state.sidebar.open = true;
  state.vim.mode = "normal";

  expect(handleFocusedKey({ type: "ctrl-r" }, state)).toEqual({ type: "redo_delete" });
});

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

describe("prompt control-character sanitization", () => {
  test("bracketed paste strips terminal controls before storing prompt text", () => {
    const state = createInitialState();

    const result = handleFocusedKey({ type: "paste", text: "E\x1b[31mred\x1b[0m\u009b32mgreen\x07\r\n\tok" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("Eredgreen\n    ok");
    expect(state.cursorPos).toBe(state.inputBuffer.length);
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(state.inputBuffer)).toBe(false);
  });

  test("typed character events cannot insert hidden terminal controls", () => {
    const state = createInitialState();

    const result = handleFocusedKey({ type: "char", char: "E\x1b[31m!\u009b32m" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("E!");
    expect(state.cursorPos).toBe(2);
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

    typePromptText(state, "/tho");
    expect(state.autocomplete?.type).toBe("command");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/thoughts");

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });

    expect(state.vim.mode).toBe("normal");
    expect(state.autocomplete).toBeNull();
    expect(state.inputBuffer).toBe("/thoughts");
    expect(state.cursorPos).toBe(8);
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

  test("/default-model command and nested args autocomplete", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);

    typePromptText(state, "/def");
    expect(state.autocomplete?.type).toBe("command");
    expect(state.autocomplete?.matches.map(match => match.name)).toContain("/default-model");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/default-model");

    typePromptText(state, " openai/gpt-5.4 h");
    expect(state.autocomplete?.type).toBe("command");
    expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["high"]);

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("/default-model openai/gpt-5.4 high");
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

  test("mid-message autocomplete offers inline commands and their supported args", () => {
    const state = createInitialState();
    state.providerRegistry = structuredClone(providers);
    state.provider = "openai";
    state.model = "gpt-5.4";

    typePromptText(state, "please /eff");
    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches.map(match => match.name)).toContain("/effort");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("please /effort");

    typePromptText(state, " h");
    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["high"]);

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("please /effort high");

    clearPrompt(state);
    typePromptText(state, "please /fa");
    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches.map(match => match.name)).toContain("/fast");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("please /fast");

    typePromptText(state, " o");
    expect(state.autocomplete?.type).toBe("macro");
    expect(state.autocomplete?.matches.map(match => match.name)).toEqual(["on", "off"]);
  });

  test("mid-message autocomplete does not offer ordinary slash commands", () => {
    const state = createInitialState();

    typePromptText(state, "please /mod");

    expect(state.autocomplete).toBeNull();
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

  test("same-conversation reload preserves the sidebar folder being browsed", () => {
    const state = createInitialState();
    state.convId = "conv-active";
    state.sidebar.currentFolderId = null;
    state.sidebar.folders = [folder("folder-project", 1)];
    state.sidebar.conversations = [
      conversation("conv-root", 1),
      conversation("conv-active", 2, { folderId: "folder-project" }),
    ];
    state.sidebar.selectedItem = { type: "folder", id: "folder-project" };

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-active",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} } as never);

    expect(state.convId).toBe("conv-active");
    expect(state.sidebar.currentFolderId).toBeNull();
    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-project" });
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

describe("sidebar folders", () => {
  test("visual f opens a create-folder prompt for the selected conversations", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "f" }, state)).toEqual({ type: "handled" });
    for (const ch of "Project") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "create_folder",
      name: "Project",
      parentId: null,
      items: [
        { type: "conversation", id: "conv-a" },
        { type: "conversation", id: "conv-b" },
      ],
    });
    expect(state.sidebar.visualAnchor).toBeNull();
  });

  test("creating a folder does not move the sidebar into that new folder", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "f" }, state)).toEqual({ type: "handled" });
    for (const ch of "Project") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state).type).toBe("create_folder");

    // Daemon response after folder creation: selected conversations now belong
    // to the new folder, but the current sidebar folder should remain root.
    handleEvent({
      type: "conversation_moved",
      folders: [{ id: "folder-project", name: "Project", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 1 }],
      conversations: [
        conversation("top", 0),
        conversation("conv-a", 1, { folderId: "folder-project" }),
        conversation("conv-b", 2, { folderId: "folder-project" }),
      ],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.currentFolderId).toBeNull();
    expect(buildDisplayRows(state.sidebar).some(row => row.item?.type === "folder" && row.item.id === "folder-project")).toBe(true);
    const selected = state.sidebar.selectedItem as { type: string; id?: string } | null;
    expect(selected).toEqual({ type: "folder", id: "folder-project" });
  });

  test("removing the selected conversation keeps the cursor near the old row", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("top", 0),
      conversation("source", 1),
      conversation("clone", 2),
      conversation("bottom", 3),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "clone" };
    state.sidebar.selectedId = "clone";
    state.sidebar.selectedIndex = 2;

    handleEvent({ type: "conversation_deleted", convId: "clone" }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.selectedItem as { type: string; id?: string } | null).toEqual({ type: "conversation", id: "source" });
  });

  test("removing the selected folder keeps the cursor near the old row, preferring above", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [folder("folder-project", 1)];
    state.sidebar.conversations = [conversation("top", 0), conversation("bottom", 2)];
    state.sidebar.selectedItem = { type: "folder", id: "folder-project" };

    handleEvent({
      type: "conversation_moved",
      folders: [],
      conversations: [conversation("top", 0), conversation("bottom", 2)],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.selectedItem as { type: string; id?: string } | null).toEqual({ type: "conversation", id: "top" });
  });

  test("pinned folders render without a separate pinned marker", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [{ id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: true, sortOrder: 1 }];
    state.sidebar.selectedItem = { type: "folder", id: "folder-work" };

    const rendered = stripAnsi(renderSidebar(state.sidebar, 8, true, null).join("\n"));
    expect(rendered).toContain("📁 Work/ 0");
    expect(rendered).not.toContain("◆");
  });

  test("folder rename prompt starts empty instead of autofilling the current name", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [{ id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 }];
    state.sidebar.selectedItem = { type: "folder", id: "folder-work" };

    expect(handleFocusedKey({ type: "char", char: "r" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt).toMatchObject({ purpose: "rename_folder", input: "", cursorPos: 0, folderId: "folder-work" });
    expect(stripAnsi(renderSidebar(state.sidebar, 8, true, null).join("\n"))).toContain("Rename: name");

    for (const ch of "Projects") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "rename_folder", folderId: "folder-work", name: "Projects" });
  });

  test("move prompt autocompletes folder names with the promptline-style popup", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-archive", name: "Archive", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-work", name: "Work", parentId: null, createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 3)];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.autocomplete?.matches.map(match => match.name)).toContain("Work");
    const renderedPrompt = stripAnsi(renderSidebar(state.sidebar, 10, true, null).join("\n"));
    expect(renderedPrompt).toContain("root folder");
    expect(renderedPrompt).toContain("top-level");
    expect(renderedPrompt).not.toContain("top-level folder");
    expect(renderedPrompt).toContain("Move: folder");

    expect(handleFocusedKey({ type: "char", char: "W" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.autocomplete?.matches.map(match => match.name)).toEqual(["Work"]);
    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.input).toBe("Work");

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: "folder-work",
      before: undefined,
    });
  });

  test("move prompt autocompletes nested folder paths and Enter resolves them", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-clients", name: "Clients", parentId: "folder-work", createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 3)];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    for (const ch of "Cli") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.autocomplete?.matches.map(match => match.name)).toEqual(["Work/Clients"]);
    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.input).toBe("Work/Clients");

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: "folder-clients",
      before: undefined,
    });
  });

  test("move prompt prioritizes the current folder's subfolders", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.currentFolderId = "folder-work";
    state.sidebar.folders = [
      { id: "folder-archive", name: "Archive", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-work", name: "Work", parentId: null, createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
      { id: "folder-clients", name: "Clients", parentId: "folder-work", createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 },
      { id: "folder-projects", name: "Projects", parentId: "folder-work", createdAt: 4, updatedAt: 4, pinned: false, sortOrder: 4 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 5, { folderId: "folder-work" })];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    const matches = state.sidebar.prompt?.autocomplete?.matches.map(match => match.name) ?? [];
    expect(matches.slice(0, 4)).toEqual([
      "/",
      "..",
      "Work/Clients",
      "Work/Projects",
    ]);
    expect(matches).not.toContain("Work");

    expect(handleFocusedKey({ type: "tab" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt?.input).toBe("/");
  });

  test("moving a conversation into a visible folder keeps focus near the removed row, preferring above", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [{ id: "folder-work", name: "Work", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 }];
    state.sidebar.conversations = [conversation("top", 0), conversation("conv-a", 1), conversation("conv-b", 2)];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 1;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    for (const ch of "Work") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: "folder-work",
    });
    expect(state.sidebar.pendingFocusItem).toEqual({ type: "conversation", id: "top" });

    handleEvent({
      type: "conversation_moved",
      folders: state.sidebar.folders,
      conversations: [
        conversation("top", 0),
        conversation("conv-a", 1, { folderId: "folder-work" }),
        conversation("conv-b", 2),
      ],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.currentFolderId).toBeNull();
    expect(state.sidebar.selectedItem as { type: string; id?: string } | null).toEqual({ type: "conversation", id: "top" });
  });

  test("moving a conversation out requests insertion immediately before the source folder", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.currentFolderId = "folder-work";
    state.sidebar.folders = [{ id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 2 }];
    state.sidebar.conversations = [conversation("conv-a", 1, { folderId: "folder-work" })];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "<" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: null,
      before: { type: "folder", id: "folder-work" },
    });
  });

  test("move prompt .. inserts immediately before the folder being moved out of", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.currentFolderId = "folder-clients";
    state.sidebar.folders = [
      { id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-clients", name: "Clients", parentId: "folder-work", createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 1, { folderId: "folder-clients" })];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "." }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "." }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: "folder-work",
      before: { type: "folder", id: "folder-clients" },
    });
  });

  test("move prompt / inserts immediately before the top-level source folder", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.currentFolderId = "folder-clients";
    state.sidebar.folders = [
      { id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-clients", name: "Clients", parentId: "folder-work", createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 1, { folderId: "folder-clients" })];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "F" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "/" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: null,
      before: { type: "folder", id: "folder-work" },
    });
  });

  test("visual e moves the selected sidebar block up", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
      conversation("conv-d", 4),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-b" };
    state.sidebar.selectedId = "conv-b";
    state.sidebar.selectedIndex = 1;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "e" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [
        { type: "conversation", id: "conv-b" },
        { type: "conversation", id: "conv-c" },
      ],
      parentId: null,
      before: { type: "conversation", id: "conv-a" },
      preservePinned: true,
    });
    expect(state.sidebar.visualAnchor).toEqual({ type: "conversation", id: "conv-b" });
  });

  test("visual Shift+E moves the selected sidebar block down", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
      conversation("conv-d", 4),
      conversation("conv-e", 5),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-b" };
    state.sidebar.selectedId = "conv-b";
    state.sidebar.selectedIndex = 1;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "E" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [
        { type: "conversation", id: "conv-b" },
        { type: "conversation", id: "conv-c" },
      ],
      parentId: null,
      before: { type: "conversation", id: "conv-e" },
      preservePinned: true,
      placement: undefined,
    });
  });

  test("visual Shift+E can move the selected sidebar block to the bottom", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
      conversation("conv-d", 4),
      conversation("conv-e", 5),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-c" };
    state.sidebar.selectedId = "conv-c";
    state.sidebar.selectedIndex = 2;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "E" }, state)).toEqual({
      type: "move_sidebar_items",
      items: [
        { type: "conversation", id: "conv-c" },
        { type: "conversation", id: "conv-d" },
      ],
      parentId: null,
      before: undefined,
      preservePinned: true,
      placement: "bottom",
    });
  });

  test("pending visual dd renders all selected conversations as delete-pending", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "handled" });

    const rows = renderSidebar(state.sidebar, 8, true, null);
    const deleteRows = rows.filter(row => row.includes(theme.error));
    expect(deleteRows).toHaveLength(2);
    expect(stripAnsi(deleteRows[0])).toContain("conv-a");
    expect(stripAnsi(deleteRows[1])).toContain("conv-b");
  });

  test("visual dd deletes all selected conversations", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.conversations = [
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "v" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({
      type: "delete_conversations",
      convIds: ["conv-a", "conv-b"],
    });
    expect(state.sidebar.conversations.map(c => c.id)).toEqual(["conv-c"]);
    expect(state.sidebar.visualAnchor).toBeNull();
  });

  test("dd on a folder waits for the server update before moving the cursor to a nearby item above", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-a", name: "A", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-b", name: "B", parentId: null, createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
      { id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 },
    ];
    state.sidebar.selectedItem = { type: "folder", id: "folder-b" };

    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "delete_folder", folderId: "folder-b", mode: "recursive" });
    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-b" });

    handleEvent({
      type: "conversation_moved",
      folders: [
        { id: "folder-a", name: "A", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
        { id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 },
      ],
      conversations: [],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-a" });
  });

  test("dd on a folder recursively deletes children and focuses the next nearby item", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-b", name: "B", parentId: null, createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
      { id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 },
    ];
    state.sidebar.conversations = [conversation("conv-child", 1, { folderId: "folder-b" })];
    state.sidebar.selectedItem = { type: "folder", id: "folder-b" };

    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "delete_folder", folderId: "folder-b", mode: "recursive" });
    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-b" });
    expect(state.sidebar.pendingFocusItem).toEqual({ type: "folder", id: "folder-c" });

    handleEvent({
      type: "conversation_moved",
      folders: [{ id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 }],
      conversations: [],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.selectedItem as { type: string; id?: string } | null).toEqual({ type: "folder", id: "folder-c" });
    expect(state.sidebar.pendingFocusItem).toBeNull();
  });

  test("x unwraps a folder and focuses the first unwrapped child after the server update", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-b", name: "B", parentId: null, createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
      { id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 },
    ];
    state.sidebar.conversations = [conversation("conv-child", 1, { folderId: "folder-b" })];
    state.sidebar.selectedItem = { type: "folder", id: "folder-b" };

    expect(handleFocusedKey({ type: "char", char: "x" }, state)).toEqual({ type: "delete_folder", folderId: "folder-b", mode: "unwrap" });
    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-b" });
    expect(state.sidebar.pendingFocusItem).toEqual({ type: "conversation", id: "conv-child" });

    handleEvent({
      type: "conversation_moved",
      folders: [{ id: "folder-c", name: "C", parentId: null, createdAt: 3, updatedAt: 3, pinned: false, sortOrder: 3 }],
      conversations: [conversation("conv-child", 1)],
    }, state, { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} });

    expect(state.sidebar.selectedItem as { type: string; id?: string } | null).toEqual({ type: "conversation", id: "conv-child" });
    expect(state.sidebar.pendingFocusItem).toBeNull();
  });

  test("sidebar hit testing returns folders as sidebar items", () => {
    const state = createInitialState();
    state.sidebar.folders = [
      { id: "folder-a", name: "A", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
    ];
    state.sidebar.conversations = [conversation("conv-a", 2)];

    expect(sidebarHitTest(3, 10, state.sidebar)).toEqual({ type: "folder", id: "folder-a" });
    expect(sidebarHitTest(4, 10, state.sidebar)).toEqual({ type: "conversation", id: "conv-a" });
  });

  test("l enters a folder and h leaves back to the parent", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [{
      id: "folder-1",
      name: "Work",
      parentId: null,
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      sortOrder: 1,
    }];
    state.sidebar.conversations = [conversation("inside", 1, { folderId: "folder-1" })];
    state.sidebar.selectedItem = { type: "folder", id: "folder-1" };

    expect(handleFocusedKey({ type: "char", char: "l" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.currentFolderId).toBe("folder-1");
    expect(buildDisplayRows(state.sidebar).some(row => row.item?.type === "up")).toBe(true);

    expect(handleFocusedKey({ type: "char", char: "h" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.currentFolderId).toBeNull();
    expect(state.sidebar.selectedItem).toEqual({ type: "folder", id: "folder-1" });
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

  test("Ctrl+D/U keep section labels visible at the viewport edge", () => {
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
    expect(state.sidebar.scrollOffset).toBe(0);
    expect(selectedSidebarScreenPosition(state)).toBe(1);
  });

  test("Ctrl+D scrolling down from the Pinned label preserves the selectable entry position", () => {
    const state = setupSidebarScrollState();
    state.rows = 4;
    state.sidebar.conversations = Array.from({ length: 12 }, (_, i) =>
      conversation(`conv-${i + 1}`, i + 1, { pinned: i < 2 }),
    );
    state.sidebar.scrollOffset = 0;
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "conv-1";

    expect(selectedSidebarScreenPosition(state)).toBe(1);
    expect(handleFocusedKey({ type: "ctrl-d" }, state)).toEqual({ type: "handled" });
    renderSidebar(state.sidebar, state.rows, true, null);

    expect(state.sidebar.selectedId).toBe("conv-2");
    expect(state.sidebar.scrollOffset).toBe(2);
    expect(selectedSidebarScreenPosition(state)).toBe(0);
  });

  test("gg shows the Pinned section label at the top of the sidebar", () => {
    const state = setupSidebarScrollState();
    state.sidebar.conversations = Array.from({ length: 12 }, (_, i) =>
      conversation(`conv-${i + 1}`, i + 1, { pinned: i < 2 }),
    );
    state.sidebar.scrollOffset = 7;
    state.sidebar.selectedIndex = 5;
    state.sidebar.selectedId = "conv-6";

    expect(handleFocusedKey({ type: "char", char: "g" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "g" }, state)).toEqual({ type: "handled" });

    expect(state.sidebar.selectedId).toBe("conv-1");
    expect(state.sidebar.scrollOffset).toBe(0);
    expect(buildDisplayRows(state.sidebar)[state.sidebar.scrollOffset]?.text).toBe(" Pinned");
    expect(selectedSidebarScreenPosition(state)).toBe(1);
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
