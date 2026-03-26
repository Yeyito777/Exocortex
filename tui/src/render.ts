/**
 * Layout composition for the Exocortex TUI.
 *
 * Positions all UI components: topbar, sidebar, message area,
 * prompt line, and status line. Most components render themselves —
 * this file composes them into screen coordinates and also owns
 * the queue-prompt and edit-message overlay renderers.
 *
 * Caches computed layout values back into state (historyLines,
 * scrollOffset, layout.totalLines, etc.) so that scroll and cursor
 * functions can use them between render passes.
 */

import type { RenderState } from "./state";
import type { ImageAttachment } from "./messages";
import { getViewStart } from "./chat";
import { renderStatusLine } from "./statusline";
import { renderTopbar } from "./topbar";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { buildMessageLines } from "./conversation";
import { getInputLines, wrappedLineOffsets } from "./promptline";
import { show_cursor, hide_cursor, cursor_block, cursor_underline, cursor_bar, applyLineBg } from "./terminal";
import { theme } from "./theme";
import { clampCursor, stripAnsi, contentBounds, logicalLineRange } from "./historycursor";
import { renderLineWithCursor, renderLineWithSelection } from "./cursorrender";
import { highlightPromptInput } from "./prompthighlight";
import { formatSize, imageLabel } from "./clipboard";
import { renderQueuePromptOverlay } from "./overlays";
import { renderEditMessageOverlay } from "./overlays";

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
  offsets: number[],
  isLinewise: boolean,
): string {
  if (wrappedLineIdx >= offsets.length) return line;

  // For linewise: expand selection to full line boundaries in the buffer
  let effStart = selStart;
  let effEnd = selEnd;
  if (isLinewise) {
    const ls = buffer.lastIndexOf("\n", effStart - 1);
    effStart = ls === -1 ? 0 : ls + 1;
    const le = buffer.indexOf("\n", effEnd);
    effEnd = le === -1 ? buffer.length - 1 : le;
  }

  // Use visible length (line may contain ANSI codes from command highlighting)
  const visLen = stripAnsi(line).length;
  const lineStart = offsets[wrappedLineIdx];
  const lineEnd = lineStart + visLen - 1;

  if (effStart <= lineEnd && effEnd >= lineStart) {
    const colStart = isLinewise ? 0 : Math.max(0, effStart - lineStart);
    const colEnd = isLinewise ? visLen - 1 : Math.min(visLen - 1, effEnd - lineStart);
    return renderLineWithSelection(line, colStart, colEnd);
  }

  return line;
}

// ── Image indicator ────────────────────────────────────────────────

function renderImageIndicator(images: ImageAttachment[], width: number): string {
  if (width <= 0 || images.length === 0) return "";

  let label: string;
  if (images.length === 1) {
    const img = images[0];
    label = `📎 Image pasted (${imageLabel(img.mediaType)}, ${formatSize(img.sizeBytes)})`;
  } else {
    const parts = images.map(img =>
      `${imageLabel(img.mediaType)} ${formatSize(img.sizeBytes)}`
    );
    label = `📎 ${images.length} images (${parts.join(", ")})`;
  }

  // Truncate if it doesn't fit (leave room for "│ " + " │")
  const innerWidth = width - 4;
  if (label.length > innerWidth) {
    label = label.slice(0, Math.max(0, innerWidth - 1)) + "…";
  }
  const padding = Math.max(0, innerWidth - label.length);

  return (
    theme.accent + "│" +
    theme.reset + " " + theme.dim + label + " ".repeat(padding) +
    theme.reset + " " + theme.accent + "│" + theme.reset
  );
}

// ── Shared render context ───────────────────────────────────────────

/**
 * Shared rendering primitives computed once in render() and threaded
 * through extracted sub-functions. Avoids long parameter lists.
 */
interface RenderCtx {
  /** Output buffer — sub-functions push ANSI strings here. */
  out: string[];
  /** Clear-line escape pre-filled with app background. */
  cl: string;
  /** Whether the sidebar is currently open. */
  sidebarOpen: boolean;
  /** Pre-rendered sidebar rows (one per screen row). */
  sbRows: string[];
  /** 1-based column where the chat area starts (after sidebar). */
  chatCol: number;
  /** Apply app background to a line (identity when no appBg). */
  bgLine: (line: string) => string;
}

