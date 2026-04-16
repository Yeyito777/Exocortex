/**
 * Conversation rendering — messages, blocks, and text wrapping.
 *
 * Turns the message list + pendingAI into display lines.
 * The only file that knows how to render conversations.
 */

import type { Block, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, Message } from "./messages";
import type { RenderState } from "./state";
import { renderMetadata } from "./metadata";
import { resolveToolDisplay, resolveBashExternalMatch, type ResolvedToolDisplay, type BashExternalMatch } from "./toolstyles";
import { splitTopLevelShellSegments } from "./bashsegments";
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
  /** Exact mutable source content at render time (detects rewrites, not just growth). */
  contentKey: string;
  /** Terminal content width used for wrapping. */
  width: number;
  /** Whether tool output was shown (affects tool_result blocks). */
  showToolOutput: boolean;
  /** Cached render result. */
  result: WrapResult;
}

interface RenderLogicalLine {
  display: ResolvedToolDisplay;
  text: string;
  hasLabel: boolean;
}

interface SegmentedBashRenderOptions {
  requirePrompts: boolean;
  stripPromptPrefix: boolean;
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

function renderBlockCached(
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

function isPromptedBashTranscript(summary: string): boolean {
  const lines = summary.trimStart().split("\n");
  let sawPrompt = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    if (!line.trimStart().startsWith("$ ")) return false;
    sawPrompt = true;
  }

  return sawPrompt;
}

function pushLogicalLine(logical: RenderLogicalLine[], display: ResolvedToolDisplay, detail: string, hasLabel: boolean): void {
  logical.push({
    display,
    text: hasLabel ? (detail ? `${display.label} ${detail}` : display.label) : detail,
    hasLabel,
  });
}

function pushCommandDetail(logical: RenderLogicalLine[], display: ResolvedToolDisplay): void {
  if (!display.cmd || !display.detail) {
    pushLogicalLine(logical, display, display.detail, true);
    return;
  }

  const cmd = display.cmd;
  for (const [i, line] of display.detail.split("\n").entries()) {
    if (i === 0) {
      pushLogicalLine(logical, display, line, true);
      continue;
    }

    const t = line.trimStart();
    if (t === cmd || t.startsWith(cmd + " ")) {
      const args = t.slice(cmd.length).trimStart();
      pushLogicalLine(logical, display, args, true);
    } else {
      pushLogicalLine(logical, display, line, false);
    }
  }
}

function appendMatchedBashSegment(
  logical: RenderLogicalLine[],
  bashDisplay: ResolvedToolDisplay,
  text: string,
  match: BashExternalMatch | null,
): void {
  if (match && match.matchLineIndex === 0) {
    const prefix = match.lines[0]?.slice(0, match.matchStart).trimEnd() ?? "";
    if (prefix.trim()) pushLogicalLine(logical, bashDisplay, prefix, true);
    pushCommandDetail(logical, match.display);
    return;
  }

  pushLogicalLine(logical, bashDisplay, text, true);
}

function renderSegmentedBashLines(
  summary: string,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  options: SegmentedBashRenderOptions,
): RenderLogicalLine[] | null {
  if (options.requirePrompts && !isPromptedBashTranscript(summary)) return null;

  const rawLines = summary.trimStart().split("\n");
  const parsedLines = rawLines.map((rawLine) => {
    const trimmed = rawLine.trimStart();
    const commandLine = options.stripPromptPrefix && trimmed.startsWith("$ ")
      ? trimmed.slice(2)
      : rawLine;
    const lineText = options.stripPromptPrefix ? commandLine : rawLine;
    const lineMatch = resolveBashExternalMatch(lineText, externalToolStyles);
    const segments = splitTopLevelShellSegments(commandLine);
    const matches = segments.map((segment) => {
      const text = segment.text.trim();
      return text ? resolveBashExternalMatch(text, externalToolStyles) : null;
    });
    const nonEmptySegments = segments.filter(segment => segment.text.trim());
    const hasSegmentMatch = matches.some(Boolean);
    return { rawLine, commandLine, lineText, lineMatch, segments, matches, nonEmptySegments, hasSegmentMatch };
  });

  if (!options.requirePrompts) {
    const hasMixedLine = parsedLines.some(({ nonEmptySegments, hasSegmentMatch }) =>
      nonEmptySegments.length > 1 && hasSegmentMatch);
    if (!hasMixedLine) return null;
  }

  const logical: RenderLogicalLine[] = [];
  const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);

