import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleFocusedKey } from "./focus";
import { stripAnsi } from "./historycursor";
import { historySurfaceViewStart, activeHistorySurface } from "./historysurface";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode } from "./inlineimages";
import type { Block, ImageRef, Message } from "./messages";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import type { BtwPanelState } from "./btw/state";

// Shift+K / Shift+J in the history: the cursor moves the rows Ctrl+U / Ctrl+D
// would, but the view does not scroll; the cursor stops at the visible edge.

const K = { type: "char" as const, char: "K" };
const J = { type: "char" as const, char: "J" };

function renderHistory(state: RenderState): void {
  const rendered = buildMessageLines(state, state.cols);
  state.historyLines = rendered.lines;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyCopyLines = rendered.copyLines;
  state.historyMessageBounds = rendered.messageBounds;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
}

function historyState(messages: Message[], height = 20): RenderState {
  const state = createInitialState();
  state.cols = 80;
  state.rows = 40;
  state.convId = "half-page";
  state.sidebar.open = false;
  state.showTurnWork = false;
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  state.layout.messageAreaHeight = height;
  state.messages = messages;
  renderHistory(state);
  return state;
}

function lines(count: number): Message[] {
  return [
    { role: "user", text: "go", metadata: null },
    { role: "assistant", blocks: [{ type: "text", text: Array.from({ length: count }, (_, i) => `reply line ${i}`).join("\n") }], metadata: null },
  ];
}

const viewStart = (state: RenderState) => historySurfaceViewStart(activeHistorySurface(state));
const viewEnd = (state: RenderState) => Math.min(state.historyLines.length - 1, viewStart(state) + state.layout.messageAreaHeight - 1);

/** Ctrl+U/Ctrl+D's cursor move from the same spot, on a throwaway copy of the view. */
function ctrlMove(state: RenderState, key: "ctrl-u" | "ctrl-d"): number {
  const copy = historyState(state.messages, state.layout.messageAreaHeight);
  copy.scrollOffset = state.scrollOffset;
  copy.historyCursor = { ...state.historyCursor };
  handleFocusedKey({ type: key }, copy);
  expect(copy.scrollOffset).not.toBe(state.scrollOffset);
  return copy.historyCursor.row - state.historyCursor.row;
}

