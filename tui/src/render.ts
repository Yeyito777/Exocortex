/**
 * Terminal rendering for the Exocortex TUI.
 *
 * Draws the UI: header, messages (with blocks), and input prompt.
 * Uses ANSI escape codes for cursor positioning and colors.
 */

import { isStreaming, type RenderState } from "./state";
import { renderStatusLine, statusLineHeight } from "./statusline";
import { renderTopbar } from "./topbar";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { buildMessageLines } from "./conversation";
import { theme } from "./theme";

// ── ANSI helpers (non-color escapes — not theme-dependent) ──────────

const ESC = "\x1b[";

export const hide_cursor = `${ESC}?25l`;
export const show_cursor = `${ESC}?25h`;
export const enter_alt = `${ESC}?1049h`;
export const leave_alt = `${ESC}?1049l`;
export const clear_screen = `${ESC}2J${ESC}H`;
const clear_line = `${ESC}2K`;
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

// ── Input line wrapping (vim-style hard wrap) ───────────────────────

interface InputLinesResult {
  /** Visible lines after wrapping + scroll. */
  lines: string[];
  /** true if this wrapped line starts a new buffer line (after a \n). */
  isNewLine: boolean[];
  /** Cursor row within the visible lines. */
  cursorLine: number;
  /** Cursor column within its visible line. */
  cursorCol: number;
}

/**
 * Split the input buffer into display lines with hard-wrapping.
 * Long lines are broken at maxWidth (vim-style, no word boundaries).
 * Returns the visible slice (scrolled to keep cursor in view)
 * plus cursor position within that slice.
 */
