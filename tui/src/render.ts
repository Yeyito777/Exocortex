/**
 * Terminal rendering for the Exocortex TUI.
 *
 * Draws the UI: header, messages (with blocks), and input prompt.
 * Uses ANSI escape codes for cursor positioning and colors.
 */

import type { Block, AIMessage } from "./messages";
import { isStreaming, type RenderState } from "./state";
import { renderMetadata } from "./metadata";
import { renderStatusLine, STATUS_LINE_HEIGHT } from "./statusline";
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

// ── Word wrapping ───────────────────────────────────────────────────

function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const result: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      result.push(rawLine);
      continue;
    }
    let line = rawLine;
    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      result.push(line.slice(0, breakAt));
      line = line.slice(breakAt).trimStart();
    }
    if (line) result.push(line);
  }

  return result;
}

// ── Block rendering ─────────────────────────────────────────────────

function renderBlock(block: Block, contentWidth: number): string[] {
  const lines: string[] = [];

  switch (block.type) {
    case "thinking": {
      for (const wl of wordWrap(block.text, contentWidth)) {
        lines.push(`  ${theme.dim}${theme.italic}${wl}${theme.reset}`);
      }
      break;
    }
    case "text": {
      for (const wl of wordWrap(block.text, contentWidth)) {
        lines.push(`  ${wl}`);
      }
      break;
    }
    case "tool_call": {
      const label = `${theme.tool}  ▸ ${block.toolName}${theme.reset}`;
      const summary = block.summary ? `${theme.dim} ${block.summary}${theme.reset}` : "";
      lines.push(`${label}${summary}`);
      break;
    }
    case "tool_result": {
      const maxLines = 6;
      const prefix = block.isError ? `${theme.error}  ✗` : `${theme.dim}  ↳`;
      const outputLines = block.output.split("\n");
      const truncated = outputLines.length > maxLines;
      const visible = outputLines.slice(0, maxLines);

      for (const ol of visible) {
        for (const wl of wordWrap(ol, contentWidth - 2)) {
          lines.push(`${prefix} ${wl}${theme.reset}`);
        }
      }
      if (truncated) {
        lines.push(`${prefix} … (${outputLines.length - maxLines} more lines)${theme.reset}`);
      }
      break;
    }
  }

  return lines;
}

// ── User message rendering (right-aligned, gray background) ─────────

function renderUserMessage(text: string, cols: number): string[] {
  const padding = 2;         // horizontal padding inside bubble
  const margin = 2;          // gap from right edge of screen
  const maxBubbleWidth = Math.min(Math.floor(cols * 0.6), cols - margin - 1);
  const innerWidth = maxBubbleWidth - padding * 2;
  const wrapped = wordWrap(text, innerWidth);

  // Size bubble to the longest line
  const bubbleWidth = Math.min(
    maxBubbleWidth,
    Math.max(...wrapped.map(l => l.length)) + padding * 2,
  );
  const inner = bubbleWidth - padding * 2;

  const lines: string[] = [];
  for (const wl of wrapped) {
    const padLeft = " ".repeat(padding);
    const padRight = " ".repeat(Math.max(0, inner - wl.length) + padding);
    const offset = " ".repeat(Math.max(0, cols - bubbleWidth - margin));
    lines.push(`${offset}${theme.userBg}${padLeft}${wl}${padRight}${theme.reset}`);
  }
  return lines;
}

// ── AI message rendering (left-aligned) ─────────────────────────────

function renderAIMessage(msg: AIMessage, contentWidth: number): string[] {
  const lines: string[] = [];

  // Render each block
  for (const block of msg.blocks) {
    lines.push(...renderBlock(block, contentWidth));
  }

  // Metadata
  lines.push(...renderMetadata(msg.metadata));

  return lines;
}

// ── Build all display lines ─────────────────────────────────────────

