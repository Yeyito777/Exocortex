import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { stripAnsi } from "./historycursor";
import { handleFocusedKey } from "./focus";
import { getSearchBarViewport, handleSearchBarKey, jumpToSearchMatch, openSearchBar } from "./search";
import { createInitialState } from "./state";
import type { RenderState } from "./state";

function setupSearchState(): RenderState {
  const state = createInitialState();
  state.messages = [
    {
      role: "assistant",
      blocks: [{ type: "text", text: "alpha beta gamma" }],
      metadata: null,
    },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "beta delta" }],
      metadata: null,
    },
  ] as any;

  const { lines, wrapContinuation, messageBounds } = buildMessageLines(state, 80);
  state.historyLines = lines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyMessageBounds = messageBounds;
  state.layout.totalLines = lines.length;
  state.layout.messageAreaHeight = lines.length;
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  state.historyCursor = { row: 0, col: 0 };

  return state;
}

function rowColOfTerm(state: RenderState, term: string, occurrence = 0): { row: number; col: number } {
  let seen = 0;
  for (let row = 0; row < state.historyLines.length; row++) {
    const plain = stripAnsi(state.historyLines[row]);
    let from = 0;
    while (from <= plain.length - term.length) {
      const idx = plain.toLowerCase().indexOf(term.toLowerCase(), from);
      if (idx === -1) break;
      if (seen === occurrence) return { row, col: idx };
      seen++;
      from = idx + 1;
    }
  }
  throw new Error(`term not found: ${term} #${occurrence}`);
}

describe("chat history search", () => {
  test("/ opens the search bar in normal mode", () => {
    const state = setupSearchState();

    const result = handleFocusedKey({ type: "char", char: "/" }, state);

    expect(result).toEqual({ type: "handled" });
    expect(state.search?.barOpen).toBe(true);
    expect(state.search?.direction).toBe("forward");
  });

  test("live search moves the history cursor and Escape restores it", () => {
    const state = setupSearchState();
    const start = { ...state.historyCursor };

    openSearchBar(state, "forward");
    handleSearchBarKey(state, { type: "char", char: "b" });
    handleSearchBarKey(state, { type: "char", char: "e" });
    handleSearchBarKey(state, { type: "char", char: "t" });
    handleSearchBarKey(state, { type: "char", char: "a" });

    expect(state.historyCursor).toEqual(rowColOfTerm(state, "beta", 0));

    handleSearchBarKey(state, { type: "escape" });

    expect(state.search?.barOpen).toBe(false);
    expect(state.historyCursor).toEqual(start);
    expect(state.chatFocus).toBe("history");
  });

  test("confirmed search persists query and n/N navigate between matches", () => {
    const state = setupSearchState();

    openSearchBar(state, "forward");
    for (const ch of "beta") handleSearchBarKey(state, { type: "char", char: ch });
    handleSearchBarKey(state, { type: "enter" });

    expect(state.search?.query).toBe("beta");
    expect(state.search?.highlightsVisible).toBe(true);
    expect(state.chatFocus).toBe("history");
    expect(state.historyCursor).toEqual(rowColOfTerm(state, "beta", 0));

    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(state.historyCursor).toEqual(rowColOfTerm(state, "beta", 1));

    expect(jumpToSearchMatch(state, "backward")).toBe(true);
    expect(state.historyCursor).toEqual(rowColOfTerm(state, "beta", 0));
  });

  test(":noh hides search highlights without clearing the last query", () => {
    const state = setupSearchState();

    openSearchBar(state, "forward");
    for (const ch of "beta") handleSearchBarKey(state, { type: "char", char: ch });
    handleSearchBarKey(state, { type: "enter" });

    expect(state.search?.query).toBe("beta");
    expect(state.search?.highlightsVisible).toBe(true);

    const result = handleFocusedKey({ type: "char", char: ":" }, state);
    expect(result).toEqual({ type: "handled" });
    expect(state.search?.barOpen).toBe(true);
    expect(state.search?.barMode).toBe("command");

    for (const ch of "noh") handleSearchBarKey(state, { type: "char", char: ch });
    handleSearchBarKey(state, { type: "enter" });

    expect(state.search?.barOpen).toBe(false);
    expect(state.search?.query).toBe("beta");
    expect(state.search?.highlightsVisible).toBe(false);

    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(state.search?.highlightsVisible).toBe(true);
    expect(state.historyCursor).toEqual(rowColOfTerm(state, "beta", 1));
  });

  test("search bar viewport uses terminal width for wide input", () => {
    const state = setupSearchState();
    openSearchBar(state, "forward");
    state.search!.barInput = "ab🦋cd";
    state.search!.barCursorPos = state.search!.barInput.length;

    const viewport = getSearchBarViewport(state.search!, 6);

    expect(stripAnsi(viewport.line)).toBe("/ 🦋cd");
    expect(viewport.cursorCol).toBe(6);
  });
});
