/**
 * Rendering for individual conversation message blocks and lightweight system/user
 * message fragments.
 *
 * The conversation builder composes anchored history rows; this module owns the
 * display details for blocks so styling, wrapping, and block render caching do
 * not leak into viewport/anchor bookkeeping.
 */

import type { Block, ExternalToolStyle, ImageAttachment, ToolDisplayInfo } from "./messages";
import { formatSize, imageLabel } from "./clipboard";
import { markdownWordWrap } from "./markdown";
import { theme } from "./theme";
import { sanitizeUntrustedText } from "./terminaltext";
import { termWidth } from "./textwidth";
import { wordWrap, type WrapResult } from "./textwrap";
import { renderToolCallLogicalLines } from "./toolcalllogical";

interface BlockCacheEntry {
  /** Exact mutable source content at render time (detects rewrites, not just growth). */
  contentKey: string;
  /** Terminal content width used for wrapping. */
  width: number;
  /** Whether tool output was shown (affects tool_result blocks). */
  showToolOutput: boolean;
  /** Cached render result. */
  result: WrapResult;
}

const blockRenderCache = new WeakMap<Block, BlockCacheEntry>();

/** Exact mutable block content — used for cache invalidation. */
function blockContentKey(block: Block): string {
  switch (block.type) {
    case "thinking":
    case "text":
      return block.text;
    case "tool_call":
      return block.summary;
    case "tool_result":
      return block.output;
  }
}

export function renderBlockCached(
  block: Block,
  contentWidth: number,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  showToolOutput: boolean,
): WrapResult {
  const contentKey = blockContentKey(block);
  const cached = blockRenderCache.get(block);
  if (
    cached &&
    cached.contentKey === contentKey &&
    cached.width === contentWidth &&
    cached.showToolOutput === showToolOutput
  ) {
    return cached.result;
  }

  const result = renderBlock(block, contentWidth, toolRegistry, externalToolStyles, showToolOutput);
  blockRenderCache.set(block, { contentKey, width: contentWidth, showToolOutput, result });
  return result;
}

function renderBlock(
  block: Block,
  contentWidth: number,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  showToolOutput: boolean,
): WrapResult {
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  switch (block.type) {
    case "thinking": {
      const text = sanitizeUntrustedText(block.text);
      if (!text.trim()) break;
      const w = wordWrap(text, contentWidth);
      for (let i = 0; i < w.lines.length; i++) {
        lines.push(`  ${theme.dim}${theme.italic}${w.lines[i]}${theme.reset}`);
        cont.push(w.cont[i]);
        join.push(w.join[i]);
      }
      break;
    }
    case "text": {
      const text = sanitizeUntrustedText(block.text).replace(/^\n+/, "");
      const isHint = text.startsWith("[Context:");

      if (isHint) {
        // Context hints: plain dim text, no markdown processing
        const w = wordWrap(text, contentWidth);
        for (let i = 0; i < w.lines.length; i++) {
          lines.push(`  ${theme.dim}${w.lines[i]}${theme.reset}`);
          cont.push(w.cont[i]);
          join.push(w.join[i]);
        }
      } else {
        // Assistant text blocks: full markdown rendering.
        // markdownWordWrap handles code blocks, tables, HRs, inline
        // formatting, and word wrapping — output is fully formatted.
        const md = markdownWordWrap(text, contentWidth, theme.reset);
        for (let i = 0; i < md.lines.length; i++) {
          lines.push(`  ${md.lines[i]}`);
          cont.push(md.cont[i]);
          join.push(md.join[i]);
        }
      }
      break;
    }
    case "tool_call": {
      const summary = sanitizeUntrustedText(block.summary);
      const logical = renderToolCallLogicalLines(block.toolName, summary, toolRegistry, externalToolStyles);

      for (const entry of logical) {
        const w = wordWrap(entry.text, contentWidth - 2);
        for (let j = 0; j < w.lines.length; j++) {
          if (entry.hasLabel && j === 0) {
            const rest = w.lines[0].slice(entry.display.label.length);
            lines.push(`  ${entry.display.fg}${theme.bold}${entry.display.label}${theme.reset}${entry.display.fg}${rest}${theme.reset}`);
          } else {
            lines.push(`  ${entry.display.fg}${w.lines[j]}${theme.reset}`);
          }
          cont.push(w.cont[j]);
          join.push(w.join[j]);
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
      const trimmed = sanitizeUntrustedText(block.output).replace(/\n+$/, "");
      const outputLines = trimmed.split("\n");

      let first = true;
      for (const ol of outputLines) {
        const w = wordWrap(ol, contentWidth - contPrefix.length);
        for (let i = 0; i < w.lines.length; i++) {
          const prefix = first ? firstPrefix : contPrefix;
          first = false;
          lines.push(`${fg}${prefix}${w.lines[i]}${theme.reset}`);
          cont.push(w.cont[i]);
          join.push(w.join[i]);
        }
      }
      break;
    }
  }

  return { lines, cont, join };
}

export function renderUserMessage(text: string, cols: number, images?: ImageAttachment[]): WrapResult {
  text = sanitizeUntrustedText(text);
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

  const w = text ? wordWrap(text, innerWidth) : { lines: [] as string[], cont: [] as boolean[], join: [] as string[] };

  // Combine badges + text for width calculation
  const allContentLines = [...badgeLines, ...w.lines];
  if (allContentLines.length === 0) allContentLines.push("");

  // Size bubble to the longest line
  const bubbleWidth = Math.min(
    maxBubbleWidth,
    Math.max(...allContentLines.map(l => termWidth(l))) + padding * 2,
  );
  const inner = bubbleWidth - padding * 2;

  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const screenOffset = " ".repeat(Math.max(0, cols - bubbleWidth - margin));
  const padRight = " ".repeat(padding);

  /** Append a right-aligned bubble line with optional style prefix. */
  const pushBubbleLine = (lineText: string, isCont: boolean, joiner = "", style?: string) => {
    const padLeft = " ".repeat(Math.max(0, inner - termWidth(lineText)) + padding);
    const styledText = style ? `${style}${lineText}${theme.reset}${theme.userBg}` : lineText;
    lines.push(`${screenOffset}${theme.userBg}${padLeft}${styledText}${padRight}${theme.reset}`);
    cont.push(isCont);
    join.push(isCont ? joiner : "");
  };

  // Render text lines
  for (let i = 0; i < w.lines.length; i++) {
    pushBubbleLine(w.lines[i], w.cont[i], w.join[i]);
  }

  // Render image badges below text (dimmed)
  for (const badge of badgeLines) {
    pushBubbleLine(badge, false, "", theme.dim);
  }
  return { lines, cont, join };
}

export function renderSystemMessage(text: string, availableWidth: number, color?: string): string[] {
  const sysWidth = availableWidth - 2; // 2-char indent
  const width = sysWidth > 0 ? sysWidth : 1;
  const wrapped: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.includes("\x1b[")) {
      // Inline ANSI is used sparingly (for example /tokens heatmaps). Preserve
      // the authored line rather than letting the plain word wrapper split on
      // raw escape-sequence length instead of visible width.
      wrapped.push(rawLine);
      continue;
    }
    const lineWrap = wordWrap(rawLine, width);
    wrapped.push(...lineWrap.lines);
  }

  const style = color || theme.dim;
  return wrapped.map(sl => `  ${style}${sl}${theme.reset}`);
}
