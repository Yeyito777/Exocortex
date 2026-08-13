import { describe, expect, test } from "bun:test";
import { getBtwPanelPreferredHeight, renderBtwPanel } from "./panel";
import { tryCommand } from "../commands";
import { handleEvent } from "../events";
import { handleFocusedKey } from "../focus";
import { stripAnsi } from "../historycursor";
import type { ConversationSummary } from "../messages";
import { createInitialState } from "../state";
import type { BtwPanelState } from "./state";
import { termWidth } from "../textwidth";
import { theme } from "../theme";
import { hexToAnsi } from "../theme";
import { closeBtwSession, startBtwSession } from "./controller";

function panelState(overrides: Partial<BtwPanelState> = {}): BtwPanelState {
  return Object.assign({
    sessionId: "btw-1",
    sourceConvId: "conv-1",
    query: "What does this code do?",
    provider: "openai",
    model: "gpt-5.4",
    startedAt: 100,
    endedAt: null,
    phase: "running",
    blocks: [],
    text: "",
    status: "Thinking…",
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    historyCursor: { row: 0, col: 0 },
    historyCurswant: null,
    historyVisualAnchor: { row: 0, col: 0 },
    historyLines: [],
    historyWrapContinuation: [],
    historyWrapJoiners: [],
    historyCopyLines: [],
    historyMessageBounds: [],
    historyLineAnchors: [],
  }, overrides);
}

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

describe("/btw command", () => {
  test("starts a one-shot query for the active conversation", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.inputBuffer = "/btw explain the latest answer";
    state.cursorPos = state.inputBuffer.length;

    expect(tryCommand(state.inputBuffer, state)).toEqual({
      type: "btw_requested",
      query: "explain the latest answer",
    });
    expect(state.inputBuffer).toBe("");
  });

  test("requires a query and an active conversation", () => {
    const state = createInitialState();
    expect(tryCommand("/btw", state)).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string })?.text).toContain("Usage: /btw");

    state.messages = [];
    expect(tryCommand("/btw inspect this", state)).toEqual({ type: "handled" });
    expect((state.messages.at(-1) as { text?: string })?.text).toContain("Open a conversation");
  });

  test("explicit close only requests daemon interruption when a panel exists", () => {
    const state = createInitialState();
    expect(tryCommand("/btw close", state)).toEqual({ type: "handled" });
    state.btw = panelState();
    expect(tryCommand("/btw close", state)).toEqual({ type: "btw_close_requested" });
  });
});

describe("BTW session controller", () => {
  test("owns optimistic start and close state around daemon mutations", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const calls: unknown[] = [];
    const daemon = {
      startBtw: (...args: unknown[]) => calls.push(["start", ...args]),
      closeBtw: (...args: unknown[]) => calls.push(["close", ...args]),
    };

    startBtwSession(state, daemon, "explain this", () => "stable-session", () => 123);
    expect(state.btw).toMatchObject({
      sessionId: "stable-session",
      sourceConvId: "conv-1",
      query: "explain this",
      phase: "starting",
      startedAt: 123,
    });
    expect(calls).toEqual([["start", "conv-1", "stable-session", "explain this", 123]]);

    closeBtwSession(state, daemon);
    expect(state.btw).toBeNull();
    expect(calls.at(-1)).toEqual(["close", "conv-1", "stable-session"]);
  });
});

