/**
 * Terminal rendering for the Exocortex TUI.
 *
 * Draws the UI: header, messages (with blocks), and input prompt.
 * Uses ANSI escape codes for cursor positioning and colors.
 */

import type { Block, AIMessage } from "./messages";
import type { RenderState } from "./state";

// ── ANSI helpers ────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const ITALIC = `${ESC}3m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const BLUE = `${ESC}34m`;
const MAGENTA = `${ESC}35m`;
const BG_DARK = `${ESC}48;5;236m`;
const BG_USER = `${ESC}48;5;238m`;

export const hide_cursor = `${ESC}?25l`;
export const show_cursor = `${ESC}?25h`;
export const enter_alt = `${ESC}?1049h`;
export const leave_alt = `${ESC}?1049l`;
export const clear_screen = `${ESC}2J${ESC}H`;
const clear_line = `${ESC}2K`;
const move_to = (row: number, col: number) => `${ESC}${row};${col}H`;

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

// ── Duration formatting ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// ── Block rendering ─────────────────────────────────────────────────

function renderBlock(block: Block, contentWidth: number): string[] {
  const lines: string[] = [];

  switch (block.type) {
    case "thinking": {
      for (const wl of wordWrap(block.text, contentWidth)) {
        lines.push(`  ${DIM}${ITALIC}${wl}${RESET}`);
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
      const label = `${MAGENTA}  ▸ ${block.toolName}${RESET}`;
      const summary = block.summary ? `${DIM} ${block.summary}${RESET}` : "";
      lines.push(`${label}${summary}`);
      break;
    }
    case "tool_result": {
      const maxLines = 6;
      const prefix = block.isError ? `${RED}  ✗` : `${DIM}  ↳`;
      const outputLines = block.output.split("\n");
      const truncated = outputLines.length > maxLines;
      const visible = outputLines.slice(0, maxLines);

      for (const ol of visible) {
        for (const wl of wordWrap(ol, contentWidth - 2)) {
          lines.push(`${prefix} ${wl}${RESET}`);
        }
      }
      if (truncated) {
        lines.push(`${prefix} … (${outputLines.length - maxLines} more lines)${RESET}`);
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
    lines.push(`${offset}${BG_USER}${padLeft}${wl}${padRight}${RESET}`);
  }
  return lines;
}

// ── AI message rendering (left-aligned) ─────────────────────────────

function renderAIMessage(
  msg: AIMessage,
  contentWidth: number,
  isStreaming: boolean,
): string[] {
  const lines: string[] = [];

  // Empty pending message → "thinking..."
  if (msg.blocks.length === 0 && isStreaming) {
    lines.push(`  ${DIM}thinking...${RESET}`);
    return lines;
  }

  // Render each block
  for (const block of msg.blocks) {
    lines.push(...renderBlock(block, contentWidth));
  }

  // Footer: duration (always), streaming cursor
  const elapsed = (msg.endedAt ?? Date.now()) - msg.startedAt;
  if (isStreaming) {
    lines.push(`  ${DIM}${formatDuration(elapsed)} ▍${RESET}`);
  } else if (elapsed > 0) {
    lines.push(`  ${DIM}${formatDuration(elapsed)}${RESET}`);
  }

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
      lines.push(...renderAIMessage(msg, contentWidth, false));
    } else {
      lines.push(`  ${DIM}${msg.text}${RESET}`);
    }
  }

  // Currently streaming AI message
  if (state.pendingAI) {
    lines.push("");
    lines.push(...renderAIMessage(state.pendingAI, contentWidth, true));
  }

  return lines;
}

// ── Main render ─────────────────────────────────────────────────────

export function render(state: RenderState): void {
  const { cols, rows } = state;
  const out: string[] = [];

  // ── Header (row 1) ────────────────────────────────────────────
  const title = `${BOLD} Exocortex${RESET}`;
  const modelLabel = `${DIM}${state.model}${RESET}`;
  const convLabel = state.convId ? `${DIM}${state.convId.slice(0, 12)}${RESET}` : "";
  const statusDot = state.streaming ? `${YELLOW}●${RESET}` : `${GREEN}●${RESET}`;

  out.push(move_to(1, 1) + clear_line);
  out.push(`${BG_DARK}${title}  ${statusDot}  ${convLabel}${" ".repeat(Math.max(0, cols - 30 - state.model.length))}${modelLabel} ${RESET}`);

  // ── Separator after header ────────────────────────────────────
  out.push(move_to(2, 1) + clear_line);
  out.push(`${DIM}${"─".repeat(cols)}${RESET}`);

  // ── Input area (bottom 2 rows) ────────────────────────────────
  const inputRow = rows - 1;
  const sepRow = rows - 2;

  out.push(move_to(sepRow, 1) + clear_line);
  out.push(`${DIM}${"─".repeat(cols)}${RESET}`);

  const prompt = `${BOLD}${BLUE} ❯${RESET} `;
  const promptLen = 3;
  const inputWidth = cols - promptLen;
  let displayInput = state.inputBuffer;
  let displayCursorPos = state.cursorPos;
  if (displayInput.length > inputWidth) {
    const start = Math.max(0, state.cursorPos - Math.floor(inputWidth / 2));
    displayInput = displayInput.slice(start, start + inputWidth);
    displayCursorPos = state.cursorPos - start;
  }
  out.push(move_to(inputRow, 1) + clear_line);
  out.push(prompt + displayInput);

  // ── Message area (rows 3 to sepRow-1) ─────────────────────────
  const messageAreaStart = 3;
  const messageAreaHeight = sepRow - messageAreaStart;
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
  out.push(move_to(inputRow, promptLen + displayCursorPos + 1));
  out.push(show_cursor);

  process.stdout.write(out.join(""));
}
