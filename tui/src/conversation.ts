/**
 * Conversation rendering — messages, blocks, and text wrapping.
 *
 * Turns the message list + pendingAI into display lines.
 * The only file that knows how to render conversations.
 */

import type { Block, ToolDisplayInfo, ExternalToolStyle, ImageAttachment } from "./messages";
import type { RenderState } from "./state";
import { renderMetadata } from "./metadata";
import { resolveToolDisplay } from "./toolstyles";
import { formatSize, imageLabel } from "./clipboard";
import { theme } from "./theme";
import { markdownWordWrap } from "./markdown";

// ── Word wrapping ───────────────────────────────────────────────────

export interface WrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
}

export function wordWrap(text: string, width: number): WrapResult {
  if (width <= 0) return { lines: [text], cont: [false] };
  const lines: string[] = [];
  const cont: boolean[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      lines.push(rawLine);
      cont.push(false);
      continue;
    }
    let line = rawLine;
    let first = true;
    while (line.length > width) {
      let breakAt = line.lastIndexOf(" ", width);
      if (breakAt <= 0) breakAt = width;
      lines.push(line.slice(0, breakAt));
      cont.push(!first);
      first = false;
      line = line.slice(breakAt).trimStart();
    }
    if (line) {
      lines.push(line);
      cont.push(!first);
    }
  }

  return { lines, cont };
}

// ── Block render cache ──────────────────────────────────────────────
// Markdown rendering (syntax highlighting, table box-drawing, inline
// formatting, word wrapping) is the most expensive per-frame work.
// Cache rendered output per block object — WeakMap ensures entries are
// GC'd when messages leave the conversation.

interface BlockCacheEntry {
  /** Length of source text at render time (detects streaming growth). */
  contentLen: number;
  /** Terminal content width used for wrapping. */
  width: number;
  /** Whether tool output was shown (affects tool_result blocks). */
  showToolOutput: boolean;
  /** Cached render result. */
  result: WrapResult;
}

const blockRenderCache = new WeakMap<Block, BlockCacheEntry>();

/** Length of the block's mutable content field — used for cache invalidation. */
function blockContentKey(block: Block): number {
  switch (block.type) {
    case "thinking":
    case "text":
      return block.text.length;
    case "tool_call":
      return block.summary.length;
    case "tool_result":
      return block.output.length;
  }
}

function renderBlockCached(
  block: Block,
  contentWidth: number,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  showToolOutput: boolean,
): WrapResult {
  const contentLen = blockContentKey(block);
  const cached = blockRenderCache.get(block);
  if (
    cached &&
    cached.contentLen === contentLen &&
    cached.width === contentWidth &&
    cached.showToolOutput === showToolOutput
  ) {
    return cached.result;
  }

  const result = renderBlock(block, contentWidth, toolRegistry, externalToolStyles, showToolOutput);
  blockRenderCache.set(block, { contentLen, width: contentWidth, showToolOutput, result });
  return result;
}

// ── Block rendering ─────────────────────────────────────────────────