describe("BTW event projection", () => {
  test("streams, reconciles, and completes only the matching session", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const daemon = {} as Parameters<typeof handleEvent>[2];

    handleEvent({
      type: "btw_started",
      sessionId: "btw-1",
      convId: "conv-1",
      query: "What does this code do?",
      provider: "openai",
      model: "gpt-5.4",
      startedAt: 100,
    }, state, daemon);
    handleEvent({ type: "btw_text_chunk", convId: "conv-1", sessionId: "stale", text: "wrong" }, state, daemon);
    handleEvent({ type: "btw_block_start", convId: "conv-1", sessionId: "btw-1", blockType: "thinking" }, state, daemon);
    handleEvent({ type: "btw_thinking_chunk", convId: "conv-1", sessionId: "btw-1", text: "A concise reasoning summary" }, state, daemon);
    handleEvent({
      type: "btw_tool_call",
      convId: "conv-1",
      sessionId: "btw-1",
      toolCallId: "read-1",
      toolName: "read",
      input: { file_path: "README.md" },
      summary: "README.md",
    }, state, daemon);
    handleEvent({ type: "btw_block_start", convId: "conv-1", sessionId: "btw-1", blockType: "text" }, state, daemon);
    handleEvent({ type: "btw_text_chunk", convId: "conv-1", sessionId: "btw-1", text: "partial" }, state, daemon);
    handleEvent({
      type: "btw_content",
      convId: "conv-1",
      sessionId: "btw-1",
      text: "canonical answer",
      blocks: [
        { type: "thinking", text: "Canonical reasoning summary" },
        { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { file_path: "README.md" }, summary: "README.md" },
        { type: "text", text: "canonical answer" },
      ],
    }, state, daemon);
    handleEvent({ type: "btw_finished", convId: "conv-1", sessionId: "btw-1", endedAt: 200 }, state, daemon);

    expect(state.btw?.text).toBe("canonical answer");
    expect(state.btw?.blocks).toEqual([
      { type: "thinking", text: "Canonical reasoning summary" },
      { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { file_path: "README.md" }, summary: "README.md" },
      { type: "text", text: "canonical answer" },
    ]);
    expect(state.btw?.phase).toBe("complete");
    expect(state.btw?.endedAt).toBe(200);
  });

  test("keeps errors visible until an explicit close event", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.btw = panelState();
    const daemon = {} as Parameters<typeof handleEvent>[2];

    handleEvent({ type: "btw_error", convId: "conv-1", sessionId: "btw-1", message: "provider failed", endedAt: 200 }, state, daemon);
    expect(state.btw?.phase).toBe("error");
    expect(state.btw?.status).toBe("provider failed");

    handleEvent({ type: "btw_closed", convId: "conv-1", sessionId: "btw-1" }, state, daemon);
    expect(state.btw).toBeNull();
  });

  test("rehydrates the BTW owned by each loaded conversation until it is closed", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    const daemon = {
      unsubscribe() {},
      loadToolOutputs() {},
    } as unknown as Parameters<typeof handleEvent>[2];
    const durable = {
      sessionId: "durable-btw",
      query: "remember this",
      provider: "openai" as const,
      model: "gpt-5.6-sol",
      startedAt: 100,
      endedAt: 200,
      phase: "complete" as const,
      text: "persisted answer",
      status: "Complete",
    };

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-2",
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: 0,
      toolOutputsIncluded: false,
      btw: durable,
    }, state, daemon);
    expect(state.btw).toMatchObject({
      ...durable,
      sourceConvId: "conv-2",
      scrollOffset: 0,
    });

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-3",
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "high",
      fastMode: false,
      entries: [],
      contextTokens: 0,
      toolOutputsIncluded: false,
      btw: null,
    }, state, daemon);
    expect(state.btw).toBeNull();

    handleEvent({ type: "btw_snapshot", convId: "conv-3", btw: durable }, state, daemon);
    expect(state.btw?.sourceConvId).toBe("conv-3");
    handleEvent({ type: "btw_snapshot", convId: "conv-3", btw: null }, state, daemon);
    expect(state.btw).toBeNull();
  });

  test("clears an orphaned panel when reconnect catch-up omits its deleted conversation", () => {
    const state = createInitialState();
    state.convId = "deleted-conv";
    state.messages = [{ role: "assistant", blocks: [{ type: "text", text: "stale conversation" }], metadata: null }];
    state.btw = panelState({ sourceConvId: "deleted-conv" });
    state.sidebar.conversations = [conversation("deleted-conv", 1)];

    handleEvent({
      type: "conversations_list",
      conversations: [conversation("other-conv", 2)],
      folders: [],
    }, state, {} as Parameters<typeof handleEvent>[2]);

    expect(state.convId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.btw).toBeNull();
  });
});

