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
import { getViewStart } from "./chatscroll";
import { renderTopbar } from "./topbar";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { getSidebarSearchBarViewport } from "./sidebarsearch";
import { buildMessageLines, type BuildMessageLinesResult } from "./conversation";
import { wrappedLineOffsets } from "./promptline";
import { computeBottomLayout, PROMPT_PREFIX_WIDTH } from "./chatlayout";
import { show_cursor, hide_cursor, cursor_block, cursor_underline, cursor_bar, applyLineBg } from "./terminal";
import { theme } from "./theme";
import { clampCursor, stripAnsi, contentBounds, logicalLineRange } from "./historycursor";
import { renderLineWithCursor, renderLineWithSearch, renderLineWithSelection } from "./cursorrender";
import { highlightPromptInput } from "./prompthighlight";
import { formatSize, imageLabel } from "./clipboard";
import { renderQueuePromptOverlay } from "./overlays";
import { renderEditMessageOverlay } from "./overlays";
import { findSearchMatches, getActiveSearchQuery, getSearchBarViewport } from "./search";
import { padRightToWidth, termWidth } from "./textwidth";
import {
  appendPositionedPayload as appendFramePositionedPayload,
  appendRowWrite as appendFrameRowWrite,
  clearLine,
  createFrameRows,
  flushFrame,
  moveTo,
} from "./frame";

interface HistoryRenderCacheEntry {
  width: number;
  convId: string | null;
  messagesRef: RenderState["messages"];
  messageCount: number;
  queuedMessagesRef: RenderState["queuedMessages"];
  queuedMessageCount: number;
  streamingTailRef: RenderState["streamingTailMessages"];
  streamingTailCount: number;
  showToolOutput: boolean;
  toolRegistryRef: RenderState["toolRegistry"];
  externalToolStylesRef: RenderState["externalToolStyles"];
  themeName: string;
  result: BuildMessageLinesResult;
}

const historyRenderCache = new WeakMap<RenderState, HistoryRenderCacheEntry>();

function canReuseHistoryRender(cached: HistoryRenderCacheEntry, state: RenderState, width: number): boolean {
  return cached.width === width
    && cached.convId === state.convId
    && cached.messagesRef === state.messages
    && cached.messageCount === state.messages.length
    && cached.queuedMessagesRef === state.queuedMessages
    && cached.queuedMessageCount === state.queuedMessages.length
    && cached.streamingTailRef === state.streamingTailMessages
    && cached.streamingTailCount === state.streamingTailMessages.length
    && cached.showToolOutput === state.showToolOutput
    && cached.toolRegistryRef === state.toolRegistry
    && cached.externalToolStylesRef === state.externalToolStyles
    && cached.themeName === theme.name;
}

function getHistoryRender(state: RenderState, width: number): BuildMessageLinesResult {
  if (state.pendingAI) {
    historyRenderCache.delete(state);
    return buildMessageLines(state, width);
  }

  const cached = historyRenderCache.get(state);
  if (cached && canReuseHistoryRender(cached, state, width)) {
    return cached.result;
  }

  const result = buildMessageLines(state, width);
  historyRenderCache.set(state, {
    width,
    convId: state.convId,
    messagesRef: state.messages,
    messageCount: state.messages.length,
    queuedMessagesRef: state.queuedMessages,
    queuedMessageCount: state.queuedMessages.length,
    streamingTailRef: state.streamingTailMessages,
    streamingTailCount: state.streamingTailMessages.length,
    showToolOutput: state.showToolOutput,
    toolRegistryRef: state.toolRegistry,
    externalToolStylesRef: state.externalToolStyles,
    themeName: theme.name,
    result,
  });
  return result;
}

export function invalidateHistoryRenderCache(state: RenderState): void {
  historyRenderCache.delete(state);
}

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

