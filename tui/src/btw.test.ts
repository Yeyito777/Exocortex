import { describe, expect, test } from "bun:test";
import { getBtwPanelPreferredHeight, renderBtwPanel } from "./btwpanel";
import { tryCommand } from "./commands";
import { handleEvent } from "./events";
import { handleFocusedKey } from "./focus";
import { stripAnsi } from "./historycursor";
import { createInitialState, type BtwPanelState } from "./state";
import { termWidth } from "./textwidth";

function panelState(overrides: Partial<BtwPanelState> = {}): BtwPanelState {
  return {
    sessionId: "btw-1",
    sourceConvId: "conv-1",
    query: "What does this code do?",
    provider: "openai",
    model: "gpt-5.4",
    startedAt: 100,
    endedAt: null,
    phase: "running",
    text: "",
    status: "Thinking…",
    scrollOffset: 0,
    maxScroll: 0,
    viewportRows: 1,
    ...overrides,
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

describe("BTW event projection", () => {
  test("streams, reconciles, and completes only the matching session", () => {
    const state = createInitialState();
    state.btw = panelState({ phase: "starting", text: "" });
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
    handleEvent({ type: "btw_text_chunk", sessionId: "stale", text: "wrong" }, state, daemon);
    handleEvent({ type: "btw_text_chunk", sessionId: "btw-1", text: "partial" }, state, daemon);
    handleEvent({ type: "btw_content", sessionId: "btw-1", text: "canonical answer" }, state, daemon);
    handleEvent({ type: "btw_finished", sessionId: "btw-1", endedAt: 200 }, state, daemon);

    expect(state.btw?.text).toBe("canonical answer");
    expect(state.btw?.phase).toBe("complete");
    expect(state.btw?.endedAt).toBe(200);
  });

  test("keeps errors visible until an explicit close event", () => {
    const state = createInitialState();
    state.btw = panelState();
    const daemon = {} as Parameters<typeof handleEvent>[2];

    handleEvent({ type: "btw_error", sessionId: "btw-1", message: "provider failed", endedAt: 200 }, state, daemon);
    expect(state.btw?.phase).toBe("error");
    expect(state.btw?.status).toBe("provider failed");

    handleEvent({ type: "btw_closed", sessionId: "btw-1" }, state, daemon);
    expect(state.btw).toBeNull();
  });
});

describe("BTW foreground panel", () => {
  test("stays compact while running, then grows with the final answer up to 20 rows", () => {
    const btw = panelState({ text: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") });
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(4);

    btw.phase = "complete";
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(20);

    btw.text = ["one", "two", "three", "four", "five"].join("\n");
    expect(getBtwPanelPreferredHeight(btw, 100)).toBe(7);
    const rendered = renderBtwPanel(btw, 100, 7, 10, 1);
    expect(rendered?.height).toBe(7);
    expect(btw.viewportRows).toBe(5);
  });

  test("renders a wide four-row answer card without keybind help", () => {
    const btw = panelState({ phase: "complete", text: "**The answer** is read-only." });
    const rendered = renderBtwPanel(btw, 100, 4, 20, 31);
    expect(rendered).not.toBeNull();
    const plain = stripAnsi(rendered!.payload);
    expect(plain).toContain("BTW");
    expect(plain).toContain("Gpt-5.4");
    expect(plain).toContain("What does this code do?");
    expect(plain).toContain("The answer");
    expect(plain).not.toContain("/btw close");
    expect(plain).not.toContain("j/k");
    expect(plain).not.toContain("^Q");
    expect(rendered!.height).toBe(4);
    expect(rendered!.top).toBe(20);
    expect(rendered!.left).toBe(31);
    expect(btw.viewportRows).toBe(2);
  });

  test("renders an uncluttered one-row fallback in a constrained layout", () => {
    const rendered = renderBtwPanel(panelState(), 20, 1, 5, 3);
    expect(rendered).not.toBeNull();
    const plain = stripAnsi(rendered!.payload);
    expect(plain).toContain("BTW");
    expect(plain).toContain("running");
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

  test("Ctrl scrolling targets BTW from the prompt but chat history when history is focused", () => {
    const state = createInitialState();
    state.btw = panelState({ scrollOffset: 0, maxScroll: 10, viewportRows: 6 });
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    state.inputBuffer = "keep this prompt";
    state.cursorPos = state.inputBuffer.length;

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(3);
    expect(state.inputBuffer).toBe("keep this prompt");

    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.historyLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    state.historyCursor = { row: 29, col: 0 };
    state.layout.totalLines = 30;
    state.layout.messageAreaHeight = 10;
    state.scrollOffset = 0;

    expect(handleFocusedKey({ type: "ctrl-u" }, state)).toEqual({ type: "handled" });
    expect(state.btw.scrollOffset).toBe(3);
    expect(state.scrollOffset).toBeGreaterThan(0);
  });
});
