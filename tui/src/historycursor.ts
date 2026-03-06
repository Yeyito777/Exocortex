/**
 * Chat history cursor — state, dispatch, scroll, find, and visual selection.
 *
 * Pure motions live in historymotions.ts.
 * This file owns the stateful operations that depend on RenderState:
 * action dispatch, cursor-aware scrolling, find interception,
 * and visual selection extraction.
 */

import type { KeyEvent } from "./input";
import type { Action } from "./keybinds";
import type { RenderState } from "./state";
import {
  stripAnsi, clampCursor,
  charLeft, charRight, lineUp, lineDown, lineStart, lineEnd,
  bufferStart, bufferEnd,
  wordForward, wordBackward, wordEnd,
  wordForwardBig, wordBackwardBig, wordEndBig,
  findForward, findBackward,
} from "./historymotions";

// Re-export everything from historymotions so existing consumers don't break
export {
  stripAnsi, contentBounds, clampCol, clampCursor,
  charLeft, charRight, lineUp, lineDown, lineStart, lineEnd,
  bufferStart, bufferEnd,
  wordForward, wordBackward, wordEnd,
  wordForwardBig, wordBackwardBig, wordEndBig,
  findForward, findBackward, placeAtBottom,
} from "./historymotions";

// ── State ──────────────────────────────────────────────────────────

export interface HistoryCursor {
  row: number;
  col: number;
}

export function createHistoryCursor(): HistoryCursor {
  return { row: 0, col: 0 };
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Apply a history cursor action to state.
 * Returns true if the action was handled.
 */
export function applyHistoryAction(action: Action, state: RenderState): boolean {
  const lines = state.historyLines;
  const cur = state.historyCursor;

  if (lines.length === 0) return true;

  switch (action) {
    case "history_left":    state.historyCursor = charLeft(cur, lines); break;
    case "history_right":   state.historyCursor = charRight(cur, lines); break;
    case "history_up":      state.historyCursor = lineUp(cur, lines); break;
    case "history_down":    state.historyCursor = lineDown(cur, lines); break;
    case "history_w":       state.historyCursor = wordForward(cur, lines); break;
    case "history_b":       state.historyCursor = wordBackward(cur, lines); break;
    case "history_e":       state.historyCursor = wordEnd(cur, lines); break;
    case "history_W":       state.historyCursor = wordForwardBig(cur, lines); break;
    case "history_B":       state.historyCursor = wordBackwardBig(cur, lines); break;
    case "history_E":       state.historyCursor = wordEndBig(cur, lines); break;
    case "history_0":       state.historyCursor = lineStart(cur, lines); break;
    case "history_dollar":  state.historyCursor = lineEnd(cur, lines); break;
    case "history_gg":      state.historyCursor = bufferStart(lines); break;
    case "history_G":       state.historyCursor = bufferEnd(lines); break;
    case "history_yy":      return true; // caller handles clipboard
    default:                return false;
  }

  ensureCursorVisible(state);
  return true;
}

// ── Cursor-aware scrolling (vim-style) ─────────────────────────────

/**
 * Ctrl+U / Ctrl+D — scroll half page AND move cursor by the same amount.
 * If there aren't enough lines, cursor takes the remainder.
 * `dir`: positive = up, negative = down.
 */
export function scrollHalfPageWithCursor(state: RenderState, dir: number): void {
  const amount = Math.floor(state.layout.messageAreaHeight / 2);
  scrollWithCursor(state, dir * amount);
}

/**
 * Ctrl+B / Ctrl+F — scroll full page AND move cursor by the same amount.
 */
export function scrollFullPageWithCursor(state: RenderState, dir: number): void {
  scrollWithCursor(state, dir * state.layout.messageAreaHeight);
}

/**
 * Scroll viewport and move cursor by `lines` rows.
 * Positive = up (towards older), negative = down (towards newer).
 * Cursor always moves (clamped to buffer bounds), viewport follows.
 */
function scrollWithCursor(state: RenderState, lines: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  // Always move cursor, even if viewport can't scroll further
  const newRow = Math.max(0, Math.min(state.historyCursor.row - lines, totalLines - 1));
  state.historyCursor = clampCursor({ row: newRow, col: state.historyCursor.col }, state.historyLines);

  // Move viewport by same amount (clamped)
  const { messageAreaHeight } = state.layout;
  const maxOff = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + lines, maxOff));

  // Ensure cursor is visible (cursor may have moved past viewport)
  ensureCursorVisible(state);
}

/**
 * Ctrl+E / Ctrl+Y — scroll viewport by 1 line, cursor stays on
 * same BUFFER LINE (sticks to the line). Only moves cursor if
 * it would go off-screen (clamped to nearest visible edge).
 * `dir`: positive = up (Ctrl+Y), negative = down (Ctrl+E).
 */