function renderBlock(block: Block, contentWidth: number, toolRegistry: ToolDisplayInfo[], externalToolStyles: ExternalToolStyle[], showToolOutput: boolean): WrapResult {
  const lines: string[] = [];
  const cont: boolean[] = [];

  switch (block.type) {
    case "thinking": {
      if (!block.text.trim()) break;
      const w = wordWrap(block.text, contentWidth);
      for (let i = 0; i < w.lines.length; i++) {
        lines.push(`  ${theme.dim}${theme.italic}${w.lines[i]}${theme.reset}`);
        cont.push(w.cont[i]);
      }
      break;
    }
    case "text": {
      const text = block.text.replace(/^\n+/, "");
      const isHint = text.startsWith("[Context:");

      if (isHint) {
        // Context hints: plain dim text, no markdown processing
        const w = wordWrap(text, contentWidth);
        for (let i = 0; i < w.lines.length; i++) {
          lines.push(`  ${theme.dim}${w.lines[i]}${theme.reset}`);
          cont.push(w.cont[i]);
        }
      } else {
        // Assistant text blocks: full markdown rendering.
        // markdownWordWrap handles code blocks, tables, HRs, inline
        // formatting, and word wrapping — output is fully formatted.
        const mdLines = markdownWordWrap(text, contentWidth, theme.reset);
        for (const line of mdLines) {
          lines.push(`  ${line}`);
          cont.push(false);
        }
      }
      break;
    }
    case "tool_call": {
      const display = resolveToolDisplay(block.toolName, block.summary, toolRegistry, externalToolStyles);

      // Build logical display lines. Each entry: { text, hasLabel }.
      // hasLabel tracks structurally whether the line starts with a
      // bold label — avoids fragile string-content matching later.
      const logical: { text: string; hasLabel: boolean }[] = [];

      if (display.cmd && display.detail) {
        // User-styled bash: re-apply label to subsequent lines that
        // invoke the same command prefix.
        const cmd = display.cmd;
        for (const [i, line] of display.detail.split("\n").entries()) {
          if (i === 0) {
            logical.push({ text: `${display.label} ${line}`, hasLabel: true });
          } else {
            const t = line.trimStart();
            if (t === cmd || t.startsWith(cmd + " ")) {
              const args = t.slice(cmd.length).trimStart();
              logical.push({ text: `${display.label} ${args}`, hasLabel: true });
            } else {
              logical.push({ text: line, hasLabel: false });
            }
          }
        }
      } else {
        // Default: single logical line with the label prepended.
        const text = display.detail ? `${display.label} ${display.detail}` : display.label;
        logical.push({ text, hasLabel: true });
      }

      // Wrap and colorize all logical lines uniformly.
      for (const entry of logical) {
        const w = wordWrap(entry.text, contentWidth - 2);
        for (let j = 0; j < w.lines.length; j++) {
          // Bold label on the first visual line of a label-bearing logical line.
          if (entry.hasLabel && j === 0) {
            const rest = w.lines[0].slice(display.label.length);
            lines.push(`  ${display.fg}${theme.bold}${display.label}${theme.reset}${display.fg}${rest}${theme.reset}`);
          } else {
            lines.push(`  ${display.fg}${w.lines[j]}${theme.reset}`);
          }
          cont.push(w.cont[j]);
        }
      }
      break;
    }
    case "tool_result": {
      if (!showToolOutput) break;
      const fg = block.isError ? theme.error : theme.dim;
      const symbol = block.isError ? "✗" : "↳";
      const firstPrefix = `  ${symbol} `;
      const contPrefix = "    ";
      const trimmed = block.output.replace(/\n+$/, "");
      const outputLines = trimmed.split("\n");

      let first = true;
      for (const ol of outputLines) {
        const w = wordWrap(ol, contentWidth - contPrefix.length);
        for (let i = 0; i < w.lines.length; i++) {
          const prefix = first ? firstPrefix : contPrefix;
          first = false;
          lines.push(`${fg}${prefix}${w.lines[i]}${theme.reset}`);
          cont.push(w.cont[i]);
        }
      }
      break;
    }
  }

  return { lines, cont };
}

// ── User message rendering (right-aligned, themed background) ───────

function renderUserMessage(text: string, cols: number, images?: ImageAttachment[]): WrapResult {
  const padding = 1;         // horizontal padding inside bubble
  const margin = 2;          // gap from right edge of screen
  const maxBubbleWidth = cols - margin - 1;
  const innerWidth = maxBubbleWidth - padding * 2;

  // Build image badge lines (e.g. "📎 PNG (93.1 KB)")
  const badgeLines: string[] = [];
  if (images?.length) {
    for (const img of images) {
      badgeLines.push(`📎 ${imageLabel(img.mediaType)} (${formatSize(img.sizeBytes)})`);
    }
  }

  const w = text ? wordWrap(text, innerWidth) : { lines: [] as string[], cont: [] as boolean[] };

  // Combine badges + text for width calculation
  const allContentLines = [...badgeLines, ...w.lines];
  if (allContentLines.length === 0) allContentLines.push("");

  // Size bubble to the longest line
  const bubbleWidth = Math.min(
    maxBubbleWidth,
    Math.max(...allContentLines.map(l => l.length)) + padding * 2,
  );
  const inner = bubbleWidth - padding * 2;

  const lines: string[] = [];
  const cont: boolean[] = [];
  const screenOffset = " ".repeat(Math.max(0, cols - bubbleWidth - margin));
  const padRight = " ".repeat(padding);

  /** Append a right-aligned bubble line with optional style prefix. */
  const pushBubbleLine = (lineText: string, isCont: boolean, style?: string) => {
    const padLeft = " ".repeat(Math.max(0, inner - lineText.length) + padding);
    const styledText = style ? `${style}${lineText}${theme.reset}${theme.userBg}` : lineText;
    lines.push(`${screenOffset}${theme.userBg}${padLeft}${styledText}${padRight}${theme.reset}`);
    cont.push(isCont);
  };

  // Render text lines
  for (let i = 0; i < w.lines.length; i++) {
    pushBubbleLine(w.lines[i], w.cont[i]);
  }

  // Render image badges below text (dimmed)
  for (const badge of badgeLines) {
    pushBubbleLine(badge, false, theme.dim);
  }
  return { lines, cont };
}

// ── Message boundary tracking ───────────────────────────────────────

