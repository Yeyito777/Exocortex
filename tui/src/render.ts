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

import type { QueuePromptState, EditMessageState } from "./state";
import { EDIT_INDEX_INSTRUCTIONS } from "./state";

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
  out.push(move_to(1, 1) + cl);
  if (sidebarOpen) {
    out.push(sbRows[0]);
    // Chat portion of topbar starts at chatCol
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

  for (let i = 0; i < messageAreaHeight; i++) {
    const row = messageAreaStart + i;
    out.push(move_to(row, 1) + cl);
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
        out.push(bgLine(rendered));
      } else if (historyFocused && lineIdx >= hlFirst && lineIdx <= hlLast) {
        // Normal mode: highlight the full logical line group
        if (lineIdx === state.historyCursor.row) {
          const withCursor = renderLineWithCursor(line, state.historyCursor.col);
          out.push(applyLineBg(withCursor, theme.historyLineBg));
        } else {
          out.push(applyLineBg(line, theme.historyLineBg));
        }
      } else {
        out.push(bgLine(line));
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
  out.push(move_to(sepAbove, 1) + cl);
  if (sidebarOpen && sbRows[sepAbove - 1]) {
    out.push(sbRows[sepAbove - 1]);
  }
  out.push(move_to(sepAbove, chatCol) + bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Image indicator (between separator and prompt) ────────────
  if (imageIndicatorRows > 0) {
    const indRow = sepAbove + 1;
    out.push(move_to(indRow, 1) + cl);
    if (sidebarOpen && sbRows[indRow - 1]) {
      out.push(sbRows[indRow - 1]);
    }
    out.push(move_to(indRow, chatCol) + bgLine(renderImageIndicator(state.pendingImages, chatW)));
  }

  // ── Input rows ────────────────────────────────────────────────
  const promptInVisual = promptFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");
  // Compute once for all visual-selection calls inside the loop
  const inputOffsets = promptInVisual ? wrappedLineOffsets(state.inputBuffer, maxInputWidth) : [];

  for (let i = 0; i < inputRowCount; i++) {
    const row = firstInputRow + i;
    const promptGlyph = (i === 0 && !isNewLine[i]) ? ">" : "+";
    const promptStyle = promptFocused ? theme.accent : theme.dim;

    const isFirst = i === 0 && !isNewLine[i];
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
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
    out.push(move_to(row, chatCol) + bgLine(prompt + lineContent));
  }

  // ── Separator below input ─────────────────────────────────────
  out.push(move_to(sepBelow, 1) + cl);
  if (sidebarOpen && sbRows[sepBelow - 1]) {
    out.push(sbRows[sepBelow - 1]);
  }
  out.push(move_to(sepBelow, chatCol) + bgLine(`${promptColor}${"─".repeat(chatW)}${theme.reset}`));

  // ── Status lines (chat area width) ─────────────────────────────
  for (let i = 0; i < slHeight; i++) {
    const row = sepBelow + 1 + i;
    out.push(move_to(row, 1) + cl);
    if (sidebarOpen && sbRows[row - 1]) {
      out.push(sbRows[row - 1]);
    }
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

  process.stdout.write(out.join(""));
}

// ── Queue prompt overlay ───────────────────────────────────────────

function renderQueuePromptOverlay(
  qp: QueuePromptState,
  chatW: number,
  chatCol: number,
  sepRow: number,
): string {
  let result = "";

  // Preview of the message being queued (truncated)
  const preview = qp.text.replace(/\n/g, " ").slice(0, 40);
  const previewLabel = preview.length < qp.text.replace(/\n/g, " ").length ? preview + "…" : preview;

  // Box content lines
  const titleLine = "Queue message:";
  const msgLine = `"${previewLabel}"`;
  const optLine1 = `${qp.selection === "message-end" ? "▸ " : "  "}message end`;
  const optLine2 = `${qp.selection === "next-turn" ? "▸ " : "  "}next turn`;
  const contentLines = [titleLine, msgLine, "", optLine1, optLine2];
  const innerWidth = Math.min(
    Math.max(...contentLines.map(l => l.length)) + 4,
    chatW - 4,
  );
  const boxWidth = innerWidth + 2; // +2 for borders

  // Position: centered horizontally in chat area, just above input separator
  const boxLeft = chatCol + Math.floor((chatW - boxWidth) / 2);
  const boxTop = Math.max(3, sepRow - contentLines.length - 2);

  // Top border
  result += move_to(boxTop, boxLeft);
  result += `${theme.sidebarBg}${theme.accent}┌${"─".repeat(innerWidth)}┐${theme.reset}`;

  // Content lines
  for (let i = 0; i < contentLines.length; i++) {
    const row = boxTop + 1 + i;
    if (row >= sepRow) break; // don't overlap input area
    const line = contentLines[i];
    const padRight = Math.max(0, innerWidth - line.length);

    let fg = theme.muted;
    let bg = theme.sidebarBg;
    if (i === 0) fg = theme.text;    // title
    if (i === 1) fg = theme.muted;   // preview

    if (i === 3 || i === 4) {
      // Options
      const isSelected = (i === 3 && qp.selection === "message-end") ||
                         (i === 4 && qp.selection === "next-turn");
      if (isSelected) {
        bg = theme.sidebarSelBg;
        fg = theme.accent;
      } else {
        fg = theme.text;
      }
    }

    result += move_to(row, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}│${bg}${fg}`;
    result += `${line}${" ".repeat(padRight)}`;
    result += `${theme.reset}${theme.sidebarBg}${theme.accent}│${theme.reset}`;
  }

  // Bottom border
  const bottomRow = boxTop + 1 + contentLines.length;
  if (bottomRow < sepRow) {
    result += move_to(bottomRow, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}└${"─".repeat(innerWidth)}┘${theme.reset}`;
  }

  return result;
}

// ── Edit message overlay ──────────────────────────────────────────

function renderEditMessageOverlay(
  em: EditMessageState,
  chatW: number,
  chatCol: number,
  sepRow: number,
  messageAreaHeight: number,
): string {
  let result = "";

  const titleLine = "Edit message:";

  // Build display lines: truncated previews of each item
  const maxPreviewLen = Math.min(50, chatW - 12);
  const previews = em.items.map((item) => {
    const prefix = item.userMessageIndex === EDIT_INDEX_INSTRUCTIONS ? "📌 " : "";
    const raw = prefix + item.text.replace(/\n/g, " ");
    return raw.length > maxPreviewLen ? raw.slice(0, maxPreviewLen) + "…" : raw;
  });
  const maxContentLen = Math.max(
    titleLine.length,
    ...previews.map(p => p.length + 2), // +2 for marker "▸ "
  );
  const innerWidth = Math.min(maxContentLen + 4, chatW - 4);
  const boxWidth = innerWidth + 2;

  // Max visible items (leave room for title, blank line, borders)
  const maxVisible = Math.min(em.items.length, Math.max(3, messageAreaHeight - 4));

  // Scroll window to keep selection visible
  let scrollStart = em.scrollOffset;
  if (em.selection < scrollStart) scrollStart = em.selection;
  if (em.selection >= scrollStart + maxVisible) scrollStart = em.selection - maxVisible + 1;
  scrollStart = Math.max(0, Math.min(scrollStart, em.items.length - maxVisible));
  em.scrollOffset = scrollStart;

  // Content: title, blank, visible items
  const contentLines: { text: string; plain: string; style: "title" | "item" | "blank"; itemIdx?: number }[] = [];
  contentLines.push({ text: titleLine, plain: titleLine, style: "title" });
  contentLines.push({ text: "", plain: "", style: "blank" });
  for (let vi = 0; vi < maxVisible; vi++) {
    const i = scrollStart + vi;
    const marker = em.selection === i ? "▸ " : "  ";
    contentLines.push({
      text: marker + previews[i],
      plain: marker + previews[i],
      style: "item",
      itemIdx: i,
    });
  }

  // Position: centered horizontally, anchored above input separator
  const boxLeft = chatCol + Math.floor((chatW - boxWidth) / 2);
  const boxTop = Math.max(3, sepRow - contentLines.length - 2);

  // Top border
  result += move_to(boxTop, boxLeft);
  result += `${theme.sidebarBg}${theme.accent}┌${"─".repeat(innerWidth)}┐${theme.reset}`;

  // Content lines
  for (let i = 0; i < contentLines.length; i++) {
    const row = boxTop + 1 + i;
    if (row >= sepRow) break;
    const cl = contentLines[i];
    const plainLen = cl.plain.length;
    const padRight = Math.max(0, innerWidth - plainLen);

    let fg = theme.text;
    let bg = theme.sidebarBg;

    if (cl.style === "title") {
      fg = theme.text;
    } else if (cl.style === "item") {
      const isSelected = cl.itemIdx === em.selection;
      const isQueued = cl.itemIdx !== undefined && em.items[cl.itemIdx]?.isQueued;
      if (isSelected) {
        bg = theme.sidebarSelBg;
        fg = isQueued ? theme.muted : theme.accent;
      } else {
        fg = isQueued ? theme.muted : theme.text;
      }
    }

    result += move_to(row, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}│${bg}${fg}`;
    result += `${cl.text}${" ".repeat(padRight)}`;
    result += `${theme.reset}${theme.sidebarBg}${theme.accent}│${theme.reset}`;
  }

  // Scroll indicators
  if (scrollStart > 0) {
    const indRow = boxTop + 3; // first item row
    result += move_to(indRow, boxLeft + boxWidth - 3);
    result += `${theme.sidebarBg}${theme.dim} ▲${theme.reset}`;
  }
  if (scrollStart + maxVisible < em.items.length) {
    const indRow = boxTop + 2 + maxVisible; // last item row
    result += move_to(indRow, boxLeft + boxWidth - 3);
    result += `${theme.sidebarBg}${theme.dim} ▼${theme.reset}`;
  }

  // Bottom border
  const bottomRow = boxTop + 1 + contentLines.length;
  if (bottomRow < sepRow) {
    result += move_to(bottomRow, boxLeft);
    result += `${theme.sidebarBg}${theme.accent}└${"─".repeat(innerWidth)}┘${theme.reset}`;
  }

  return result;
}