  for (const { rawLine, lineText, lineMatch, segments, matches, nonEmptySegments, hasSegmentMatch } of parsedLines) {
    if (!rawLine.trim()) {
      pushLogicalLine(logical, bashDisplay, "", false);
      continue;
    }

    if (lineMatch || nonEmptySegments.length <= 1 || !hasSegmentMatch) {
      appendMatchedBashSegment(logical, bashDisplay, lineText, lineMatch);
      continue;
    }

    for (const [index, segment] of segments.entries()) {
      const text = segment.text.trim();
      if (!text) continue;

      const startIndex = logical.length;
      appendMatchedBashSegment(logical, bashDisplay, text, matches[index]);

      if (segment.separator && logical.length > startIndex) {
        logical[logical.length - 1].text += ` ${segment.separator}`;
      }
    }
  }

  return logical;
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
        const md = markdownWordWrap(text, contentWidth, theme.reset);
        for (let i = 0; i < md.lines.length; i++) {
          lines.push(`  ${md.lines[i]}`);
          cont.push(md.cont[i]);
        }
      }
      break;
    }
    case "tool_call": {
      const display = resolveToolDisplay(block.toolName, block.summary, toolRegistry, externalToolStyles);

      // Build logical display lines. Each entry carries its own display,
      // so bash blocks can mix plain bash prelude lines with styled
      // external-tool lines without dropping the setup commands.
      const logical = block.toolName === "bash"
        ? renderSegmentedBashLines(block.summary, toolRegistry, externalToolStyles, {
            requirePrompts: true,
            stripPromptPrefix: true,
          })
          ?? renderSegmentedBashLines(block.summary, toolRegistry, externalToolStyles, {
            requirePrompts: false,
            stripPromptPrefix: false,
          })
          ?? []
        : [];

      if (logical.length === 0) {
        const bashExternal = block.toolName === "bash"
          ? resolveBashExternalMatch(block.summary, externalToolStyles)
          : null;

        if (bashExternal) {
          const bashDisplay = resolveToolDisplay("bash", "", toolRegistry, []);

          for (const [lineIndex, rawLine] of bashExternal.lines.entries()) {
            if (lineIndex < bashExternal.matchLineIndex) {
              const trimmed = rawLine.trimStart();
              if (!trimmed) pushLogicalLine(logical, bashDisplay, "", false);
              else pushLogicalLine(logical, bashDisplay, rawLine, true);
              continue;
            }

            if (lineIndex === bashExternal.matchLineIndex) {
              const prefix = rawLine.slice(0, bashExternal.matchStart).trimEnd();
              if (prefix.trim()) pushLogicalLine(logical, bashDisplay, prefix, true);
              pushCommandDetail(logical, bashExternal.display);
            }
            break;
          }
        } else {
          pushCommandDetail(logical, display);
        }
      }

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

function renderSystemMessage(text: string, availableWidth: number, color?: string): string[] {
  const sysWidth = availableWidth - 2; // 2-char indent
  const { lines: wrapped } = wordWrap(text, sysWidth > 0 ? sysWidth : 1);
  const style = color || theme.dim;
  return wrapped.map(sl => `  ${style}${sl}${theme.reset}`);
}

// ── Message boundary tracking ───────────────────────────────────────

/** Row range for a single message in the rendered history lines. */
export interface MessageBound {
  /** Message role backing this rendered range. */
  role: Message["role"];
  /** First line index (inclusive). */
  start: number;
  /** Last line index (exclusive). */
  end: number;
  /** Start of primary content (inclusive), after margins. */
  contentStart: number;
  /** End of primary content (exclusive), before metadata/padding. im uses this. */
  contentEnd: number;
}

export type RenderLineSegment =
  | "assistant_block"
  | "assistant_metadata"
  | "queued_content"
  | "queued_label"
  | "queued_margin_top"
  | "streaming_tail"
  | "system_instructions_bottom"
  | "system_instructions_content"
  | "system_instructions_top"
  | "system_message"
  | "user_content"
  | "user_margin_bottom"
  | "user_margin_top";

export interface RenderLineAnchor {
  /** Stable owner identity for this rendered segment (message/block/queued item). */
  owner: object;
  /** Segment within the owner (content, metadata, margins, etc). */
  segment: RenderLineSegment;
  /** Logical line index within the segment (increments on hard newlines / semantic rows). */
  index: number;
  /** Wrapped visual row within that logical line (0 for the first row). */
  subIndex: number;
}

export interface BuildMessageLinesResult {
  lines: string[];
  messageBounds: MessageBound[];
  wrapContinuation: boolean[];
  /**
   * Stable per-line anchors used to preserve viewport/cursor position across
   * re-renders when optional blocks appear/disappear (for example Ctrl+O tool
   * result expansion).
   */
  lineAnchors: RenderLineAnchor[];
}

// ── Build all display lines ─────────────────────────────────────────

export function buildMessageLines(
  state: RenderState,
  availableWidth: number,
): BuildMessageLinesResult {
  const contentWidth = availableWidth - 4;
  const lines: string[] = [];
  const wrapContinuation: boolean[] = [];
  const messageBounds: MessageBound[] = [];
  const lineAnchors: RenderLineAnchor[] = [];

  const pushAnchoredLine = (
    line: string,
    cont: boolean,
    owner: object,
    segment: RenderLineSegment,
    index: number,
    subIndex: number,
  ) => {
    lines.push(line);
    wrapContinuation.push(cont);
    lineAnchors.push({ owner, segment, index, subIndex });
  };

  /** Append block result (lines + continuation flags). */
  const pushBlock = (owner: object, segment: RenderLineSegment, br: WrapResult) => {
    let logicalIndex = -1;
    let subIndex = 0;
    for (let i = 0; i < br.lines.length; i++) {
      if (i === 0 || !br.cont[i]) {
        logicalIndex++;
        subIndex = 0;
      } else {
        subIndex++;
      }
      pushAnchoredLine(br.lines[i], br.cont[i], owner, segment, logicalIndex, subIndex);
    }
  };

  /** Append a non-wrapped line (margin, metadata, etc). */
  const pushLine = (line: string, owner: object, segment: RenderLineSegment, index = 0) => {
    pushAnchoredLine(line, false, owner, segment, index, 0);
  };

  const pushMessageBound = (
    role: Message["role"],
    start: number,
    contentStart: number,
    contentEnd: number,
  ) => {
    messageBounds.push({ role, start, end: lines.length, contentStart, contentEnd });
  };

  let firstUser = true;
  for (const msg of state.messages) {
    const start = lines.length;
    if (msg.role === "user") {
      if (!firstUser) pushLine("", msg, "user_margin_top");  // top margin (skip for first)
      const contentStart = lines.length;
      pushBlock(msg, "user_content", renderUserMessage(msg.text, availableWidth, msg.images));
      const contentEnd = lines.length;
      pushLine("", msg, "user_margin_bottom");               // bottom margin
      firstUser = false;
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "assistant") {
      // AI messages: content blocks, then metadata
      const contentStart = lines.length;
      for (const block of msg.blocks) {
        pushBlock(block, "assistant_block", renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
      }
      const contentEnd = lines.length;
      const metadataLines = renderMetadata(msg.metadata);
      for (let i = 0; i < metadataLines.length; i++) pushLine(metadataLines[i], msg, "assistant_metadata", i);
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else if (msg.role === "system_instructions") {
      if (!msg.text.trim()) {
        pushMessageBound(msg.role, start, start, lines.length);
        continue;
      }
      const boxWidth = availableWidth;
      const textWidth = boxWidth - 4; // │ + space + text + space + │
      const title = " System Instructions ";
      const topFill = Math.max(0, boxWidth - 2 - title.length); // -2 for ┌ and ┐
      const topLine = `┌${title}${"─".repeat(topFill)}┐`;
      const bottomLine = `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`;

      pushLine(`${theme.accent}${topLine}${theme.reset}`, msg, "system_instructions_top");
      const contentStart = lines.length;

      const { lines: wrapped } = wordWrap(msg.text, textWidth > 0 ? textWidth : 1);
      for (let i = 0; i < wrapped.length; i++) {
        const sl = wrapped[i];
        const pad = " ".repeat(Math.max(0, textWidth - sl.length));
        pushLine(`${theme.accent}│${theme.reset} ${theme.dim}${sl}${pad}${theme.reset} ${theme.accent}│${theme.reset}`, msg, "system_instructions_content", i);
      }
      const contentEnd = lines.length;

      pushLine(`${theme.accent}${bottomLine}${theme.reset}`, msg, "system_instructions_bottom");
      pushMessageBound(msg.role, start, contentStart, contentEnd);
    } else {
      const sysLines = renderSystemMessage(msg.text, availableWidth, msg.color);
      for (let i = 0; i < sysLines.length; i++) {
        pushLine(sysLines[i], msg, "system_message", i);
      }
      pushMessageBound(msg.role, start, start, lines.length);
    }
  }

  // Currently streaming AI message — no margins
  if (state.pendingAI) {
    const start = lines.length;
    for (const block of state.pendingAI.blocks) {
      pushBlock(block, "assistant_block", renderBlockCached(block, contentWidth, state.toolRegistry, state.externalToolStyles, state.showToolOutput));
    }
    const contentEnd = lines.length;
    const metadataLines = renderMetadata(state.pendingAI.metadata);
    for (let i = 0; i < metadataLines.length; i++) pushLine(metadataLines[i], state.pendingAI, "assistant_metadata", i);
    pushMessageBound(state.pendingAI.role, start, start, contentEnd);
  }

  // Live user-notice tail during streaming. These are buffered in state and
  // rendered after pendingAI so slash-command feedback stays visible at the
  // bottom instead of getting buried above a growing assistant message.
  for (const msg of state.streamingTailMessages ?? []) {
    const start = lines.length;
    const sysLines = renderSystemMessage(msg.text, availableWidth, msg.color);
    for (let i = 0; i < sysLines.length; i++) {
      pushLine(sysLines[i], msg, "streaming_tail", i);
    }
    pushMessageBound(msg.role, start, start, lines.length);
  }

  // Queued messages — dimmed user bubbles with timing label (after pendingAI)
  if (state.convId) {
    const queued = state.queuedMessages.filter(qm => qm.convId === state.convId);
    for (const qm of queued) {
      const timingLabel = qm.timing === "next-turn" ? "queued: next turn" : "queued: message end";
      pushLine("", qm, "queued_margin_top");
      // Render a dimmed user bubble
      const qr = renderUserMessage(qm.text, availableWidth, qm.images);
      for (let i = 0; i < qr.lines.length; i++) {
        pushLine(`${theme.muted}${qr.lines[i]}${theme.reset}`, qm, "queued_content", i);
      }
      // Timing label — right-aligned, muted italic
      const labelPad = " ".repeat(Math.max(0, availableWidth - timingLabel.length - 3));
      pushLine(`${labelPad}${theme.muted}${theme.italic}${timingLabel}${theme.reset}`, qm, "queued_label");
    }
  }

  return { lines, messageBounds, wrapContinuation, lineAnchors };
}