/** Row range for a single message in the rendered history lines. */
export interface MessageBound {
  /** First line index (inclusive). */
  start: number;
  /** Last line index (exclusive). */
  end: number;
  /** Start of primary content (inclusive), after margins. */
  contentStart: number;
  /** End of primary content (exclusive), before metadata/padding. im uses this. */
  contentEnd: number;
}

// ── Build all display lines ─────────────────────────────────────────

export function buildMessageLines(
  state: RenderState,
  availableWidth: number,
): { lines: string[]; messageBounds: MessageBound[]; wrapContinuation: boolean[] } {
  const contentWidth = availableWidth - 4;
  const lines: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: MessageBound[] = [];

  /** Append block result (lines + continuation flags). */
  const pushBlock = (br: WrapResult) => {
    lines.push(...br.lines);
    wrapContinuation.push(...br.cont);
  };

  /** Append a non-wrapped line (margin, metadata, etc). */
  const pushLine = (line: string) => {
    lines.push(line);
    wrapContinuation.push(false);
  };

  let firstUser = true;
  for (const msg of state.messages) {
    const start = lines.length;
    if (msg.role === "user") {
      if (!firstUser) pushLine("");  // top margin (skip for first)
      const contentStart = lines.length;
      pushBlock(renderUserMessage(msg.text, availableWidth, msg.images));
      const contentEnd = lines.length;
      pushLine("");                  // bottom margin
      firstUser = false;
      messageBounds.push({ start, end: lines.length, contentStart, contentEnd });
    } else if (msg.role === "assistant") {
      // AI messages: content blocks, then metadata
      const contentStart = lines.length;
      for (const block of msg.blocks) {
        pushBlock(renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
      }
      const contentEnd = lines.length;
      for (const ml of renderMetadata(msg.metadata)) pushLine(ml);
      messageBounds.push({ start, end: lines.length, contentStart, contentEnd });
    } else if (msg.role === "system_instructions") {
      if (!msg.text.trim()) {
        messageBounds.push({ start, end: lines.length, contentStart: start, contentEnd: lines.length });
        continue;
      }
      const boxWidth = availableWidth;
      const textWidth = boxWidth - 4; // │ + space + text + space + │
      const title = " System Instructions ";
      const topFill = Math.max(0, boxWidth - 2 - title.length); // -2 for ┌ and ┐
      const topLine = `┌${title}${"─".repeat(topFill)}┐`;
      const bottomLine = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;

      pushLine(`${theme.accent}${topLine}${theme.reset}`);
      const contentStart = lines.length;

      const { lines: wrapped } = wordWrap(msg.text, textWidth > 0 ? textWidth : 1);
      for (const sl of wrapped) {
        const pad = " ".repeat(Math.max(0, textWidth - sl.length));
        pushLine(`${theme.accent}│${theme.reset} ${theme.dim}${sl}${pad}${theme.reset} ${theme.accent}│${theme.reset}`);
      }
      const contentEnd = lines.length;

      pushLine(`${theme.accent}${bottomLine}${theme.reset}`);
      messageBounds.push({ start, end: lines.length, contentStart, contentEnd });
    } else {
      const color = msg.color || theme.dim;
      const sysWidth = availableWidth - 2; // 2-char indent
      const { lines: wrapped } = wordWrap(msg.text, sysWidth > 0 ? sysWidth : 1);
      for (const sl of wrapped) {
        pushLine(`  ${color}${sl}${theme.reset}`);
      }
      messageBounds.push({ start, end: lines.length, contentStart: start, contentEnd: lines.length });
    }
  }

  // Currently streaming AI message — no margins
  if (state.pendingAI) {
    const start = lines.length;
    for (const block of state.pendingAI.blocks) {
      pushBlock(renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
    }
    const contentEnd = lines.length;
    for (const ml of renderMetadata(state.pendingAI.metadata)) pushLine(ml);
    messageBounds.push({ start, end: lines.length, contentStart: start, contentEnd });
  }

  // Queued messages — dimmed user bubbles with timing label (after pendingAI)
  if (state.convId) {
    const queued = state.queuedMessages.filter(qm => qm.convId === state.convId);
    for (const qm of queued) {
      const timingLabel = qm.timing === "next-turn" ? "queued: next turn" : "queued: message end";
      pushLine("");
      // Render a dimmed user bubble
      const qr = renderUserMessage(qm.text, availableWidth, qm.images);
      for (let i = 0; i < qr.lines.length; i++) {
        pushLine(`${theme.muted}${qr.lines[i]}${theme.reset}`);
      }
      // Timing label — right-aligned, muted italic
      const labelPad = " ".repeat(Math.max(0, availableWidth - timingLabel.length - 3));
      pushLine(`${labelPad}${theme.muted}${theme.italic}${timingLabel}${theme.reset}`);
    }
  }

  return { lines, messageBounds, wrapContinuation };
}