export function scrollLineWithStickyCursor(state: RenderState, dir: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  const { messageAreaHeight } = state.layout;
  const maxOff = Math.max(0, totalLines - messageAreaHeight);

  // Move viewport only
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + dir, maxOff));

  // Cursor stays on same buffer row — only adjust if off-screen
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
  const viewEnd = viewStart + messageAreaHeight - 1;
  const curRow = state.historyCursor.row;

  if (curRow < viewStart) {
    state.historyCursor = clampCursor(
      { row: viewStart, col: state.historyCursor.col }, state.historyLines,
    );
  } else if (curRow > viewEnd) {
    state.historyCursor = clampCursor(
      { row: viewEnd, col: state.historyCursor.col }, state.historyLines,
    );
  }
}

// ── Find interception for history ────────────────────────────────

/**
 * Handle f/F/;/, for history context. Returns true if the key was a find key
 * and was handled. Returns false if the key is not a find — caller should
 * fall through to the engine.
 */
export function handleHistoryFind(key: KeyEvent, state: RenderState): boolean {
  const vim = state.vim;
  const lines = state.historyLines;

  // Resolve pending find — waiting for the target character
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { vim.pendingFind = null; return true; }
    const dir = vim.pendingFind;
    vim.lastFind = { char: key.char, direction: dir };
    vim.pendingFind = null;
    state.historyCursor = dir === "f"
      ? findForward(state.historyCursor, lines, key.char)
      : findBackward(state.historyCursor, lines, key.char);
    ensureCursorVisible(state);
    return true;
  }

  // Initiate find
  if (key.type === "char" && (key.char === "f" || key.char === "F")) {
    vim.pendingFind = key.char as "f" | "F";
    return true;
  }

  // Repeat last find
  if (key.type === "char" && (key.char === ";" || key.char === ",")) {
    if (!vim.lastFind) return true;
    const dir = key.char === ";"
      ? vim.lastFind.direction
      : (vim.lastFind.direction === "f" ? "F" : "f") as "f" | "F";
    state.historyCursor = dir === "f"
      ? findForward(state.historyCursor, lines, vim.lastFind.char)
      : findBackward(state.historyCursor, lines, vim.lastFind.char);
    ensureCursorVisible(state);
    return true;
  }

  return false;
}

// ── Visual selection extraction ─────────────────────────────────

/** Extract the selected text from history in visual/visual-line mode. */
export function getHistoryVisualSelection(state: RenderState): string {
  const anchor = state.historyVisualAnchor;
  const cursor = state.historyCursor;
  const lines = state.historyLines;

  const startRow = Math.min(anchor.row, cursor.row);
  const endRow = Math.max(anchor.row, cursor.row);

  if (state.vim.mode === "visual-line") {
    const selectedLines: string[] = [];
    for (let r = startRow; r <= endRow; r++) {
      selectedLines.push(stripAnsi(lines[r] ?? "").trim());
    }
    return selectedLines.join("\n");
  }

  // Character visual — single line
  if (startRow === endRow) {
    const plain = stripAnsi(lines[startRow] ?? "");
    const startCol = Math.min(anchor.col, cursor.col);
    const endCol = Math.max(anchor.col, cursor.col);
    return plain.slice(startCol, endCol + 1).trim();
  }

  // Multi-line character selection
  const result: string[] = [];
  const firstPlain = stripAnsi(lines[startRow] ?? "");
  const lastPlain = stripAnsi(lines[endRow] ?? "");
  const firstCol = startRow === anchor.row ? anchor.col : cursor.col;
  const lastCol = endRow === anchor.row ? anchor.col : cursor.col;

  result.push(firstPlain.slice(firstCol).trimEnd());
  for (let r = startRow + 1; r < endRow; r++) {
    result.push(stripAnsi(lines[r] ?? "").trim());
  }
  result.push(lastPlain.slice(0, lastCol + 1).trimStart());

  return result.join("\n");
}

/** Adjust scrollOffset so the cursor row is within the visible message area. */
export function ensureCursorVisible(state: RenderState): void {
  const { totalLines, messageAreaHeight } = state.layout;
  if (totalLines <= messageAreaHeight) {
    state.scrollOffset = 0;
    return;
  }

  const cursorRow = state.historyCursor.row;
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
  const viewEnd = viewStart + messageAreaHeight;

  if (cursorRow < viewStart) {
    state.scrollOffset = totalLines - messageAreaHeight - cursorRow;
  } else if (cursorRow >= viewEnd) {
    state.scrollOffset = totalLines - messageAreaHeight - (cursorRow - messageAreaHeight + 1);
  }

  const maxScroll = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
}
