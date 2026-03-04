/**
 * Layout composition for the Exocortex TUI.
 *
 * Positions all UI components: topbar, sidebar, message area,
 * prompt line, and status line. Each component renders itself —
 * this file only composes them into screen coordinates.
 */

import type { RenderState } from "./state";
import { renderStatusLine, statusLineHeight } from "./statusline";
import { renderTopbar } from "./topbar";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { buildMessageLines } from "./conversation";
import { getInputLines } from "./promptline";
import { show_cursor, hide_cursor, cursor_block, cursor_bar } from "./terminal";
import { theme } from "./theme";

// ── ANSI positioning (non-color escapes) ────────────────────────────

const ESC = "\x1b[";
const clear_line = `${ESC}2K`;
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;
  const out: string[] = [];

  // ── Layout dimensions ─────────────────────────────────────────
  const sidebarOpen = state.sidebar.open;
  const sidebarW = sidebarOpen ? SIDEBAR_WIDTH : 0;
  const chatCol = sidebarW + 1;            // 1-based column where chat starts
  const chatW = Math.max(1, cols - sidebarW); // width available for chat area

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
  const promptLen = 4;   // "N > " or "I > "
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
  const allLines = buildMessageLines(state, chatW);
  const totalLines = allLines.length;

  // Cache layout for scroll functions
  state.layout.totalLines = totalLines;
  state.layout.messageAreaHeight = messageAreaHeight;

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
    const promptGlyph = (i === 0 && !isNewLine[i]) ? ">" : "+";
    const promptStyle = promptFocused ? theme.accent : theme.dim;

    const isFirst = i === 0 && !isNewLine[i];
    const modeChar = state.vim.mode === "normal" ? "N" : "I";
    const modeColor = state.vim.mode === "normal" ? theme.vimNormal : theme.vimInsert;
    const prompt = isFirst
      ? `${modeColor}${modeChar}${theme.reset} ${promptStyle}${promptGlyph}${theme.reset} `
      : `  ${promptStyle}${promptGlyph}${theme.reset} `;

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

  // ── Cursor: visible only when prompt is focused ────────────────
  if (promptFocused) {
    const cursorScreenRow = firstInputRow + cursorLine;
    out.push(move_to(cursorScreenRow, chatCol + promptLen + cursorCol));
    // Vim: block cursor in normal mode, bar cursor in insert mode
    out.push(state.vim.mode === "normal" ? cursor_block : cursor_bar);
    out.push(show_cursor);
  } else {
    out.push(hide_cursor);
  }

  process.stdout.write(out.join(""));
}
