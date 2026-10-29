import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleFocusedKey } from "./focus";
import { stripAnsi } from "./historycursor";
import { contentBounds } from "./historymotions";
import type { Message } from "./messages";
import { createInitialState, type RenderState } from "./state";

// h / l in the chat history move through one long wrapped line like Vim:
// past the end of a screen row they continue onto the row it wraps to, and
// back. At a real line start or end they stay put.

const h = { type: "char" as const, char: "h" };
const l = { type: "char" as const, char: "l" };

function historyState(messages: Message[]): RenderState {
  const state = createInitialState();
  state.cols = 60;
  state.rows = 40;
  state.convId = "hl-wrap";
  state.sidebar.open = false;
  state.showTurnWork = false;
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  state.layout.messageAreaHeight = 30;
  state.messages = messages;
  const rendered = buildMessageLines(state, state.cols);
  state.historyLines = rendered.lines;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyCopyLines = rendered.copyLines;
  state.historyMessageBounds = rendered.messageBounds;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
  return state;
}

const bounds = (state: RenderState, row: number) => contentBounds(stripAnsi(state.historyLines[row] ?? ""));

describe("h / l across a wrapped line", () => {
  const long = "alpha " + "word ".repeat(40) + "omega";
  const state0 = () => historyState([
    { role: "user", text: "go", metadata: null },
    { role: "assistant", blocks: [{ type: "text", text: `${long}\nshort line` }], metadata: null },
  ]);

  test("l at the end of a wrapped row continues on the next row, h comes back", () => {
    const state = state0();
    const first = state.historyLines.findIndex(line => stripAnsi(line).includes("alpha"));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(state.historyWrapContinuation[first + 1]).toBe(true);

    const end = bounds(state, first).end;
    state.historyCursor = { row: first, col: end };
    handleFocusedKey(l, state);
    expect(state.historyCursor).toEqual({ row: first + 1, col: bounds(state, first + 1).start });

    handleFocusedKey(h, state);
    expect(state.historyCursor).toEqual({ row: first, col: end });
  });

  test("at a real line end l stays, and at a real line start h stays", () => {
    const state = state0();
    const omegaRow = state.historyLines.findIndex(line => stripAnsi(line).includes("omega"));
    const shortRow = state.historyLines.findIndex(line => stripAnsi(line).includes("short line"));
    expect(state.historyWrapContinuation[shortRow]).toBe(false);

    const end = bounds(state, omegaRow).end;
    state.historyCursor = { row: omegaRow, col: end };
    handleFocusedKey(l, state);
    expect(state.historyCursor).toEqual({ row: omegaRow, col: end });

    const start = bounds(state, shortRow).start;
    state.historyCursor = { row: shortRow, col: start };
    handleFocusedKey(h, state);
    expect(state.historyCursor).toEqual({ row: shortRow, col: start });
  });

  test("inside a row h / l still move one character", () => {
    const state = state0();
    const first = state.historyLines.findIndex(line => stripAnsi(line).includes("alpha"));
    const start = bounds(state, first).start;
    state.historyCursor = { row: first, col: start + 2 };
    handleFocusedKey(l, state);
    expect(state.historyCursor).toEqual({ row: first, col: start + 3 });
    handleFocusedKey(h, state);
    handleFocusedKey(h, state);
    expect(state.historyCursor).toEqual({ row: first, col: start + 1 });
  });
});