function colorPlainPromptRange(
  line: string,
  wrappedLineIdx: number,
  rangeStart: number,
  rangeEndExclusive: number,
  offsets: number[],
  color: string,
): string {
  if (wrappedLineIdx >= offsets.length) return line;
  const lineStart = offsets[wrappedLineIdx];
  const lineEndExclusive = lineStart + line.length;
  const overlapStart = Math.max(rangeStart, lineStart);
  const overlapEndExclusive = Math.min(rangeEndExclusive, lineEndExclusive);
  if (overlapStart >= overlapEndExclusive) return line;

  const relStart = overlapStart - lineStart;
  const relEnd = overlapEndExclusive - lineStart;
  return line.slice(0, relStart)
    + color + line.slice(relStart, relEnd) + theme.reset
    + line.slice(relEnd);
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
  /** Per-screen-row ANSI payloads. Each payload fully redraws that row. */
  frameRows: string[];
  /** Whether the sidebar is currently open. */
  sidebarOpen: boolean;
  /** Pre-rendered sidebar rows (one per screen row). */
  sbRows: string[];
  /** 1-based column where the chat area starts (after sidebar). */
  chatCol: number;
  /** Apply app background to a line (identity when no appBg). */
  bgLine: (line: string) => string;
}

function appendRowWrite(ctx: RenderCtx, row: number, col: number, text: string): void {
  appendFrameRowWrite(ctx.frameRows, row, col, text);
}

function appendPositionedPayload(ctx: RenderCtx, payload: string): void {
  appendFramePositionedPayload(ctx.frameRows, payload);
}

