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
import { sliceByWidthFrom, termWidth } from "./textwidth";
import { wordWrap, type WrapResult } from "./textwrap";
import { renderToolCallLogicalLines } from "./toolcalllogical";

interface BlockCacheEntry {
  /** Exact mutable source content at render time (detects rewrites, not just growth). */
  contentKey: string;
  /** Terminal content width used for wrapping. */
  width: number;
  /** Whether tool output was shown (affects tool_result blocks). */
  showToolOutput: boolean;
  /** Theme name used to produce ANSI styling. */
  themeName: string;
  /** Tool style registries used by tool_call rendering. */
  toolRegistryRef: ToolDisplayInfo[];
  externalToolStylesRef: ExternalToolStyle[];
  /** Cached render result. */
  result: WrapResult;
}

const blockRenderCache = new WeakMap<Block, BlockCacheEntry>();

interface UserMessageCacheEntry {
  text: string;
  cols: number;
  imagesKey: string;
  themeName: string;
  result: WrapResult;
}

const userMessageRenderCache = new WeakMap<object, UserMessageCacheEntry>();

function imageAttachmentsKey(images: ImageAttachment[] | undefined): string {
  if (!images?.length) return "";
  return images.map(img => `${img.mediaType}:${img.sizeBytes}`).join("|");
}

/** Exact mutable block content — used for cache invalidation. */
function blockContentKey(block: Block): string {
  switch (block.type) {
    case "thinking":
    case "text":
      return block.text;
    case "tool_call":
      return `${block.summary}\n${JSON.stringify(block.input)}`;
    case "tool_result":
      return block.output;
  }
}

function shortValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (value == null) text = String(value);
  else text = JSON.stringify(value);
  if (text.length > 160) text = `${text.slice(0, 157)}…`;
  return text;
}

const COMPUTER_ARG_ORDER = [
  "target",
  "app",
  "include_screenshot",
  "max_elements",
  "element_index",
  "x",
  "y",
  "click_count",
  "mouse_button",
  "from_x",
  "from_y",
  "to_x",
  "to_y",
  "text",
  "key",
  "direction",
  "pages",
  "value",
  "action",
];

function formatComputerToolCallSummary(toolName: string, input: Record<string, unknown>): string {
  const action = toolName.replace(/^computer_/, "");
  const keys = [
    ...COMPUTER_ARG_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(input, key)),
    ...Object.keys(input).filter((key) => !COMPUTER_ARG_ORDER.includes(key)).sort(),
  ];
  const args = keys
    .filter((key) => input[key] !== undefined)
    .map((key) => `${key}=${shortValue(input[key])}`)
    .join(" ");
  const detail = args ? `${action} ${args}` : action;
  return detail.length > 520 ? `${detail.slice(0, 517)}…` : detail;
}

function toolCallSummaryForRender(block: Extract<Block, { type: "tool_call" }>): string {
  if (block.toolName.startsWith("computer_")) return formatComputerToolCallSummary(block.toolName, block.input);
  return block.summary;
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
    cached.showToolOutput === showToolOutput &&
    cached.themeName === theme.name &&
    cached.toolRegistryRef === toolRegistry &&
    cached.externalToolStylesRef === externalToolStyles
  ) {
    return cached.result;
  }

  const result = renderBlock(block, contentWidth, toolRegistry, externalToolStyles, showToolOutput);
  blockRenderCache.set(block, {
    contentKey,
    width: contentWidth,
    showToolOutput,
    themeName: theme.name,
    toolRegistryRef: toolRegistry,
    externalToolStylesRef: externalToolStyles,
    result,
  });
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
  const copy: WrapResult["copy"] = [];

  switch (block.type) {
    case "thinking": {
      const text = sanitizeUntrustedText(block.text);
      if (!text.trim()) break;
      const w = wordWrap(text, contentWidth);
      for (let i = 0; i < w.lines.length; i++) {
        lines.push(`  ${theme.dim}${theme.italic}${w.lines[i]}${theme.reset}`);
        cont.push(w.cont[i]);
        join.push(w.join[i]);
        copy.push(null);
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
          copy.push(null);
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
          const copyLine = md.copy?.[i] ?? null;
          copy.push(copyLine ? { ...copyLine, displayStart: copyLine.displayStart + 2 } : null);
        }
      }
      break;
    }
    case "tool_call": {
      const summary = sanitizeUntrustedText(toolCallSummaryForRender(block));
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
          copy.push(null);
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
          copy.push(null);
        }
      }
      break;
    }
  }

  return { lines, cont, join, copy };
}

const USER_BUBBLE_PADDING = 1;
const USER_BUBBLE_MARGIN = 2;

interface UserTextRowTake {
  text: string;
  sourceStart: number;
  nextOffset: number;
}