function getInputLines(
  buffer: string,
  cursorPos: number,
  maxWidth: number,
  maxRows: number,
): InputLinesResult {
  const bufferLines = buffer.split("\n");
  const wrapped: string[] = [];
  const isNewLineArr: boolean[] = [];

  // Track which wrapped line the cursor falls on
  let cursorWrappedLine = 0;
  let cursorColInLine = 0;
  let bufOffset = 0;

  for (let li = 0; li < bufferLines.length; li++) {
    const line = bufferLines[li];

    if (line.length <= maxWidth) {
      // Cursor within this line?
      if (cursorPos >= bufOffset && cursorPos <= bufOffset + line.length) {
        cursorWrappedLine = wrapped.length;
        cursorColInLine = cursorPos - bufOffset;
      }
      wrapped.push(line);
      isNewLineArr.push(li > 0);
    } else {
      // Hard-wrap into chunks of maxWidth
      for (let i = 0; i < line.length; i += maxWidth) {
        const chunk = line.slice(i, i + maxWidth);
        // Cursor within this chunk?
        const chunkStart = bufOffset + i;
        const chunkEnd = chunkStart + chunk.length;
        if (cursorPos >= chunkStart && cursorPos <= chunkEnd) {
          cursorWrappedLine = wrapped.length;
          cursorColInLine = cursorPos - chunkStart;
        }
        wrapped.push(chunk);
        isNewLineArr.push(li > 0 && i === 0);
      }
    }

    bufOffset += line.length + 1; // +1 for the \n
  }

  // Ensure at least one line
  if (wrapped.length === 0) {
    wrapped.push("");
    isNewLineArr.push(false);
  }

  // Cursor at the right edge of a full-width line → drop to col 0 of next line
  if (cursorColInLine >= maxWidth) {
    cursorWrappedLine++;
    cursorColInLine = 0;
    // If there's no next line yet, insert an empty continuation line
    if (cursorWrappedLine >= wrapped.length) {
      wrapped.splice(cursorWrappedLine, 0, "");
      isNewLineArr.splice(cursorWrappedLine, 0, false);
    }
  }

  // Scroll to keep cursor visible
  if (wrapped.length <= maxRows) {
    return {
      lines: wrapped,
      isNewLine: isNewLineArr,
      cursorLine: cursorWrappedLine,
      cursorCol: cursorColInLine,
    };
  }

  // Cursor-following scroll
  let scrollStart = Math.max(0, cursorWrappedLine - maxRows + 1);
  // Don't scroll past the end
  scrollStart = Math.min(scrollStart, wrapped.length - maxRows);

  return {
    lines: wrapped.slice(scrollStart, scrollStart + maxRows),
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
  };
}

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;
  const out: string[] = [];

  // ── Layout dimensions ─────────────────────────────────────────
  const sidebarOpen = state.sidebar.open;
  const sidebarW = sidebarOpen ? SIDEBAR_WIDTH : 0;
  const chatCol = sidebarW + 1;            // 1-based column where chat starts
  const chatW = cols - sidebarW;           // width available for chat area

  // ── Pre-render sidebar ────────────────────────────────────────
  // renderSidebar returns one row per screen row: header, separator,
  // then list entries. Each row includes the right border │.
  let sbRows: string[] = [];
  if (sidebarOpen) {
    sbRows = renderSidebar(
      state.sidebar,
      rows,
      state.panelFocus === "sidebar",
      state.convId,
    );
  }

  // ── Top bar (row 1, full width) ───────────────────────────────
  out.push(move_to(1, 1) + clear_line);
  if (sidebarOpen) {
    out.push(sbRows[0]);
    // Chat portion of topbar starts at chatCol
    out.push(move_to(1, chatCol));
  }
  out.push(renderTopbar(state, chatW));

  // ── Row 2: separator ──────────────────────────────────────────
  const historyFocused = state.panelFocus === "chat" && state.chatFocus === "history";
  const historyColor = historyFocused ? theme.accent : theme.dim;
  out.push(move_to(2, 1) + clear_line);
  if (sidebarOpen) {
    out.push(sbRows[1]);
    out.push(move_to(2, chatCol));
  }
  out.push(`${historyColor}${"─".repeat(chatW)}${theme.reset}`);

  // ── Input line wrapping ────────────────────────────────────────
  const promptLen = 3;
  const maxInputWidth = chatW - promptLen;
  const maxInputRows = Math.min(10, Math.floor((rows - 6) / 2));

  const { lines: inputLines, isNewLine, cursorLine, cursorCol } =
    getInputLines(state.inputBuffer, state.cursorPos, maxInputWidth, maxInputRows);

  const inputRowCount = inputLines.length;

  // ── Bottom layout: sep | input rows | sep | status ────────────
  const slHeight = statusLineHeight(state, chatW);
  const statusLines = renderStatusLine(state, chatW);
  const bottomUsed = 1 + inputRowCount + 1 + slHeight;
  const sepAbove = rows - bottomUsed + 1;
  const firstInputRow = sepAbove + 1;
  const sepBelow = firstInputRow + inputRowCount;

  // Prompt separator
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";
  const promptColor = promptFocused ? theme.accent : theme.dim;

  // ── Message area (rows 3 to sepAbove-1) ────────────────────────
  const messageAreaStart = 3;
  const messageAreaHeight = sepAbove - messageAreaStart;
  const allLines = buildMessageLines(state);
  const totalLines = allLines.length;

  let viewStart: number;
  if (state.scrollOffset === 0) {
    viewStart = Math.max(0, totalLines - messageAreaHeight);
  } else {
    viewStart = Math.max(0, totalLines - messageAreaHeight - state.scrollOffset);
  }

  for (let i = 0; i < messageAreaHeight; i++) {
    const row = messageAreaStart + i;
    out.push(move_to(row, 1) + clear_line);
    // Sidebar column (if open)
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
    // Chat content at chatCol
    out.push(move_to(row, chatCol));
    const lineIdx = viewStart + i;
    if (lineIdx < totalLines) {
      out.push(allLines[lineIdx]);
    }
  }

  // ── Separator above input ─────────────────────────────────────
  out.push(move_to(sepAbove, 1) + clear_line);
  if (sidebarOpen && sbRows[sepAbove - 1]) {
    out.push(sbRows[sepAbove - 1]);
  }
  out.push(move_to(sepAbove, chatCol) + `${promptColor}${"─".repeat(chatW)}${theme.reset}`);

  // ── Input rows ────────────────────────────────────────────────
  for (let i = 0; i < inputRowCount; i++) {
    const row = firstInputRow + i;
    const prompt = (i === 0 && !isNewLine[i])
      ? `${theme.bold}${theme.prompt} ❯${theme.reset} `
      : `${theme.dim} +${theme.reset} `;
    out.push(move_to(row, 1) + clear_line);
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
    out.push(move_to(row, chatCol) + prompt + inputLines[i]);
  }

  // ── Separator below input ─────────────────────────────────────
  out.push(move_to(sepBelow, 1) + clear_line);
  if (sidebarOpen && sbRows[sepBelow - 1]) {
    out.push(sbRows[sepBelow - 1]);
  }
  out.push(move_to(sepBelow, chatCol) + `${promptColor}${"─".repeat(chatW)}${theme.reset}`);

  // ── Status lines (chat area width) ─────────────────────────────
  for (let i = 0; i < slHeight; i++) {
    const row = sepBelow + 1 + i;
    out.push(move_to(row, 1) + clear_line);
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
    out.push(move_to(row, chatCol) + statusLines[i]);
  }

  // ── Position cursor in input field ────────────────────────────
  const cursorScreenRow = firstInputRow + cursorLine;
  out.push(move_to(cursorScreenRow, chatCol + promptLen + cursorCol));
  out.push(show_cursor);

  process.stdout.write(out.join(""));
}