/** Emit a sidebar column for the given screen row (if sidebar is open). */
function emitSidebarCol(ctx: RenderCtx, screenRow: number): void {
  if (ctx.sidebarOpen && ctx.sbRows[screenRow - 1]) {
    ctx.out.push(ctx.sbRows[screenRow - 1]);
  }
}

// ── Extracted sub-functions ──────────────────────────────────────────

/**
 * Render the scrollable message/history area (rows 3 to sepAbove-1).
 * Handles visual selection highlighting, normal-mode line highlight,
 * and history cursor rendering.
 */
function renderMessageArea(
  ctx: RenderCtx,
  allLines: string[],
  totalLines: number,
  viewStart: number,
  messageAreaStart: number,
  messageAreaHeight: number,
  historyFocused: boolean,
  inVisual: boolean,
  vimMode: string,
  vAnchor: { row: number; col: number },
  vCursor: { row: number; col: number },
  vStartRow: number,
  vEndRow: number,
  hlFirst: number,
  hlLast: number,
): void {
  const { out, cl, chatCol, bgLine } = ctx;

  for (let i = 0; i < messageAreaHeight; i++) {
    const row = messageAreaStart + i;
    out.push(move_to(row, 1) + cl);
    emitSidebarCol(ctx, row);
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

        if (vimMode === "visual-line") {
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
        if (lineIdx === vCursor.row) {
          rendered = renderLineWithCursor(rendered, vCursor.col);
        }
        out.push(bgLine(rendered));
      } else if (historyFocused && lineIdx >= hlFirst && lineIdx <= hlLast) {
        // Normal mode: highlight the full logical line group
        if (lineIdx === vCursor.row) {
          const withCursor = renderLineWithCursor(line, vCursor.col);
          out.push(applyLineBg(withCursor, theme.historyLineBg));
        } else {
          out.push(applyLineBg(line, theme.historyLineBg));
        }
      } else {
        out.push(bgLine(line));
      }
    }
  }
}

/**
 * Render the autocomplete popup overlay above the input area.
 * Floats over the message area when the autocomplete state is active.
 */