export interface UserMessageFlowCursor {
  /** Hard-line index in sanitizedText.split("\n"). */
  lineIndex: number;
  /** UTF-16 offset within that hard line. */
  offset: number;
}

export interface AdaptiveUserMessageRow {
  line: string;
  /** Width-independent position in the sanitized user-message text. */
  sourceStart: UserMessageFlowCursor;
  /** Position at which the following row should resume. */
  nextCursor: UserMessageFlowCursor;
}

function trimUserTextStart(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end) {
    const cp = text.codePointAt(cursor)!;
    const char = String.fromCodePoint(cp);
    if (char.trimStart() !== "") break;
    cursor += cp > 0xFFFF ? 2 : 1;
  }
  return cursor;
}

/**
 * Consume one word-wrapped row while retaining the source offset of the next
 * row. This deliberately mirrors textwrap.wordWrap's ASCII-space preference.
 */
function takeUserTextRow(text: string, sourceStart: number, sourceEnd: number, width: number): UserTextRowTake {
  const [fitEnd] = sliceByWidthFrom(text, sourceStart, Math.max(1, width));
  if (fitEnd >= sourceEnd) {
    return { text: text.slice(sourceStart, sourceEnd), sourceStart, nextOffset: sourceEnd };
  }

  const fit = text.slice(sourceStart, fitEnd);
  const breakRel = fit.lastIndexOf(" ");
  let breakAt = breakRel > 0 ? sourceStart + breakRel : -1;

  if (breakRel <= 0 && fitEnd > sourceStart && text[fitEnd] === " ") {
    breakAt = fitEnd;
  }
  if (breakAt <= sourceStart) {
    if (fitEnd > sourceStart) {
      breakAt = fitEnd;
    } else {
      const cp = text.codePointAt(sourceStart)!;
      breakAt = sourceStart + (cp > 0xFFFF ? 2 : 1);
    }
  }

  return {
    text: text.slice(sourceStart, breakAt),
    sourceStart,
    nextOffset: trimUserTextStart(text, breakAt, sourceEnd),
  };
}

/**
 * Source starts for the rows produced by the ordinary, constant-width user
 * bubble. Mixed-width viewport composition uses these to map its rows back to
 * canonical history rows without treating a prior visual wrap as a hard break.
 *
 * Attachment messages intentionally return null because their semantic rows
 * include display-only badges. Hard line breaks (including empty lines) are
 * represented explicitly by the flow cursor.
 */
export function userMessageTextRowOffsets(
  text: string,
  cols: number,
  images?: ImageAttachment[],
): { starts: UserMessageFlowCursor[]; end: UserMessageFlowCursor } | null {
  const sanitized = sanitizeUntrustedText(text);
  if (!sanitized || images?.length) return null;

  const starts: UserMessageFlowCursor[] = [];
  const innerWidth = Math.max(1, cols - USER_BUBBLE_MARGIN - 1 - USER_BUBBLE_PADDING * 2);
  const hardLines = sanitized.split("\n");
  for (let lineIndex = 0; lineIndex < hardLines.length; lineIndex++) {
    const hardLine = hardLines[lineIndex];
    if (hardLine.length === 0) {
      starts.push({ lineIndex, offset: 0 });
      continue;
    }

    let offset = 0;
    while (offset < hardLine.length) {
      const row = takeUserTextRow(hardLine, offset, hardLine.length, innerWidth);
      starts.push({ lineIndex, offset: row.sourceStart });
      if (row.nextOffset <= offset) return null;
      offset = row.nextOffset;
    }
  }
  return { starts, end: { lineIndex: hardLines.length, offset: 0 } };
}

export function compareUserMessageFlowCursors(
  left: UserMessageFlowCursor,
  right: UserMessageFlowCursor,
): number {
  return left.lineIndex - right.lineIndex || left.offset - right.offset;
}

/**
 * Render one user-message text flow across row-dependent widths. Wrapping is
 * continuous when the task-panel float ends: the first full-width row resumes
 * exactly where the final narrow row stopped instead of restarting at a
 * full-width bubble boundary.
 */
