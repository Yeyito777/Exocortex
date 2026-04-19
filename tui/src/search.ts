/**
 * Chat-history search state and helpers.
 *
 * Implements vim-style / and ? search over the rendered chat history, plus a
 * small ":" command bar used for :noh.
 *
 * Search highlighting is line-based for rendering, while navigation uses a
 * flattened virtual buffer so matches map back to the history cursor cleanly.
 */

import type { KeyEvent } from "./input";
import type { RenderState, SearchState } from "./state";
import { focusHistory } from "./state";
import { ensureCursorVisible, stripAnsi } from "./historycursor";
import { theme } from "./theme";
import { findAllCaseInsensitiveMatchStarts, findCaseInsensitiveMatches, findNextSortedMatch } from "./searchutil";
import { getViewportByWidth, padRightToWidth } from "./textwidth";
import { resetPending } from "./vim/types";

export type SearchDirection = "forward" | "backward";
export type SearchBarMode = "search" | "command";

export type SearchKeyResult =
  | { type: "handled" }
  | { type: "abort" };

interface SearchIndex {
  lines: string[];
  buffer: string;
  lineStarts: number[];
}

function buildSearchIndex(state: RenderState): SearchIndex {
  const lines = state.historyLines.map((line) => stripAnsi(line));
  const lineStarts: number[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(offset);
    offset += lines[i].length;
    if (i < lines.length - 1) offset += 1; // joined newline
  }

  return { lines, buffer: lines.join("\n"), lineStarts };
}

function rowColToPos(index: SearchIndex, row: number, col: number): number {
  if (index.lines.length === 0) return 0;
  const safeRow = Math.max(0, Math.min(row, index.lines.length - 1));
  const safeCol = Math.max(0, Math.min(col, index.lines[safeRow].length));
  return index.lineStarts[safeRow] + safeCol;
}

function posToRowCol(index: SearchIndex, pos: number): { row: number; col: number } {
  if (index.lines.length === 0) return { row: 0, col: 0 };

  const clamped = Math.max(0, Math.min(pos, Math.max(0, index.buffer.length - 1)));
  let row = 0;
  for (let i = 1; i < index.lineStarts.length; i++) {
    if (index.lineStarts[i] > clamped) break;
    row = i;
  }

  const col = Math.max(0, Math.min(clamped - index.lineStarts[row], index.lines[row].length));
  return { row, col };
}

function findNextMatch(
  buffer: string,
  query: string,
  fromPos: number,
  direction: SearchDirection,
): number | null {
  return findNextSortedMatch(findAllCaseInsensitiveMatchStarts(buffer, query), fromPos, direction);
}

function moveHistoryCursorToMatch(state: RenderState, pos: number, index: SearchIndex): void {
  state.historyCursor = posToRowCol(index, pos);
  ensureCursorVisible(state);
}

function restoreSearchOrigin(state: RenderState, search: SearchState): void {
  state.scrollOffset = search.savedScrollOffset;
  state.historyCursor = { ...search.savedHistoryCursor };
}

function buildBarState(
  state: RenderState,
  barMode: SearchBarMode,
  direction: SearchDirection,
): SearchState {
  return {
    barOpen: true,
    barMode,
    direction,
    query: state.search?.query ?? "",
    barInput: "",
    barCursorPos: 0,
    highlightsVisible: state.search?.highlightsVisible ?? false,
    savedScrollOffset: state.scrollOffset,
    savedHistoryCursor: { ...state.historyCursor },
    originChatFocus: state.chatFocus,
  };
}

function getSearchStartPos(search: SearchState, index: SearchIndex): number {
  if (search.originChatFocus === "history") {
    return rowColToPos(index, search.savedHistoryCursor.row, search.savedHistoryCursor.col);
  }
  return Math.max(0, index.buffer.length - 1);
}

function replaceBarInput(state: RenderState, nextInput: string, nextCursorPos: number): void {
  const search = state.search;
  if (!search) return;
  search.barInput = nextInput;
  search.barCursorPos = nextCursorPos;
  liveSearchToNearestMatch(state);
}

function insertIntoBar(state: RenderState, text: string): void {
  const search = state.search;
  if (!search || !text) return;
  replaceBarInput(
    state,
    search.barInput.slice(0, search.barCursorPos) + text + search.barInput.slice(search.barCursorPos),
    search.barCursorPos + text.length,
  );
}

function normalizeBarPaste(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
}

function executeCommand(state: RenderState, command: string): void {
  const search = state.search;
  if (!search) return;

  switch (command) {
    case "noh":
      search.highlightsVisible = false;
      break;
    default:
      break;
  }
}

function liveSearchToNearestMatch(state: RenderState): void {
  const search = state.search;
  if (!search || !search.barOpen || search.barMode !== "search") return;

  if (!search.barInput) {
    restoreSearchOrigin(state, search);
    return;
  }

  const index = buildSearchIndex(state);
  if (!index.buffer.length) return;

  const matchPos = findNextMatch(index.buffer, search.barInput, getSearchStartPos(search, index), search.direction);
  if (matchPos == null) return;

  moveHistoryCursorToMatch(state, matchPos, index);
}

