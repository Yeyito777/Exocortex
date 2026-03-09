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
import { show_cursor, hide_cursor, cursor_block, cursor_underline, cursor_bar, applyLineBg } from "./terminal";
import { theme } from "./theme";
import { clampCursor, stripAnsi, contentBounds } from "./historycursor";
import { renderLineWithCursor, renderLineWithSelection } from "./cursorrender";

// ── ANSI positioning (non-color escapes) ────────────────────────────

const ESC = "\x1b[";
const clear_line = `${ESC}2K`;
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

// ── Main render ─────────────────────────────────────────────────────

/**
 * Apply visual selection highlighting to a prompt input line.
 * Maps buffer-level selection range to columns within a wrapped line.
 */
function highlightPromptLine(
  line: string,
  wrappedLineIdx: number,
  selStart: number,
  selEnd: number,
  buffer: string,
  maxWidth: number,
  isLinewise: boolean,
): string {
  // For linewise: expand selection to full line boundaries in the buffer
  let effStart = selStart;
  let effEnd = selEnd;
  if (isLinewise) {
    // Find start of line containing selStart
    const ls = buffer.lastIndexOf("\n", effStart - 1);
    effStart = ls === -1 ? 0 : ls + 1;
    // Find end of line containing selEnd
    const le = buffer.indexOf("\n", effEnd);
    effEnd = le === -1 ? buffer.length - 1 : le;
  }

  // Compute the buffer offset for this wrapped line
  const bufferLines = buffer.split("\n");
  let offset = 0;
  let wrappedIdx = 0;

  for (const bLine of bufferLines) {
    const chunks = bLine.length <= maxWidth ? 1 : Math.ceil(bLine.length / maxWidth);
    if (wrappedLineIdx < wrappedIdx + chunks) {
      // This wrapped line is within this buffer line
      const chunkIdx = wrappedLineIdx - wrappedIdx;
      const lineStart = offset + chunkIdx * maxWidth;
      const lineEnd = lineStart + line.length - 1;

      if (effStart <= lineEnd && effEnd >= lineStart) {
        const colStart = isLinewise ? 0 : Math.max(0, effStart - lineStart);
        const colEnd = isLinewise ? line.length - 1 : Math.min(line.length - 1, effEnd - lineStart);
        return renderLineWithSelection(line, colStart, colEnd);
      }
      return line;
    }
    wrappedIdx += chunks;
    offset += bLine.length + 1;
  }

  return line;
}

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

  const { lines: inputLines, isNewLine, cursorLine, cursorCol, scrollOffset: newPromptScroll } =
    getInputLines(state.inputBuffer, state.cursorPos, maxInputWidth, maxInputRows, state.promptScrollOffset);
  state.promptScrollOffset = newPromptScroll;

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
  const { lines: allLines, messageBounds, wrapContinuation } = buildMessageLines(state, chatW);
  const totalLines = allLines.length;

  // Cache rendered lines and message bounds for history cursor navigation
  state.historyLines = allLines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyMessageBounds = messageBounds;
  state.historyCursor = clampCursor(state.historyCursor, allLines);

  // Pin scroll position: if user is scrolled up and content changes,
  // adjust offset so the viewport stays on the same content.
  const prevTotal = state.layout.totalLines;
  if (state.scrollOffset > 0 && prevTotal > 0 && totalLines !== prevTotal) {
    state.scrollOffset = Math.max(0, state.scrollOffset + (totalLines - prevTotal));
  }

  // Cache layout for scroll functions
  state.layout.totalLines = totalLines;
  state.layout.messageAreaHeight = messageAreaHeight;

  let viewStart: number;
  if (state.scrollOffset === 0) {
    viewStart = Math.max(0, totalLines - messageAreaHeight);
  } else {
    viewStart = Math.max(0, totalLines - messageAreaHeight - state.scrollOffset);
  }

  // Compute visual selection range if in visual mode
  const inVisual = historyFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");
  const vAnchor = state.historyVisualAnchor;
  const vCursor = state.historyCursor;
  const vStartRow = inVisual ? Math.min(vAnchor.row, vCursor.row) : -1;
  const vEndRow = inVisual ? Math.max(vAnchor.row, vCursor.row) : -1;

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
      const line = allLines[lineIdx];

      if (inVisual && lineIdx >= vStartRow && lineIdx <= vEndRow) {
        // This line is part of the visual selection — text-bound highlight
        const plain = stripAnsi(line);
        const bounds = contentBounds(plain);
        let startCol: number;
        let endCol: number;

        if (state.vim.mode === "visual-line") {
          // Line mode: highlight content bounds (not full terminal width)
          startCol = bounds.start;
          endCol = bounds.end;
        } else if (vStartRow === vEndRow) {
          // Single-line character selection
          startCol = Math.min(vAnchor.col, vCursor.col);
          endCol = Math.max(vAnchor.col, vCursor.col);
        } else if (lineIdx === vStartRow) {
          const anchorIsStart = vAnchor.row <= vCursor.row;
          startCol = anchorIsStart ? vAnchor.col : vCursor.col;
          endCol = bounds.end;
        } else if (lineIdx === vEndRow) {
          const anchorIsStart = vAnchor.row <= vCursor.row;
          startCol = bounds.start;
          endCol = anchorIsStart ? vCursor.col : vAnchor.col;
        } else {
          // Middle lines: full content bounds
          startCol = bounds.start;
          endCol = bounds.end;
        }

        let rendered = renderLineWithSelection(line, startCol, endCol);
        // Cursor overlay on cursor row
        if (lineIdx === state.historyCursor.row) {
          rendered = renderLineWithCursor(rendered, state.historyCursor.col);
        }
        out.push(rendered);
      } else if (historyFocused && lineIdx === state.historyCursor.row) {
        const withCursor = renderLineWithCursor(line, state.historyCursor.col);
        out.push(applyLineBg(withCursor, theme.historyLineBg));
      } else {
        out.push(line);
      }
    }
  }

  // ── Autocomplete popup (overlays message area above input) ────
  if (state.autocomplete && state.autocomplete.matches.length > 0) {
    const { matches, selection: sel } = state.autocomplete;
    const maxName = matches.reduce((m, c) => Math.max(m, c.name.length), 0);
    const maxDesc = matches.reduce((m, c) => Math.max(m, c.desc.length), 0);
    const popupWidth = Math.min(maxName + maxDesc + 6, chatW - 2);
    const nameWidth = maxName + 1;
    const descWidth = popupWidth - nameWidth - 4;

    const maxVisible = Math.max(1, sepAbove - 3);
    const total = matches.length;
    const winSize = Math.min(total, maxVisible);
    let winStart = 0;

    if (total > maxVisible && sel >= 0) {
      const ideal = sel - Math.floor(winSize / 2);
      winStart = Math.max(0, Math.min(ideal, total - winSize));
    }

    const topRow = sepAbove - winSize;
    for (let vi = 0; vi < winSize; vi++) {
      const i = winStart + vi;
      const row = topRow + vi;
      const isSelected = sel === i;
      const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
      const marker = isSelected ? "▸ " : "  ";
      const name = matches[i].name.padEnd(nameWidth);
      const desc = matches[i].desc.slice(0, descWidth).padEnd(descWidth);
      out.push(
        move_to(row, chatCol) + bg + theme.accent + marker
        + theme.text + name + theme.dim + desc + theme.reset,
      );
    }

    // Scroll indicators when items are clipped
    if (winStart > 0) {
      out.push(
        move_to(topRow, chatCol + popupWidth - 2)
        + theme.sidebarBg + theme.dim + " ▲" + theme.reset,
      );
    }
    if (winStart + winSize < total) {
      out.push(
        move_to(topRow + winSize - 1, chatCol + popupWidth - 2)
        + theme.sidebarBg + theme.dim + " ▼" + theme.reset,
      );
    }
  }

  // ── Separator above input ─────────────────────────────────────
  out.push(move_to(sepAbove, 1) + clear_line);
  if (sidebarOpen && sbRows[sepAbove - 1]) {
    out.push(sbRows[sepAbove - 1]);
  }
  out.push(move_to(sepAbove, chatCol) + `${promptColor}${"─".repeat(chatW)}${theme.reset}`);

  // ── Input rows ────────────────────────────────────────────────
  const promptInVisual = promptFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");

  for (let i = 0; i < inputRowCount; i++) {
    const row = firstInputRow + i;
    const promptGlyph = (i === 0 && !isNewLine[i]) ? ">" : "+";
    const promptStyle = promptFocused ? theme.accent : theme.dim;

    const isFirst = i === 0 && !isNewLine[i];
    const modeChar = (state.vim.mode === "visual" || state.vim.mode === "visual-line") ? "V"
      : state.vim.mode === "normal" ? "N" : "I";
    const modeColor = (state.vim.mode === "visual" || state.vim.mode === "visual-line")
      ? theme.vimVisual
      : state.vim.mode === "normal" ? theme.vimNormal : theme.vimInsert;
    const prompt = isFirst
      ? `${modeColor}${modeChar}${theme.reset} ${promptStyle}${promptGlyph}${theme.reset} `
      : `  ${promptStyle}${promptGlyph}${theme.reset} `;

    let lineContent = inputLines[i];
    if (promptInVisual) {
      // Apply selection highlight to prompt input line
      const selStart = Math.min(state.vim.visualAnchor, state.cursorPos);
      const selEnd = Math.max(state.vim.visualAnchor, state.cursorPos);
      lineContent = highlightPromptLine(lineContent, i, selStart, selEnd,
        state.inputBuffer, maxInputWidth, state.vim.mode === "visual-line");
    }

    out.push(move_to(row, 1) + clear_line);
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
    out.push(move_to(row, chatCol) + prompt + lineContent);
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

  // ── Cursor ─────────────────────────────────────────────────────
  if (promptFocused) {
    const cursorScreenRow = firstInputRow + cursorLine;
    out.push(move_to(cursorScreenRow, chatCol + promptLen + cursorCol));
    // Vim: block cursor in normal mode, bar cursor in insert mode
    out.push(
      state.vim.mode === "insert" ? cursor_bar
        : state.vim.pendingOperator ? cursor_underline
        : cursor_block,
    );
    out.push(show_cursor);
  } else {
    // History cursor is rendered inline (reverse video) — hide hardware cursor
    out.push(hide_cursor);
  }

  process.stdout.write(out.join(""));
}