describe("Shift+K / Shift+J in chat history", () => {
  test("move the cursor exactly Ctrl+U / Ctrl+D's rows without scrolling", () => {
    const state = historyState(lines(200));
    state.scrollOffset = 60;
    const start = viewStart(state) + 10;
    state.historyCursor = { row: start, col: 0 };

    const up = ctrlMove(state, "ctrl-u");
    expect(up).toBe(-10);
    expect(handleFocusedKey(K, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row - start).toBe(up);
    expect(state.scrollOffset).toBe(60);
    expect(state.sidebar.open).toBe(false);

    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(start);
    const down = ctrlMove(state, "ctrl-d");
    expect(down).toBe(10);
    state.historyCursor = { row: start - 5, col: 0 };
    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(start - 5 + down);
    expect(state.scrollOffset).toBe(60);
  });

  test("an odd viewport moves floor(height / 2) rows, like Ctrl+U", () => {
    const state = historyState(lines(200), 9);
    state.scrollOffset = 40;
    const start = viewStart(state) + 6;
    state.historyCursor = { row: start, col: 0 };
    expect(ctrlMove(state, "ctrl-u")).toBe(-4);
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(start - 4);
    expect(state.scrollOffset).toBe(40);
  });

  test("the cursor stops at the visible top and bottom row instead of scrolling", () => {
    const state = historyState(lines(200));
    state.scrollOffset = 60;
    const top = viewStart(state);
    const bottom = viewEnd(state);

    state.historyCursor = { row: top + 3, col: 0 };
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(top);
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(top);
    expect(state.scrollOffset).toBe(60);

    state.historyCursor = { row: bottom - 3, col: 0 };
    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(bottom);
    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(bottom);
    expect(state.scrollOffset).toBe(60);
  });

  test("at the very top and bottom of the conversation the cursor stops at the content", () => {
    const state = historyState(lines(200));
    state.scrollOffset = state.historyLines.length - state.layout.messageAreaHeight;
    expect(viewStart(state)).toBe(0);
    state.historyCursor = { row: 4, col: 0 };
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(0);
    expect(state.scrollOffset).toBe(state.historyLines.length - state.layout.messageAreaHeight);

    state.scrollOffset = 0;
    const last = state.historyLines.length - 1;
    state.historyCursor = { row: last - 2, col: 0 };
    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(last);
    expect(state.scrollOffset).toBe(0);
  });

  test("a conversation shorter than the view clamps to its first and last row", () => {
    const state = historyState(lines(3), 30);
    const last = state.historyLines.length - 1;
    expect(last).toBeLessThan(29);
    state.historyCursor = { row: 2, col: 0 };
    handleFocusedKey(J, state);
    expect(state.historyCursor.row).toBe(last);
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(Math.max(0, last - 15));
    handleFocusedKey(K, state);
    expect(state.historyCursor.row).toBe(0);
    expect(state.scrollOffset).toBe(0);
  });

  test("wrapped lines count as the rows they take on screen, and the column is kept like j/k", () => {
    const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} ` + "word ".repeat(40)).join("\n");
    const state = historyState([
      { role: "user", text: "go", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: long }], metadata: null },
    ]);
    expect(state.historyWrapContinuation.filter(Boolean).length).toBeGreaterThan(40);
    state.scrollOffset = 30;
    const start = viewStart(state) + 12;
    state.historyCursor = { row: start, col: 30 };
    const up = ctrlMove(state, "ctrl-u");

    handleFocusedKey(K, state);
    expect(state.historyCursor.row - start).toBe(up);
    handleFocusedKey(J, state);
    expect(state.historyCursor).toEqual({ row: start, col: 30 });
    expect(state.scrollOffset).toBe(30);
  });

  test("folded and unfolded tool work moves by rows on screen without scrolling", () => {
    const work: Block[] = Array.from({ length: 30 }, (_, i) => [
      { type: "tool_call", toolCallId: `c${i}`, toolName: "bash", input: { command: `echo ${i}` }, summary: `echo ${i}` },
      { type: "tool_result", toolCallId: `c${i}`, toolName: "bash", output: `${i}\n`.repeat(4), isError: false },
    ] as Block[]).flat();
    const messages: Message[] = [
      { role: "user", text: "go", metadata: null },
      { role: "assistant", blocks: [...work, { type: "text", text: Array.from({ length: 60 }, (_, i) => `answer ${i}`).join("\n") }], metadata: null },
      ...lines(40),
    ];
    for (const showTurnWork of [false, true]) {
      const state = historyState(messages);
      state.showTurnWork = showTurnWork;
      renderHistory(state);
      // View with the turn's work (folded row or tool blocks) in its upper half.
      const firstAnswer = state.historyLines.findIndex(line => stripAnsi(line).includes("answer 0"));
      const top = Math.max(0, firstAnswer - 5);
      state.scrollOffset = state.historyLines.length - state.layout.messageAreaHeight - top;
      expect(viewStart(state)).toBe(top);
      const start = top + 15;
      state.historyCursor = { row: start, col: 0 };

      handleFocusedKey(K, state);
      expect(state.historyCursor.row).toBe(start - 10);
      handleFocusedKey(K, state);
      expect(state.historyCursor.row).toBe(top);
      handleFocusedKey(J, state);
      expect(state.historyCursor.row).toBe(top + 10);
      expect(viewStart(state)).toBe(top);
    }
  });

  describe("with inline images", () => {
    beforeEach(() => inlineImagesInternalsForTest.reset());
    afterEach(() => inlineImagesInternalsForTest.reset());

    test("image rows are passed over like any row and the view stays", () => {
      configureInlineImages({ fetch: async () => ({ format: "png" as const, width: 400, height: 300, base64: "UE5H" }), onChange: () => {} });
      setInlineImageMode("kitty");
      setInlineImageCellSize({ width: 8, height: 16 });
      const image: ImageRef = { id: "e".repeat(64), mediaType: "image/png", width: 400, height: 300, sizeBytes: 1000, name: "chart.png" };
      const state = historyState([
        { role: "user", text: "chart", metadata: null },
        {
          role: "assistant",
          blocks: [
            { type: "tool_call", toolCallId: "a", toolName: "attach", input: { paths: ["chart.png"] }, summary: "" },
            { type: "tool_result", toolCallId: "a", toolName: "attach", output: "Attached 1 image", isError: false, images: [image] },
            { type: "text", text: "Here it is." },
          ],
          metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
        },
        ...lines(60),
      ]);
      const imageRows = state.historyLineAnchors.map((a, row) => a.images ? row : -1).filter(row => row >= 0);
      expect(imageRows.length).toBeGreaterThan(5);
      const top = Math.max(0, imageRows[0] - 2);
      state.scrollOffset = state.historyLines.length - state.layout.messageAreaHeight - top;
      const start = top + 14;
      state.historyCursor = { row: start, col: 0 };

      handleFocusedKey(K, state);
      expect(state.historyCursor.row).toBe(start - 10);
      expect(imageRows).toContain(state.historyCursor.row);
      handleFocusedKey(J, state);
      expect(state.historyCursor.row).toBe(start);
      expect(viewStart(state)).toBe(top);
    });
  });

  test("a rendered frame keeps the same view after Shift+K / Shift+J", () => {
    const state = historyState(lines(200));
    state.layout.messageAreaHeight = 0; // render() lays it out
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      render(state);
      state.scrollOffset = 50;
      render(state);
      const top = viewStart(state);
      const height = state.layout.messageAreaHeight;
      state.historyCursor = { row: top + height - 1, col: 0 };
      handleFocusedKey(K, state);
      render(state);
      expect(state.historyCursor.row).toBe(top + height - 1 - Math.floor(height / 2));
      handleFocusedKey(J, state);
      handleFocusedKey(J, state);
      render(state);
      expect(state.historyCursor.row).toBe(top + height - 1);
      expect(state.scrollOffset).toBe(50);
      expect(viewStart(state)).toBe(top);
    } finally {
      process.stdout.write = write as typeof process.stdout.write;
    }
  });

  test("in visual mode they extend the selection from its anchor", () => {
    const state = historyState(lines(200));
    state.scrollOffset = 60;
    const start = viewStart(state) + 10;
    state.historyCursor = { row: start, col: 0 };
    handleFocusedKey({ type: "char", char: "V" }, state);
    handleFocusedKey(K, state);
    expect(state.vim.mode).toBe("visual-line");
    expect(state.historyVisualAnchor.row).toBe(start);
    expect(state.historyCursor.row).toBe(start - 10);
    expect(state.scrollOffset).toBe(60);
  });

  test("fK still finds a K on the line instead of moving half a page", () => {
    const state = historyState([
      { role: "user", text: "go", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "abc K def\n" + Array.from({ length: 60 }, (_, i) => `x ${i}`).join("\n") }], metadata: null },
    ]);
    const row = state.historyLines.findIndex(line => stripAnsi(line).includes("abc K def"));
    state.scrollOffset = state.historyLines.length - state.layout.messageAreaHeight - Math.max(0, row - 5);
    state.historyCursor = { row, col: stripAnsi(state.historyLines[row]).indexOf("abc") };
    handleFocusedKey({ type: "char", char: "f" }, state);
    handleFocusedKey(K, state);
    expect(state.historyCursor).toEqual({ row, col: stripAnsi(state.historyLines[row]).indexOf("K") });
  });

  test("the BTW history moves its own cursor the same way", () => {
    const state = createInitialState();
    const historyLines = Array.from({ length: 40 }, (_, i) => `btw line ${i}`);
    state.btw = {
      sessionId: "btw-1", sourceConvId: "conv-1", query: "q", provider: "openai", model: "gpt-5.4",
      startedAt: 1, endedAt: 2, phase: "done", blocks: [], text: "", status: "",
      scrollOffset: 10, streamingResponseAutoscroll: null, maxScroll: 30, viewportRows: 8,
      historyCursor: { row: 0, col: 0 }, historyCurswant: null, historyVisualAnchor: { row: 0, col: 0 },
      historyLines, historyWrapContinuation: historyLines.map(() => false), historyWrapJoiners: [],
      historyCopyLines: [], historyMessageBounds: [], historyLineAnchors: [], turns: [],
    } as unknown as BtwPanelState;
    state.panelFocus = "chat";
    state.chatFocus = "btw";
    state.vim.mode = "normal";
    const top = viewStart(state);
    state.btw!.historyCursor = { row: top + 6, col: 0 };

    handleFocusedKey(K, state);
    expect(state.btw!.historyCursor.row).toBe(top + 2);
    handleFocusedKey(K, state);
    expect(state.btw!.historyCursor.row).toBe(top);
    handleFocusedKey(J, state);
    expect(state.btw!.historyCursor.row).toBe(top + 4);
    expect(state.btw!.scrollOffset).toBe(10);
  });

  test("outside the history Shift+J/K still move the sidebar selection", () => {
    const state = historyState(lines(50));
    state.chatFocus = "prompt";
    state.sidebar.conversations = ["a", "b", "c"].map((id, i) => ({
      id, provider: "openai", model: "gpt-5.4", effort: "high", createdAt: i, updatedAt: i, messageCount: 1,
      title: id, marked: false, pinned: false, muted: false, streaming: false, unread: false, sortOrder: i,
    })) as unknown as RenderState["sidebar"]["conversations"];
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "a";
    state.sidebar.selectedItem = { type: "conversation", id: "a" };
    handleFocusedKey(J, state);
    expect(state.sidebar.open).toBe(true);
    expect(state.sidebar.selectedId).toBe("b");
    handleFocusedKey(K, state);
    expect(state.sidebar.selectedId).toBe("a");
  });
});