export function renderAdaptiveUserMessageRows(
  text: string,
  sourceStart: UserMessageFlowCursor,
  sourceEnd: UserMessageFlowCursor,
  colsForRow: (rowIndex: number) => number,
): AdaptiveUserMessageRow[] {
  const sanitized = sanitizeUntrustedText(text);
  const hardLines = sanitized.split("\n");
  const clampCursor = (cursor: UserMessageFlowCursor): UserMessageFlowCursor => {
    const lineIndex = Math.max(0, Math.min(cursor.lineIndex, hardLines.length));
    if (lineIndex === hardLines.length) return { lineIndex, offset: 0 };
    return { lineIndex, offset: Math.max(0, Math.min(cursor.offset, hardLines[lineIndex].length)) };
  };
  const end = clampCursor(sourceEnd);
  let cursor = clampCursor(sourceStart);
  const rawRows: Array<{
    text: string;
    sourceStart: UserMessageFlowCursor;
    nextCursor: UserMessageFlowCursor;
    cols: number;
  }> = [];

  while (compareUserMessageFlowCursors(cursor, end) < 0) {
    const cols = Math.max(1, colsForRow(rawRows.length));
    const innerWidth = Math.max(1, cols - USER_BUBBLE_MARGIN - 1 - USER_BUBBLE_PADDING * 2);
    const hardLine = hardLines[cursor.lineIndex] ?? "";

    if (hardLine.length === 0) {
      const nextCursor = { lineIndex: cursor.lineIndex + 1, offset: 0 };
      rawRows.push({ text: "", sourceStart: cursor, nextCursor, cols });
      cursor = nextCursor;
      continue;
    }

    const rowEnd = end.lineIndex === cursor.lineIndex ? end.offset : hardLine.length;
    if (cursor.offset >= rowEnd) {
      cursor = { lineIndex: cursor.lineIndex + 1, offset: 0 };
      continue;
    }
    const row = takeUserTextRow(hardLine, cursor.offset, rowEnd, innerWidth);
    const nextCursor = row.nextOffset >= hardLine.length && cursor.lineIndex < end.lineIndex
      ? { lineIndex: cursor.lineIndex + 1, offset: 0 }
      : { lineIndex: cursor.lineIndex, offset: row.nextOffset };
    rawRows.push({ text: row.text, sourceStart: cursor, nextCursor, cols });
    if (compareUserMessageFlowCursors(nextCursor, cursor) <= 0) break;
    cursor = nextCursor;
  }

  const rendered: AdaptiveUserMessageRow[] = [];
  for (let runStart = 0; runStart < rawRows.length;) {
    const cols = rawRows[runStart].cols;
    let runEnd = runStart + 1;
    while (runEnd < rawRows.length && rawRows[runEnd].cols === cols) runEnd++;

    const maxBubbleWidth = Math.max(1, cols - USER_BUBBLE_MARGIN - 1);
    const bubbleWidth = Math.min(
      maxBubbleWidth,
      Math.max(...rawRows.slice(runStart, runEnd).map(row => termWidth(row.text))) + USER_BUBBLE_PADDING * 2,
    );
    const inner = Math.max(0, bubbleWidth - USER_BUBBLE_PADDING * 2);
    const screenOffset = " ".repeat(Math.max(0, cols - bubbleWidth - USER_BUBBLE_MARGIN));
    const padRight = " ".repeat(USER_BUBBLE_PADDING);

    for (let index = runStart; index < runEnd; index++) {
      const row = rawRows[index];
      const padLeft = " ".repeat(Math.max(0, inner - termWidth(row.text)) + USER_BUBBLE_PADDING);
      rendered.push({
        line: `${screenOffset}${theme.userBg}${padLeft}${row.text}${padRight}${theme.reset}`,
        sourceStart: row.sourceStart,
        nextCursor: row.nextCursor,
      });
    }
    runStart = runEnd;
  }
  return rendered;
}

export function renderUserMessage(text: string, cols: number, images?: ImageAttachment[]): WrapResult {
  text = sanitizeUntrustedText(text);
  const padding = USER_BUBBLE_PADDING; // horizontal padding inside bubble
  const margin = USER_BUBBLE_MARGIN;   // gap from right edge of screen
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

export function renderUserMessageCached(owner: object, text: string, cols: number, images?: ImageAttachment[]): WrapResult {
  const imagesKey = imageAttachmentsKey(images);
  const cached = userMessageRenderCache.get(owner);
  if (cached && cached.text === text && cached.cols === cols && cached.imagesKey === imagesKey && cached.themeName === theme.name) {
    return cached.result;
  }

  const result = renderUserMessage(text, cols, images);
  userMessageRenderCache.set(owner, { text, cols, imagesKey, themeName: theme.name, result });
  return result;
}

export function renderSystemMessage(text: string, availableWidth: number, color?: string): WrapResult {
  const sysWidth = availableWidth - 2; // 2-char indent
  const width = sysWidth > 0 ? sysWidth : 1;
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.includes("\x1b[")) {
      // Inline ANSI is used sparingly (for example /tokens heatmaps). Preserve
      // the authored line rather than letting the plain word wrapper split on
      // raw escape-sequence length instead of visible width.
      lines.push(rawLine);
      cont.push(false);
      join.push("");
      continue;
    }
    const lineWrap = wordWrap(rawLine, width);
    lines.push(...lineWrap.lines);
    cont.push(...lineWrap.cont);
    join.push(...lineWrap.join);
  }

  const style = color || theme.dim;
  return {
    lines: lines.map(sl => `  ${style}${sl}${theme.reset}`),
    cont,
    join,
  };
}