/** Emit a sidebar column for the given screen row (if sidebar is open). */
function emitSidebarCol(ctx: RenderCtx, screenRow: number): void {
  if (ctx.sidebarOpen && ctx.sbRows[screenRow - 1]) {
    appendRowWrite(ctx, screenRow, 1, ctx.sbRows[screenRow - 1]);
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
  searchQuery: string | null,
): void {
  const { chatCol, bgLine } = ctx;

  for (let i = 0; i < messageAreaHeight; i++) {
    const row = messageAreaStart + i;
    emitSidebarCol(ctx, row);
    const lineIdx = viewStart + i;
    if (lineIdx < totalLines) {
      const line = allLines[lineIdx];
      const plain = stripAnsi(line);
      const searchRanges = searchQuery ? findSearchMatches(plain, searchQuery) : [];
      let rendered = line;

      if (inVisual && lineIdx >= vStartRow && lineIdx <= vEndRow) {
        // This line is part of the visual selection — text-bound highlight
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

        rendered = renderLineWithSelection(rendered, startCol, endCol);
      }

      if (searchRanges.length > 0) {
        rendered = renderLineWithSearch(rendered, searchRanges);
      }

      if ((inVisual && lineIdx === vCursor.row) || (historyFocused && !inVisual && lineIdx === vCursor.row)) {
        rendered = renderLineWithCursor(rendered, vCursor.col);
      }

      const finalLine = historyFocused && !inVisual && lineIdx >= hlFirst && lineIdx <= hlLast
        ? applyLineBg(rendered, theme.historyLineBg)
        : bgLine(rendered);
      appendRowWrite(ctx, row, chatCol, finalLine);
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

  const { chatCol } = ctx;
  const { matches, selection: sel } = state.autocomplete;
  const maxName = matches.reduce((m, c) => Math.max(m, termWidth(c.name)), 0);
  const maxDesc = matches.reduce((m, c) => Math.max(m, termWidth(c.desc)), 0);
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
    const name = padRightToWidth(matches[i].name, nameWidth);
    const desc = padRightToWidth(matches[i].desc, descWidth);
    appendRowWrite(
      ctx,
      row,
      chatCol,
      bg + theme.accent + marker + theme.text + name + theme.dim + desc + theme.reset,
    );
  }

  // Scroll indicators when items are clipped
  if (winStart > 0) {
    appendRowWrite(ctx, topRow, chatCol + popupWidth - 2, theme.sidebarBg + theme.dim + " ▲" + theme.reset);
  }
  if (winStart + winSize < total) {
    appendRowWrite(ctx, topRow + winSize - 1, chatCol + popupWidth - 2, theme.sidebarBg + theme.dim + " ▼" + theme.reset);
  }
}

/** Render the vim-style chat-history search bar. */
function renderSearchBar(
  ctx: RenderCtx,
  state: RenderState,
  chatW: number,
  row: number,
): void {
  const search = state.search;
  if (!search?.barOpen) return;

  const { chatCol, bgLine } = ctx;
  const { line } = getSearchBarViewport(search, chatW);
  emitSidebarCol(ctx, row);
  appendRowWrite(ctx, row, chatCol, bgLine(line));
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
  const { chatCol, bgLine } = ctx;
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

    emitSidebarCol(ctx, row);
    appendRowWrite(ctx, row, chatCol, bgLine(prompt + lineContent));
  }
}

/**
 * Position the terminal cursor and set its shape based on the current
 * focus and vim mode. Hides the cursor when history is focused (the
 * history cursor is rendered inline via reverse video).
 */
function buildCursorPayload(
  state: RenderState,
  promptFocused: boolean,
  firstInputRow: number,
  cursorLine: number,
  cursorCol: number,
  promptLen: number,
  searchBarRow: number,
  chatCol: number,
  chatW: number,
): string {
  const out: string[] = [];

  if (state.panelFocus === "sidebar" && state.sidebar.search?.barOpen) {
    const { cursorCol: searchCursorCol } = getSidebarSearchBarViewport(
      state.sidebar.search,
      SIDEBAR_WIDTH - 1,
    );
    out.push(moveTo(state.rows, 1 + searchCursorCol));
    out.push(cursor_bar);
    out.push(show_cursor);
    return out.join("");
  }

  if (state.search?.barOpen) {
    const { cursorCol: searchCursorCol } = getSearchBarViewport(state.search, chatW);
    out.push(moveTo(searchBarRow, chatCol + searchCursorCol));
    out.push(cursor_bar);
    out.push(show_cursor);
    return out.join("");
  }

  if (state.voicePrompt) {
    out.push(hide_cursor);
    return out.join("");
  }

  if (promptFocused) {
    const cursorScreenRow = firstInputRow + cursorLine;
    out.push(moveTo(cursorScreenRow, chatCol + promptLen + cursorCol));
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

  return out.join("");
}

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;

  // App-wide background: fills empty areas and persists through resets
  const appBg = theme.appBg ?? '';
  const cl = appBg + clearLine;       // clear line pre-filled with app bg
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
  const ctx: RenderCtx = {
    frameRows: createFrameRows(rows, cl),
    sidebarOpen,
    sbRows,
    chatCol,
    bgLine,
  };

  // ── Top bar (row 1, full width) ───────────────────────────────
  emitSidebarCol(ctx, 1);
  appendRowWrite(ctx, 1, chatCol, renderTopbar(state, chatW));

  // ── Row 2: separator ──────────────────────────────────────────
  const historyFocused = state.panelFocus === "chat" && state.chatFocus === "history";
  const historyColor = historyFocused ? theme.accent : theme.dim;
  emitSidebarCol(ctx, 2);
  appendRowWrite(ctx, 2, chatCol, bgLine(`${historyColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Input line wrapping + bottom layout ─────────────────────────
  const bottomLayout = computeBottomLayout(state, chatW, rows);
  const {
    renderedPrompt,
    maxInputWidth,
    input,
    inputRowCount,
    status,
    imageIndicatorRows,
    searchBarRow,
    promptSepRow,
    firstInputRow,
    sepBelow,
    bottomStartRow,
    messageAreaHeight,
  } = bottomLayout;
  const { lines: inputLines, isNewLine, cursorLine, cursorCol, scrollOffset: newPromptScroll } = input;
  state.promptScrollOffset = newPromptScroll;

  // Syntax-highlight valid commands and macros in the input lines. When voice
  // input is active, keep the typed text plain and color only the inline voice
  // placeholder so the spinner stands out from surrounding prompt text.
  const coloredInputLines = state.voicePrompt
    ? (() => {
      const placeholder = renderedPrompt.buffer.slice(
        state.voicePrompt.insertionPos,
        renderedPrompt.cursorPos,
      );
      const offsets = wrappedLineOffsets(renderedPrompt.buffer, maxInputWidth);
      return inputLines.map((line, idx) => colorPlainPromptRange(
        line,
        newPromptScroll + idx,
        state.voicePrompt!.insertionPos,
        state.voicePrompt!.insertionPos + placeholder.length,
        offsets,
        theme.accent,
      ));
    })()
    : highlightPromptInput(state, inputLines, state.inputBuffer, maxInputWidth, newPromptScroll);

  const slHeight = status.height;
  const statusLines = status.lines;

  // Prompt separator
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";
  const promptColor = promptFocused ? theme.accent : theme.dim;

  // ── Message area (rows 3 to bottomStartRow-1) ──────────────────
  const messageAreaStart = 3;
  const { lines: allLines, messageBounds, wrapContinuation, wrapJoiners, lineAnchors } = getHistoryRender(state, chatW);
  const totalLines = allLines.length;

  // Cache rendered lines and message bounds for history cursor navigation
  state.historyLines = allLines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyWrapJoiners = wrapJoiners;
  state.historyMessageBounds = messageBounds;
  state.historyLineAnchors = lineAnchors;
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
  state.layout.sepAbove = bottomStartRow;
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

  const searchQuery = getActiveSearchQuery(state);

  renderMessageArea(
    ctx, allLines, totalLines, viewStart,
    messageAreaStart, messageAreaHeight,
    historyFocused, inVisual, state.vim.mode,
    vAnchor, vCursor, vStartRow, vEndRow,
    hlFirst, hlLast, searchQuery,
  );

  // ── Autocomplete popup (overlays message area above input) ────
  renderAutocompletePopup(ctx, state, chatW, bottomStartRow);

  // ── Search bar ────────────────────────────────────────────────
  if (searchBarRow > 0) {
    renderSearchBar(ctx, state, chatW, searchBarRow);
  }

  // ── Separator above input ─────────────────────────────────────
  emitSidebarCol(ctx, promptSepRow);
  appendRowWrite(ctx, promptSepRow, chatCol, bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Image indicator (between separator and prompt) ────────────
  if (imageIndicatorRows > 0) {
    const indRow = promptSepRow + 1;
    emitSidebarCol(ctx, indRow);
    appendRowWrite(ctx, indRow, chatCol, bgLine(renderImageIndicator(state.pendingImages, chatW)));
  }

  // ── Input rows ────────────────────────────────────────────────
  renderInputArea(
    ctx, state, inputRowCount, firstInputRow,
    coloredInputLines, isNewLine, maxInputWidth, newPromptScroll,
    promptFocused,
  );

  // ── Separator below input ─────────────────────────────────────
  emitSidebarCol(ctx, sepBelow);
  appendRowWrite(ctx, sepBelow, chatCol, bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Status lines (chat area width) ─────────────────────────────
  for (let i = 0; i < slHeight; i++) {
    const row = sepBelow + 1 + i;
    emitSidebarCol(ctx, row);
    appendRowWrite(ctx, row, chatCol, bgLine(statusLines[i]));
  }

  // ── Queue prompt overlay ───────────────────────────────────────
  if (state.queuePrompt) {
    appendPositionedPayload(ctx, renderQueuePromptOverlay(state.queuePrompt, chatW, chatCol, bottomStartRow));
  }

  // ── Edit message overlay ──────────────────────────────────────
  if (state.editMessagePrompt) {
    appendPositionedPayload(ctx, renderEditMessageOverlay(state.editMessagePrompt, chatW, chatCol, bottomStartRow, messageAreaHeight));
  }

  const canScrollMessageRegion = !sidebarOpen
    && !state.autocomplete
    && !state.search?.barOpen
    && !state.queuePrompt
    && !state.editMessagePrompt
    && messageAreaHeight > 0;

  flushFrame(state, {
    rows: ctx.frameRows,
    cursor: buildCursorPayload(
      state,
      promptFocused,
      firstInputRow,
      cursorLine,
      cursorCol,
      PROMPT_PREFIX_WIDTH,
      searchBarRow,
      chatCol,
      chatW,
    ),
    scrollRegion: canScrollMessageRegion
      ? { start: messageAreaStart, end: messageAreaStart + messageAreaHeight - 1 }
      : null,
    viewStart,
  });
}
