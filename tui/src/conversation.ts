/**
 * Conversation rendering — messages, blocks, and text wrapping.
 *
 * Turns the message list + pendingAI into display lines.
 * The only file that knows how to render conversations.
 */

import type { Block, AIMessage, ToolDisplayInfo } from "./messages";
import type { RenderState } from "./state";
import { renderMetadata } from "./metadata";
import { resolveToolDisplay } from "./toolstyles";
import { theme } from "./theme";

// ── Word wrapping ───────────────────────────────────────────────────

export function wordWrap(text: string, width: number): string[] {
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

function renderBlock(block: Block, contentWidth: number, toolRegistry: ToolDisplayInfo[], showToolOutput: boolean): string[] {
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
      const display = resolveToolDisplay(block.toolName, block.summary, toolRegistry);
      // Wrap the plain text, then apply colors per line
      const plainText = display.detail ? `${display.label} ${display.detail}` : display.label;
      const wrapped = wordWrap(plainText, contentWidth - 2);
      for (let i = 0; i < wrapped.length; i++) {
        if (i === 0) {
          // First line: bold label + detail
          const labelLen = display.label.length;
          const rest = wrapped[0].slice(labelLen);
          lines.push(`  ${display.fg}${theme.bold}${display.label}${theme.reset}${display.fg}${rest}${theme.reset}`);
        } else {
          lines.push(`  ${display.fg}${wrapped[i]}${theme.reset}`);
        }
      }
      break;
    }
    case "tool_result": {
      if (!showToolOutput) break;
      const maxLines = 20;
      const fg = block.isError ? theme.error : theme.dim;
      const symbol = block.isError ? "✗" : "↳";
      const firstPrefix = `  ${symbol} `;
      const contPrefix = "    ";
      const trimmed = block.output.replace(/\n+$/, "");
      const outputLines = trimmed.split("\n");
      const truncated = outputLines.length > maxLines;
      const visible = outputLines.slice(0, maxLines);

      let first = true;
      for (const ol of visible) {
        for (const wl of wordWrap(ol, contentWidth - contPrefix.length)) {
          const prefix = first ? firstPrefix : contPrefix;
          first = false;
          lines.push(`${fg}${prefix}${wl}${theme.reset}`);
        }
      }
      if (truncated) {
        lines.push(`${fg}${contPrefix}… (${outputLines.length - maxLines} more lines)${theme.reset}`);
      }
      break;
    }
  }

  return lines;
}

// ── User message rendering (right-aligned, themed background) ───────

function renderUserMessage(text: string, cols: number): string[] {
  const padding = 1;         // horizontal padding inside bubble
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
    const padLeft = " ".repeat(Math.max(0, inner - wl.length) + padding);
    const padRight = " ".repeat(padding);
    const offset = " ".repeat(Math.max(0, cols - bubbleWidth - margin));
    lines.push(`${offset}${theme.userBg}${padLeft}${wl}${padRight}${theme.reset}`);
  }
  return lines;
}

// ── AI message rendering (left-aligned) ─────────────────────────────

function renderAIMessage(msg: AIMessage, contentWidth: number, toolRegistry: ToolDisplayInfo[], showToolOutput: boolean): string[] {
  const lines: string[] = [];

  for (const block of msg.blocks) {
    lines.push(...renderBlock(block, contentWidth, toolRegistry, showToolOutput));
  }

  lines.push(...renderMetadata(msg.metadata));

  return lines;
}

// ── Build all display lines ─────────────────────────────────────────

export function buildMessageLines(state: RenderState, availableWidth: number): string[] {
  const contentWidth = availableWidth - 4;
  const lines: string[] = [];

  for (const msg of state.messages) {
    lines.push("");

    if (msg.role === "user") {
      lines.push(...renderUserMessage(msg.text, availableWidth));
    } else if (msg.role === "assistant") {
      lines.push(...renderAIMessage(msg, contentWidth, state.toolRegistry, state.showToolOutput));
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
    lines.push(...renderAIMessage(state.pendingAI, contentWidth, state.toolRegistry, state.showToolOutput));
  }

  return lines;
}