function renderAutocompletePopup(
  ctx: RenderCtx,
  state: RenderState,
  chatW: number,
  sepAbove: number,
): void {
  if (!state.autocomplete || state.autocomplete.matches.length === 0) return;

  const { out, chatCol } = ctx;
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

/**
 * Render the prompt input rows (mode indicator, prompt glyph, and
 * syntax-highlighted input text with optional visual selection).
 */
function renderInputArea(
  ctx: RenderCtx,
  state: RenderState,
  inputRowCount: number,
  firstInputRow: number,
  coloredInputLines: string[],
  isNewLine: boolean[],
  maxInputWidth: number,
  newPromptScroll: number,
  promptFocused: boolean,
): void {
  const { out, cl, chatCol, bgLine } = ctx;
  const promptInVisual = promptFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");
  // Compute once for all visual-selection calls inside the loop
  const inputOffsets = promptInVisual ? wrappedLineOffsets(state.inputBuffer, maxInputWidth) : [];

  for (let i = 0; i < inputRowCount; i++) {
    const row = firstInputRow + i;
    const promptStyle = promptFocused ? theme.accent : theme.dim;

    const isFirst = i === 0 && !isNewLine[i];
    const promptGlyph = isFirst ? ">" : "+";
    const modeChar = (state.vim.mode === "visual" || state.vim.mode === "visual-line") ? "V"
      : state.vim.mode === "normal" ? "N"
        : "I";
    const modeColor = (state.vim.mode === "visual" || state.vim.mode === "visual-line")
      ? theme.vimVisual
      : state.vim.mode === "normal" ? theme.vimNormal : theme.vimInsert;
    const prompt = isFirst
      ? `${modeColor}${modeChar}${theme.reset} ${promptStyle}${promptGlyph}${theme.reset} `
      : `  ${promptStyle}${promptGlyph}${theme.reset} `;

    let lineContent = coloredInputLines[i];
    if (promptInVisual) {
      // Apply selection highlight to prompt input line (works on ANSI-colored text)
      const selStart = Math.min(state.vim.visualAnchor, state.cursorPos);
      const selEnd = Math.max(state.vim.visualAnchor, state.cursorPos);
      lineContent = highlightPromptLine(lineContent, newPromptScroll + i, selStart, selEnd,
        state.inputBuffer, inputOffsets, state.vim.mode === "visual-line");
    }

    out.push(move_to(row, 1) + cl);
    emitSidebarCol(ctx, row);
    out.push(move_to(row, chatCol) + bgLine(prompt + lineContent));
  }
}

/**
 * Position the terminal cursor and set its shape based on the current
 * focus and vim mode. Hides the cursor when history is focused (the
 * history cursor is rendered inline via reverse video).
 */
function renderCursorPosition(
  ctx: RenderCtx,
  state: RenderState,
  promptFocused: boolean,
  firstInputRow: number,
  cursorLine: number,
  cursorCol: number,
  promptLen: number,
): void {
  const { out, chatCol } = ctx;
  if (promptFocused) {
    const cursorScreenRow = firstInputRow + cursorLine;
    out.push(move_to(cursorScreenRow, chatCol + promptLen + cursorCol));
    // Vim: block cursor in normal mode, bar cursor in insert mode
    out.push(
      state.vim.mode === "insert" ? cursor_bar
        : (state.vim.pendingOperator || state.vim.pendingReplace) ? cursor_underline
        : cursor_block,
    );
    out.push(show_cursor);
  } else {
    // History cursor is rendered inline (reverse video) — hide hardware cursor
    out.push(hide_cursor);
  }
}

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;
  const out: string[] = [];

  // App-wide background: fills empty areas and persists through resets
  const appBg = theme.appBg ?? '';
  const cl = appBg + clear_line;      // clear_line pre-filled with app bg
  const bgLine = appBg
    ? (line: string) => applyLineBg(line, appBg)
    : (line: string) => line;

  // ── Layout dimensions ─────────────────────────────────────────
  const sidebarOpen = state.sidebar.open;
  const sidebarW = sidebarOpen ? SIDEBAR_WIDTH : 0;
  const chatCol = sidebarW + 1;            // 1-based column where chat starts
  const chatW = Math.max(1, cols - sidebarW); // width available for chat area

  // ── Pre-render sidebar ────────────────────────────────────────
  let sbRows: string[] = [];
  if (sidebarOpen) {
    sbRows = renderSidebar(
      state.sidebar,
      rows,
      state.panelFocus === "sidebar",
      state.convId,
    );
  }

  // ── Shared render context ─────────────────────────────────────
  const ctx: RenderCtx = { out, cl, sidebarOpen, sbRows, chatCol, bgLine };

  // ── Top bar (row 1, full width) ───────────────────────────────
  out.push(move_to(1, 1) + cl);
  if (sidebarOpen) {
    out.push(sbRows[0]);
    out.push(move_to(1, chatCol));
  }
  out.push(renderTopbar(state, chatW));

  // ── Row 2: separator ──────────────────────────────────────────
  const historyFocused = state.panelFocus === "chat" && state.chatFocus === "history";
  const historyColor = historyFocused ? theme.accent : theme.dim;
  out.push(move_to(2, 1) + cl);
  if (sidebarOpen) {
    out.push(sbRows[1]);
    out.push(move_to(2, chatCol));
  }
  out.push(bgLine(`${historyColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Input line wrapping ────────────────────────────────────────
  const promptLen = 4;   // "N > " or "I > "
  const maxInputWidth = chatW - promptLen;
  const maxInputRows = Math.min(10, Math.floor((rows - 6) / 2));

  const { lines: inputLines, isNewLine, cursorLine, cursorCol, scrollOffset: newPromptScroll } =
    getInputLines(state.inputBuffer, state.cursorPos, maxInputWidth, maxInputRows, state.promptScrollOffset);
  state.promptScrollOffset = newPromptScroll;

  // Syntax-highlight valid commands and macros in the input lines
  const coloredInputLines = highlightPromptInput(inputLines, state.inputBuffer, maxInputWidth, newPromptScroll);

  const inputRowCount = inputLines.length;

  // ── Bottom layout: sep | [imageIndicator] | input rows | sep | status
  const statusResult = renderStatusLine(state, chatW);
  const slHeight = statusResult.height;
  const statusLines = statusResult.lines;
  const imageIndicatorRows = state.pendingImages.length > 0 ? 1 : 0;
  const bottomUsed = 1 + imageIndicatorRows + inputRowCount + 1 + slHeight;
  const sepAbove = rows - bottomUsed + 1;
  const firstInputRow = sepAbove + 1 + imageIndicatorRows;
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

  // Cache layout for scroll and mouse functions
  state.layout.totalLines = totalLines;
  state.layout.messageAreaHeight = messageAreaHeight;
  state.layout.chatCol = chatCol;
  state.layout.sepAbove = sepAbove;
  state.layout.firstInputRow = firstInputRow;
  state.layout.sepBelow = sepBelow;

  const viewStart = getViewStart(state);

  // Compute visual selection range if in visual mode
  const inVisual = historyFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");
  const vAnchor = state.historyVisualAnchor;
  const vCursor = state.historyCursor;
  let vStartRow = inVisual ? Math.min(vAnchor.row, vCursor.row) : -1;
  let vEndRow = inVisual ? Math.max(vAnchor.row, vCursor.row) : -1;

  // Visual-line: expand to full logical line groups
  if (state.vim.mode === "visual-line" && inVisual && wrapContinuation.length > 0) {
    vStartRow = logicalLineRange(vStartRow, wrapContinuation).first;
    vEndRow = logicalLineRange(vEndRow, wrapContinuation).last;
  }

  // Normal-mode line highlight: all visual rows of the cursor's logical line
  let hlFirst = -1;
  let hlLast = -1;
  if (historyFocused && !inVisual && wrapContinuation.length > 0) {
    const range = logicalLineRange(state.historyCursor.row, wrapContinuation);
    hlFirst = range.first;
    hlLast = range.last;
  }

  renderMessageArea(
    ctx, allLines, totalLines, viewStart,
    messageAreaStart, messageAreaHeight,
    historyFocused, inVisual, state.vim.mode,
    vAnchor, vCursor, vStartRow, vEndRow,
    hlFirst, hlLast,
  );

  // ── Autocomplete popup (overlays message area above input) ────
  renderAutocompletePopup(ctx, state, chatW, sepAbove);

  // ── Separator above input ─────────────────────────────────────
  out.push(move_to(sepAbove, 1) + cl);
  emitSidebarCol(ctx, sepAbove);
  out.push(move_to(sepAbove, chatCol) + bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Image indicator (between separator and prompt) ────────────
  if (imageIndicatorRows > 0) {
    const indRow = sepAbove + 1;
    out.push(move_to(indRow, 1) + cl);
    emitSidebarCol(ctx, indRow);
    out.push(move_to(indRow, chatCol) + bgLine(renderImageIndicator(state.pendingImages, chatW)));
  }

  // ── Input rows ────────────────────────────────────────────────
  renderInputArea(
    ctx, state, inputRowCount, firstInputRow,
    coloredInputLines, isNewLine, maxInputWidth, newPromptScroll,
    promptFocused,
  );

  // ── Separator below input ─────────────────────────────────────
  out.push(move_to(sepBelow, 1) + cl);
  emitSidebarCol(ctx, sepBelow);
  out.push(move_to(sepBelow, chatCol) + bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Status lines (chat area width) ─────────────────────────────
  for (let i = 0; i < slHeight; i++) {
    const row = sepBelow + 1 + i;
    out.push(move_to(row, 1) + cl);
    emitSidebarCol(ctx, row);
    out.push(move_to(row, chatCol) + bgLine(statusLines[i]));
  }

  // ── Queue prompt overlay ───────────────────────────────────────
  if (state.queuePrompt) {
    out.push(renderQueuePromptOverlay(state.queuePrompt, chatW, chatCol, sepAbove));
  }

  // ── Edit message overlay ──────────────────────────────────────
  if (state.editMessagePrompt) {
    out.push(renderEditMessageOverlay(state.editMessagePrompt, chatW, chatCol, sepAbove, messageAreaHeight));
  }

  // ── Cursor ─────────────────────────────────────────────────────
  renderCursorPosition(ctx, state, promptFocused, firstInputRow, cursorLine, cursorCol, promptLen);

  process.stdout.write(out.join(""));
}