describe("BTW foreground panel", () => {
  test("starts with one content row before the assistant produces output", () => {
    const btw = panelState();
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(3);
    const originalAppBg = theme.appBg;
    const originalSidebarBg = theme.sidebarBg;
    try {
      theme.appBg = "\x1b[48;2;1;2;3m";
      theme.sidebarBg = "\x1b[48;2;4;5;6m";
      const rendered = renderBtwPanel(btw, 100, 3, 10, 1);
      expect(rendered?.height).toBe(3);
      expect(btw.viewportRows).toBe(1);
      expect(rendered?.payload).toContain(theme.appBg);
      expect(rendered?.payload).not.toContain(theme.sidebarBg);
    } finally {
      theme.appBg = originalAppBg;
      theme.sidebarBg = originalSidebarBg;
    }
  });

  test("does not add an empty row for the first one-line thinking summary", () => {
    const btw = panelState({
      blocks: [{ type: "thinking", text: "Checking the implementation" }],
    });
    const preferredHeight = getBtwPanelPreferredHeight(btw, 100);
    const rendered = renderBtwPanel(btw, 100, preferredHeight, 10, 1);
    const rows = rendered!.payload
      .split(/\x1b\[\d+;\d+H/)
      .filter(Boolean)
      .map(stripAnsi);

    expect(preferredHeight).toBe(3);
    expect(rendered?.height).toBe(3);
    expect(btw.viewportRows).toBe(1);
    expect(rows.filter(row => row.includes("│"))).toHaveLength(1);
    expect(rows[1]).toContain("Checking the implementation");
  });

  test("grows with the streamed answer up to 20 rows, then holds the answer's first row", () => {
    const btw = panelState({ text: ["one", "two", "three", "four", "five"].join("\n") });
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(7);
    let rendered = renderBtwPanel(btw, 100, 7, 10, 1);
    expect(rendered?.height).toBe(7);
    expect(btw.viewportRows).toBe(5);
    expect(btw.maxScroll).toBe(0);

    btw.text = Array.from({ length: 30 }, (_, i) => `row ${String(i + 1).padStart(3, "0")}`).join("\n");
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(20);
    rendered = renderBtwPanel(btw, 100, 20, 10, 1);
    const plain = stripAnsi(rendered!.payload);
    expect(rendered?.height).toBe(20);
    expect(btw.viewportRows).toBe(18);
    expect(btw.maxScroll).toBe(12);
    expect(btw.streamingResponseAutoscroll?.mode).toBe("anchored");
    expect(plain).toContain("row 001");
    expect(plain).not.toContain("row 030");

    btw.phase = "complete";
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(20);
  });

  test("holds the beginning of final text rather than earlier thinking", () => {
    const btw = panelState({
      blocks: [
        { type: "thinking", text: "thinking 1\nthinking 2\nthinking 3" },
        {
          type: "text",
          text: Array.from({ length: 10 }, (_, index) => `answer ${String(index + 1).padStart(2, "0")}`).join("\n"),
        },
      ],
    });

    const rendered = renderBtwPanel(btw, 100, 10, 10, 1);
    const plain = stripAnsi(rendered!.payload);

    expect(btw.viewportRows).toBe(8);
    expect(btw.streamingResponseAutoscroll?.mode).toBe("anchored");
    expect(plain).toContain("answer 01");
    expect(plain).not.toContain("thinking 3");
    expect(plain).not.toContain("answer 10");
  });

  test("keeps a scrolled-up viewport anchored while the answer continues streaming", () => {
    const rows = (start: number, end: number) => Array.from(
      { length: end - start + 1 },
      (_, index) => `row ${String(start + index).padStart(3, "0")}`,
    );
    const btw = panelState({ text: rows(1, 30).join("\n") });

    renderBtwPanel(btw, 100, 8, 10, 1);
    btw.scrollOffset = 10;
    let rendered = renderBtwPanel(btw, 100, 8, 10, 1);
    let plain = stripAnsi(rendered!.payload);
    expect(plain).toContain("row 015");
    expect(plain).toContain("row 020");
    expect(plain).not.toContain("row 021");

    btw.text += `\n${rows(31, 35).join("\n")}`;
    rendered = renderBtwPanel(btw, 100, 8, 10, 1);
    plain = stripAnsi(rendered!.payload);

    expect(btw.scrollOffset).toBe(15);
    expect(plain).toContain("row 015");
    expect(plain).toContain("row 020");
    expect(plain).not.toContain("row 021");
    expect(plain).not.toContain("row 035");
  });

  test("renders a wide four-row answer card without keybind help", () => {
    const btw = panelState({ phase: "complete", text: "**The answer** is read-only." });
    const rendered = renderBtwPanel(btw, 100, 4, 20, 31);
    expect(rendered).not.toBeNull();
    const plain = stripAnsi(rendered!.payload);
    expect(plain).toContain("What does this code do?");
    expect(plain).not.toContain("BTW");
    expect(plain).not.toContain("Gpt-5.4");
    expect(plain).toContain("The answer");
    expect(plain).not.toContain("complete");
    expect(plain).not.toContain("/btw close");
    expect(plain).not.toContain("j/k");
    expect(plain).not.toContain("^Q");
    expect(rendered!.height).toBe(4);
    expect(rendered!.top).toBe(20);
    expect(rendered!.left).toBe(31);
    expect(btw.viewportRows).toBe(2);
  });

  test("reuses assistant block rendering for thinking summaries and colored tool calls", () => {
    const btw = panelState({
      blocks: [
        { type: "thinking", text: "I should inspect the relevant file." },
        {
          type: "tool_call",
          toolCallId: "read-1",
          toolName: "read",
          input: { file_path: "README.md" },
          summary: "README.md",
        },
        { type: "text", text: "The file explains the project." },
      ],
      text: "The file explains the project.",
    });
    const options = {
      toolRegistry: [{ name: "read", label: "Read", color: "#12abef" }],
      externalToolStyles: [],
    };
    const preferredHeight = getBtwPanelPreferredHeight(btw, 100, options);
    const rendered = renderBtwPanel(btw, 100, preferredHeight, 10, 1, options);
    const plain = stripAnsi(rendered!.payload);

    expect(plain).toContain("I should inspect the relevant file.");
    expect(plain).toContain("Read README.md");
    expect(plain).toContain("The file explains the project.");
    expect(rendered!.payload).toContain(hexToAnsi("#12abef"));
  });

  test("renders the shared history cursor and visual selection decorations", () => {
    const btw = panelState({
      blocks: [{ type: "text", text: "alpha beta\ngamma delta" }],
      text: "alpha beta\ngamma delta",
    });

    let rendered = renderBtwPanel(btw, 80, 4, 10, 1, {
      focused: true,
      vimMode: "normal",
    });
    expect(rendered?.payload).toContain(theme.cursorBg);

    btw.historyVisualAnchor = { row: 0, col: 2 };
    btw.historyCursor = { row: 1, col: 6 };
    rendered = renderBtwPanel(btw, 80, 4, 10, 1, {
      focused: true,
      vimMode: "visual",
    });
    expect(rendered?.payload).toContain(theme.selectionBg);
  });

  test("renders an uncluttered one-row fallback in a constrained layout", () => {
    const rendered = renderBtwPanel(panelState(), 20, 1, 5, 3);
    expect(rendered).not.toBeNull();
    const plain = stripAnsi(rendered!.payload);
    expect(plain).toContain("What does this");
    expect(plain).not.toContain("BTW");
    expect(plain).not.toContain("Gpt-5.4");
    expect(plain).not.toContain("running");
    expect(plain).not.toContain("complete");
    expect(plain).not.toContain("^Q");
    expect(rendered!.height).toBe(1);
    expect(rendered!.top).toBe(5);
    expect(rendered!.left).toBe(3);
  });

  test("keeps every card row within a narrow terminal", () => {
    const rendered = renderBtwPanel(panelState({ text: "A compact answer." }), 22, 4);
    expect(rendered).not.toBeNull();
    const rows = rendered!.payload.split(/\x1b\[\d+;\d+H/).filter(Boolean);
    expect(rows.every(row => termWidth(stripAnsi(row)) <= rendered!.width)).toBe(true);
  });

  test("normal-mode q and insert-mode Ctrl-Q close while scrolling keys move the BTW viewport", () => {
    const state = createInitialState();
    state.btw = panelState({ scrollOffset: 0, maxScroll: 10, viewportRows: 5 });
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "k" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(1);
    expect(handleFocusedKey({ type: "char", char: "q" }, state)).toEqual({ type: "btw_close" });

    state.vim.mode = "insert";
    expect(handleFocusedKey({ type: "ctrl-q" }, state)).toEqual({ type: "btw_close" });
  });

  test("Backspace at the start of the prompt removes images before closing BTW", () => {
    const state = createInitialState();
    state.btw = panelState();
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "keep this draft";
    state.cursorPos = 0;
    state.pendingImages = [{
      mediaType: "image/png",
      base64: "image-data",
      sizeBytes: 10,
    }];

    expect(handleFocusedKey({ type: "backspace" }, state)).toEqual({ type: "handled" });
    expect(state.pendingImages).toHaveLength(0);
    expect(state.btw).not.toBeNull();

    expect(handleFocusedKey({ type: "backspace" }, state)).toEqual({ type: "btw_close" });
    expect(state.inputBuffer).toBe("keep this draft");

    state.cursorPos = 1;
    expect(handleFocusedKey({ type: "backspace" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("eep this draft");
  });

  test("Ctrl-N cycles from the visible BTW history through chat history to the prompt", () => {
    const state = createInitialState();
    state.btw = panelState({
      blocks: [{ type: "text", text: Array.from({ length: 8 }, (_, i) => `btw row ${i + 1}`).join("\n") }],
      text: Array.from({ length: 8 }, (_, i) => `btw row ${i + 1}`).join("\n"),
    });
    renderBtwPanel(state.btw, 80, 5);
    state.historyLines = ["chat history must stay untouched"];
    state.historyCursor = { row: 0, col: 7 };

    expect(handleFocusedKey({ type: "ctrl-n" }, state)).toEqual({ type: "handled" });
    expect(state.chatFocus).toBe("btw");
    expect(state.vim.mode).toBe("normal");
    expect(state.btw.historyCursor.row).toBe(2);
    expect(state.historyCursor).toEqual({ row: 0, col: 7 });

    expect(handleFocusedKey({ type: "ctrl-n" }, state)).toEqual({ type: "handled" });
    expect(state.chatFocus).toBe("history");
    expect(state.vim.mode).toBe("normal");
    expect(state.historyCursor).toEqual({ row: 0, col: 0 });

    expect(handleFocusedKey({ type: "ctrl-n" }, state)).toEqual({ type: "handled" });
    expect(state.chatFocus).toBe("prompt");
    expect(state.vim.mode).toBe("insert");
  });

  test("focused BTW reuses history Vim motions, visual quoting, and search", () => {
    const state = createInitialState();
    state.btw = panelState({
      blocks: [{ type: "text", text: "alpha beta\ngamma delta\nomega target" }],
      text: "alpha beta\ngamma delta\nomega target",
    });
    renderBtwPanel(state.btw, 80, 5);
    state.historyCursor = { row: 0, col: 19 };

    handleFocusedKey({ type: "ctrl-n" }, state);
    handleFocusedKey({ type: "char", char: "g" }, state);
    handleFocusedKey({ type: "char", char: "g" }, state);
    expect(state.btw.historyCursor.row).toBe(0);
    expect(state.historyCursor).toEqual({ row: 0, col: 19 });

    handleFocusedKey({ type: "char", char: "v" }, state);
    handleFocusedKey({ type: "char", char: "$" }, state);
    expect(state.vim.mode).toBe("visual");
    handleFocusedKey({ type: "char", char: ";" }, state);
    expect(state.chatFocus).toBe("prompt");
    expect(state.inputBuffer).toContain('"""\nalpha beta\n"""');

    handleFocusedKey({ type: "ctrl-n" }, state);
    handleFocusedKey({ type: "char", char: "/" }, state);
    for (const char of "target") handleFocusedKey({ type: "char", char }, state);
    handleFocusedKey({ type: "enter" }, state);
    expect(state.chatFocus).toBe("btw");
    expect(state.btw.historyCursor.row).toBe(2);
    expect(state.search?.query).toBe("target");
  });

  test("Enter opens a target under the focused BTW history cursor", () => {
    const state = createInitialState();
    state.btw = panelState({
      blocks: [{ type: "text", text: "Generated /tmp/btw-result.png" }],
      text: "Generated /tmp/btw-result.png",
    });
    renderBtwPanel(state.btw, 80, 4);

    handleFocusedKey({ type: "ctrl-n" }, state);
    handleFocusedKey({ type: "char", char: "0" }, state);
    for (let i = 0; i < 12; i++) handleFocusedKey({ type: "char", char: "l" }, state);

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "open_target",
      target: "/tmp/btw-result.png",
    });
  });

  test("sidebar keeps j/k, Ctrl scrolling, and Ctrl-Q while BTW is visible", () => {
    const state = createInitialState();
    state.btw = panelState({ scrollOffset: 5, maxScroll: 10, viewportRows: 5 });
    state.panelFocus = "sidebar";
    state.sidebar.open = true;
    state.vim.mode = "normal";
    state.sidebar.conversations = [conversation("one", 1), conversation("two", 2)];
    state.sidebar.selectedItem = { type: "conversation", id: "one" };
    state.sidebar.selectedId = "one";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("two");
    expect(state.btw.scrollOffset).toBe(5);

    expect(handleFocusedKey({ type: "char", char: "k" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("one");
    expect(state.btw.scrollOffset).toBe(5);

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(5);

    expect(handleFocusedKey({ type: "ctrl-q" }, state)).toEqual({ type: "abort" });
    expect(state.btw).not.toBeNull();
  });

  test("visual and pending prompt motions are not taken by BTW", () => {
    const state = createInitialState();
    state.btw = panelState({ scrollOffset: 5, maxScroll: 10, viewportRows: 5 });
    state.inputBuffer = "one\ntwo\nthree";
    state.cursorPos = 0;
    state.vim.mode = "visual";
    state.vim.visualAnchor = 0;

    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(state.cursorPos).toBe(4);
    expect(state.btw.scrollOffset).toBe(5);

    state.vim.mode = "normal";
    state.cursorPos = 0;
    expect(handleFocusedKey({ type: "char", char: "d" }, state)).toEqual({ type: "handled" });
    expect(state.vim.pendingOperator).toBe("delete");
    expect(handleFocusedKey({ type: "char", char: "j" }, state)).toEqual({ type: "handled" });
    expect(state.vim.pendingOperator).toBeNull();
    expect(state.btw.scrollOffset).toBe(5);
  });

  test("Ctrl scrolling from the prompt continues to target chat history, not BTW", () => {
    const state = createInitialState();
    state.btw = panelState({ scrollOffset: 0, maxScroll: 10, viewportRows: 6 });
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "keep this prompt";
    state.cursorPos = state.inputBuffer.length;
    state.historyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    state.historyCursor = { row: 29, col: 0 };
    state.layout.totalLines = 30;
    state.layout.messageAreaHeight = 10;
    state.scrollOffset = 0;

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(0);
    expect(state.scrollOffset).toBeGreaterThan(0);
    expect(state.inputBuffer).toBe("keep this prompt");

    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.historyCursor = { row: 29, col: 0 };
    state.scrollOffset = 0;

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(0);
    expect(state.scrollOffset).toBeGreaterThan(0);
  });
});