function buildMessageLines(state: RenderState): string[] {
  const contentWidth = state.cols - 4;
  const lines: string[] = [];

  for (const msg of state.messages) {
    lines.push("");

    if (msg.role === "user") {
      lines.push(...renderUserMessage(msg.text, state.cols));
    } else if (msg.role === "assistant") {
      lines.push(...renderAIMessage(msg, contentWidth));
    } else {
      const color = msg.color || theme.dim;
      for (const sl of msg.text.split("\n")) {
        lines.push(`  ${color}${sl}${theme.reset}`);
      }
    }
  }

  // Currently streaming AI message
  if (state.pendingAI) {
    lines.push("");
    lines.push(...renderAIMessage(state.pendingAI, contentWidth));
  }

  return lines;
}

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;
  const out: string[] = [];

  // ── Header (row 1) ────────────────────────────────────────────
  const title = `${theme.bold} Exocortex${theme.reset}`;
  const modelLabel = `${theme.dim}${state.model}${theme.reset}`;
  const convLabel = state.convId ? `${theme.dim}${state.convId.slice(0, 12)}${theme.reset}` : "";
  const statusDot = isStreaming(state) ? `${theme.warning}●${theme.reset}` : `${theme.success}●${theme.reset}`;

  out.push(move_to(1, 1) + clear_line);
  out.push(`${theme.headerBg}${title}  ${statusDot}  ${convLabel}${" ".repeat(Math.max(0, cols - 30 - state.model.length))}${modelLabel} ${theme.reset}`);

  // ── Separator after header ────────────────────────────────────
  const historyColor = state.focus === "history" ? theme.accent : theme.dim;
  out.push(move_to(2, 1) + clear_line);
  out.push(`${historyColor}${"─".repeat(cols)}${theme.reset}`);

  // ── Input line wrapping ────────────────────────────────────────
  const promptLen = 3;               // " ❯ " or " + "
  const maxInputWidth = cols - promptLen;
  const maxInputRows = Math.min(10, Math.floor((rows - 6) / 2));  // cap at 10 or half screen

  const { lines: inputLines, isNewLine, cursorLine, cursorCol } =
    getInputLines(state.inputBuffer, state.cursorPos, maxInputWidth, maxInputRows);

  const inputRowCount = inputLines.length;

  // ── Bottom layout: sep | input rows | sep | status ────────────
  const statusLines = renderStatusLine(state.usage);
  const bottomUsed = 1 + inputRowCount + 1 + STATUS_LINE_HEIGHT; // sep + input + sep + status
  const sepAbove = rows - bottomUsed + 1;
  const firstInputRow = sepAbove + 1;
  const sepBelow = firstInputRow + inputRowCount;

  // Separator above input
  const promptColor = state.focus === "prompt" ? theme.accent : theme.dim;
  out.push(move_to(sepAbove, 1) + clear_line);
  out.push(`${promptColor}${"─".repeat(cols)}${theme.reset}`);

  // Input rows
  for (let i = 0; i < inputRowCount; i++) {
    const prompt = (i === 0 && !isNewLine[i])
      ? `${theme.bold}${theme.prompt} ❯${theme.reset} `
      : `${theme.dim} +${theme.reset} `;
    out.push(move_to(firstInputRow + i, 1) + clear_line);
    out.push(prompt + inputLines[i]);
  }

  // Separator below input
  out.push(move_to(sepBelow, 1) + clear_line);
  out.push(`${promptColor}${"─".repeat(cols)}${theme.reset}`);

  // Status lines
  for (let i = 0; i < STATUS_LINE_HEIGHT; i++) {
    out.push(move_to(sepBelow + 1 + i, 1) + clear_line);
    out.push(statusLines[i]);
  }

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
    out.push(move_to(messageAreaStart + i, 1) + clear_line);
    const lineIdx = viewStart + i;
    if (lineIdx < totalLines) {
      out.push(allLines[lineIdx]);
    }
  }

  // ── Position cursor in input field ────────────────────────────
  const cursorScreenRow = firstInputRow + cursorLine;
  out.push(move_to(cursorScreenRow, promptLen + cursorCol + 1));
  out.push(show_cursor);

  process.stdout.write(out.join(""));
}