export function openSearchBar(state: RenderState, direction: SearchDirection): void {
  resetPending(state.vim);
  state.search = buildBarState(state, "search", direction);
}

export function openCommandBar(state: RenderState): void {
  resetPending(state.vim);
  state.search = buildBarState(state, "command", state.search?.direction ?? "forward");
}

export function closeSearchBar(state: RenderState, cancel: boolean): void {
  const search = state.search;
  if (!search) return;

  if (cancel) {
    restoreSearchOrigin(state, search);
    state.panelFocus = "chat";
    state.chatFocus = search.originChatFocus;
    state.vim.mode = "normal";
  }

  search.barOpen = false;
  search.barInput = "";
  search.barCursorPos = 0;
}

export function jumpToSearchMatch(state: RenderState, direction: SearchDirection): boolean {
  const search = state.search;
  if (!search?.query) return false;

  const index = buildSearchIndex(state);
  if (!index.buffer.length) return false;

  const fromPos = state.chatFocus === "history"
    ? rowColToPos(index, state.historyCursor.row, state.historyCursor.col)
    : Math.max(0, index.buffer.length - 1);
  const matchPos = findNextMatch(index.buffer, search.query, fromPos, direction);
  if (matchPos == null) return false;

  search.highlightsVisible = true;
  focusHistory(state);
  moveHistoryCursorToMatch(state, matchPos, index);
  return true;
}

export function handleSearchBarKey(state: RenderState, key: KeyEvent): SearchKeyResult {
  const search = state.search;
  if (!search?.barOpen) return { type: "handled" };

  if (key.type === "ctrl-q") return { type: "abort" };

  if (key.type === "escape" || key.type === "ctrl-c") {
    closeSearchBar(state, true);
    return { type: "handled" };
  }

  if (key.type === "enter") {
    if (search.barMode === "command") {
      executeCommand(state, search.barInput.trim());
      closeSearchBar(state, false);
      return { type: "handled" };
    }

    if (search.barInput) {
      search.query = search.barInput;
      search.highlightsVisible = true;
      liveSearchToNearestMatch(state);
      focusHistory(state);
    }
    closeSearchBar(state, false);
    return { type: "handled" };
  }

  if (key.type === "backspace") {
    if (search.barCursorPos > 0) {
      replaceBarInput(
        state,
        search.barInput.slice(0, search.barCursorPos - 1) + search.barInput.slice(search.barCursorPos),
        search.barCursorPos - 1,
      );
    } else if (search.barInput.length === 0) {
      closeSearchBar(state, true);
    }
    return { type: "handled" };
  }

  if (key.type === "delete") {
    if (search.barCursorPos < search.barInput.length) {
      replaceBarInput(
        state,
        search.barInput.slice(0, search.barCursorPos) + search.barInput.slice(search.barCursorPos + 1),
        search.barCursorPos,
      );
    }
    return { type: "handled" };
  }

  if (key.type === "left") {
    if (search.barCursorPos > 0) search.barCursorPos--;
    return { type: "handled" };
  }

  if (key.type === "right") {
    if (search.barCursorPos < search.barInput.length) search.barCursorPos++;
    return { type: "handled" };
  }

  if (key.type === "home") {
    search.barCursorPos = 0;
    return { type: "handled" };
  }

  if (key.type === "end") {
    search.barCursorPos = search.barInput.length;
    return { type: "handled" };
  }

  if (key.type === "paste" && key.text) {
    insertIntoBar(state, normalizeBarPaste(key.text));
    return { type: "handled" };
  }

  if (key.type === "char" && key.char) {
    insertIntoBar(state, key.char);
    return { type: "handled" };
  }

  return { type: "handled" };
}

export function getActiveSearchQuery(state: RenderState): string | null {
  const search = state.search;
  if (!search) return null;
  if (search.barOpen && search.barMode === "search") return search.barInput || null;
  if (search.highlightsVisible && search.query) return search.query;
  return null;
}

export function findSearchMatches(text: string, query: string): { from: number; to: number }[] {
  return findCaseInsensitiveMatches(text, query);
}

export function getSearchBarViewport(search: SearchState, chatWidth: number): {
  line: string;
  cursorCol: number;
} {
  const prompt = search.barMode === "command"
    ? ":"
    : (search.direction === "forward" ? "/" : "?");
  const placeholder = search.barMode === "command" ? "command" : "search history";
  const prefix = `${theme.accent}${prompt}${theme.reset} `;
  const maxWidth = Math.max(0, chatWidth - 2);
  const viewport = getViewportByWidth(search.barInput, search.barCursorPos, maxWidth);
  const visibleText = viewport.visibleText;

  return {
    line: prefix + (visibleText
      ? padRightToWidth(visibleText, maxWidth)
      : `${theme.dim}${padRightToWidth(placeholder, maxWidth)}${theme.reset}`),
    cursorCol: 2 + viewport.cursorCol,
  };
}
