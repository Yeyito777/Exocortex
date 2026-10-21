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
import { wrapAnsiLine } from "./ansiwrap";
import { sanitizeUntrustedText, sanitizeUntrustedTextKeepingSgr } from "./terminaltext";
import { sliceByWidthFrom, termWidth } from "./textwidth";
import { wordWrap, type WrapImage, type WrapResult } from "./textwrap";
import { createDisplayMathImageRenderer, mathImageCacheKey, mathImageGeneration, type DisplayMathImageRenderer } from "./mathimages";
import { renderToolCallLogicalLines, type ToolCallLogicalLine } from "./toolcalllogical";
import { CODE_GUTTER } from "./markdown/codeblocks";
import { formatMarkdownChunks } from "./markdown/formatting";
import { highlightLine } from "./markdown/highlight";
import { RehydratedRenderCache } from "./rehydrated-render-cache";

interface BlockCacheEntry {
  /** Exact mutable source content at render time (detects rewrites, not just growth). */
  contentKey: string;
  /** The block fields `contentKey` was derived from, compared by identity first. */
  sourceRefs: BlockSourceRefs;
  /** Terminal content width used for wrapping. */
  width: number;
  /** Whether tool output was shown (affects tool_result blocks). */
  showToolOutput: boolean;
  /** Whether this tool_call has a matching errored tool_result. */
  toolCallErrored: boolean;
  /** Theme name used to produce ANSI styling. */
  themeName: string;
  /** Tool style registries used by tool_call rendering. */
  toolRegistryRef: ToolDisplayInfo[];
  externalToolStylesRef: ExternalToolStyle[];
  /** Display-math image environment ("" when this caller renders math as text). */
  mathKey: string;
  /** Math image generation when rendered; only matters while `result.mathPending`. */
  mathGeneration: number;
  /** Cached render result. */
  result: WrapResult;
}

const blockRenderCache = new WeakMap<Block, BlockCacheEntry>();
const HIDDEN_TOOL_RESULT: WrapResult = { lines: [], cont: [], join: [], copy: [], links: [] };
const rehydratedBlockRenderCache = new RehydratedRenderCache<BlockCacheEntry>();

function wrapResultBytes(result: WrapResult): number {
  // Account for strings plus row/copy/link array objects without serializing the
  // entire rendered history just to decide whether to cache it.
  let bytes = result.lines.length * 256;
  for (const line of result.lines) bytes += line.length * 2;
  for (const line of result.copy ?? []) bytes += (line?.text.length ?? 0) * 2;
  for (const spans of result.links ?? []) {
    for (const span of spans ?? []) bytes += 128 + span.target.length * 2;
  }
  return bytes;
}

interface UserMessageCacheEntry {
  text: string;
  cols: number;
  imagesKey: string;
  themeName: string;
  background: string;
  result: WrapResult;
  flowDocument?: UserMessageFlowDocument;
  flow?: { starts: UserMessageFlowCursor[]; end: UserMessageFlowCursor } | null;
}

const userMessageRenderCache = new WeakMap<object, UserMessageCacheEntry>();

function imageAttachmentsKey(images: ImageAttachment[] | undefined): string {
  if (!images?.length) return "";
  return images.map(img => `${img.mediaType}:${img.sizeBytes}`).join("|");
}

type BlockSourceRefs = readonly unknown[];

/**
 * The fields that make up a block's content key. Block fields are replaced, not
 * mutated in place, so identical references mean identical content without
 * re-serializing a tool call's (possibly huge) input on every frame.
 */
function blockSourceRefs(block: Block): BlockSourceRefs {
  switch (block.type) {
    case "thinking":
    case "text":
      return [block.text];
    case "tool_call":
      return [block.toolName, block.summary, block.input, block.presentation];
    case "tool_result":
      return [block.isError, block.output];
  }
}

function sameSourceRefs(refs: BlockSourceRefs, block: Block): boolean {
  switch (block.type) {
    case "thinking":
    case "text":
      return refs[0] === block.text;
    case "tool_call":
      return refs[0] === block.toolName && refs[1] === block.summary
        && refs[2] === block.input && refs[3] === block.presentation;
    case "tool_result":
      return refs[0] === block.isError && refs[1] === block.output;
  }
}

const NO_SOURCE_REFS: BlockSourceRefs = [];

/** Exact mutable block content — used for cache invalidation. */
function blockContentKey(block: Block): string {
  switch (block.type) {
    case "thinking":
    case "text":
      return block.text;
    case "tool_call":
      return JSON.stringify([block.toolName, block.summary, block.input, block.presentation ?? null]);
    case "tool_result":
      return `${block.isError === true}:${block.output}`;
  }
}

function callLocalBashStyles(block: Extract<Block, { type: "tool_call" }>): ExternalToolStyle[] {
  const styles = block.presentation?.bashStyles;
  if (!Array.isArray(styles)) return [];
  return styles.slice(0, 16).filter((style): style is ExternalToolStyle => (
    !!style
    && typeof style === "object"
    && typeof style.cmd === "string"
    && style.cmd.length > 0
    && style.cmd.length <= 1_024
    && !/[\u0000-\u001f\u007f-\u009f]/.test(style.cmd)
    && typeof style.label === "string"
    && style.label.length > 0
    && style.label.length <= 64
    && !/[\u0000-\u001f\u007f-\u009f]/.test(style.label)
    && typeof style.color === "string"
    && /^#[0-9a-fA-F]{6}$/.test(style.color)
  ));
}

/**
 * An `exo` subagent call shows its full instructions. History persisted its
 * display summary when the call was made, and older summaries cut the prompt
 * at 100 characters; the call's input still holds all of it.
 */
function toolCallSummary(block: Extract<Block, { type: "tool_call" }>): string {
  const prompt = block.toolName === "exo" && !block.presentation?.detail ? block.input?.subagent : undefined;
  return typeof prompt === "string" && prompt.trim() ? `subagent: ${prompt.trim()}` : block.summary;
}

/**
 * A non-shell tool call longer than this many rows (e.g. a long `exo`
 * subagent prompt) shows only its first COLLAPSED_TOOL_CALL_ROWS while tool
 * output is collapsed; shorter ones wrap in full like shell commands.
 */
const COLLAPSE_TOOL_CALL_AFTER_ROWS = 12;
const COLLAPSED_TOOL_CALL_ROWS = 8;
const SHELL_TOOL_NAMES = new Set(["bash", "Bash", "exec_command"]);

/**
 * Shell commands always render in full. Other tool calls whose detail is long,
 * such as a subagent's full instructions, collapse behind the tool-output
 * toggle instead of flooding the chat; expanding it shows every row.
 */
function collapseLongToolCallDetail(
  toolName: string,
  showToolOutput: boolean,
  firstRow: number,
  lines: string[],
  cont: boolean[],
  join: string[],
  copy: NonNullable<WrapResult["copy"]>,
): void {
  const rows = lines.length - firstRow;
  if (showToolOutput || SHELL_TOOL_NAMES.has(toolName) || rows <= COLLAPSE_TOOL_CALL_AFTER_ROWS) return;
  const hidden = rows - COLLAPSED_TOOL_CALL_ROWS;
  const keep = firstRow + COLLAPSED_TOOL_CALL_ROWS;
  for (const rows of [lines, cont, join, copy]) rows.length = keep;
  lines.push(`  ${theme.dim}… +${hidden} more lines (ctrl+i to expand)${theme.reset}`);
  cont.push(false);
  join.push("");
  copy.push(null);
}

/** Payload rows sit under the command, behind a gutter in the receiving tool's colour. */
const PAYLOAD_INDENT = "    ";
const PAYLOAD_GUTTER = `${CODE_GUTTER} `;

/**
 * Render one heredoc/stdin payload block. Long bodies collapse behind the
 * tool-output toggle like long tool-call details; the closing delimiter stays.
 */
function renderToolCallPayload(
  entries: ToolCallLogicalLine[],
  contentWidth: number,
  showToolOutput: boolean,
  lines: string[],
  cont: boolean[],
  join: string[],
  copy: NonNullable<WrapResult["copy"]>,
): void {
  const { block } = entries[0].payload!;
  const fg = entries[0].display.fg;
  const isTool = block.kind === "tool";
  const gutter = `${PAYLOAD_INDENT}${isTool ? fg : theme.muted}${PAYLOAD_GUTTER}${theme.reset}`;
  const width = Math.max(1, contentWidth - PAYLOAD_INDENT.length - PAYLOAD_GUTTER.length);
  const push = (text: string, isCont: boolean, joiner: string) => {
    lines.push(`${gutter}${text}${theme.reset}`);
    cont.push(isCont);
    join.push(joiner);
    copy.push(null);
  };

  const body: Array<{ text: string; cont: boolean; join: string }> = [];
  for (const entry of entries) {
    if (entry.payload!.role !== "body") continue;
    const w = wordWrap(entry.text, width);
    const styled = isTool && block.markdown
      ? formatMarkdownChunks(w.lines, w.join, `${theme.reset}${fg}`).map(line => `${fg}${line}`)
      : w.lines.map(line => isTool
        ? `${fg}${line}`
        : block.language ? highlightLine(line, block.language) : `${theme.muted}${line}`);
    for (let j = 0; j < styled.length; j++) body.push({ text: styled[j], cont: w.cont[j], join: w.join[j] });
  }

  const title = entries.find(entry => entry.payload!.role === "title");
  if (title) {
    const label = title.display.label;
    push(`${fg}${theme.bold}${label}${theme.boldOff}${theme.dim}${title.text.slice(label.length)}`, false, "");
  }
  const collapse = !showToolOutput && body.length > COLLAPSE_TOOL_CALL_AFTER_ROWS;
  for (const row of collapse ? body.slice(0, COLLAPSED_TOOL_CALL_ROWS) : body) push(row.text, row.cont, row.join);
  if (collapse) push(`${theme.dim}… +${body.length - COLLAPSED_TOOL_CALL_ROWS} more lines (ctrl+i to expand)`, false, "");
  const end = entries.find(entry => entry.payload!.role === "end");
  if (end) push(`${theme.dim}${end.text}`, false, "");
}

export function renderBlockCached(
  block: Block,
  contentWidth: number,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  showToolOutput: boolean,
  toolCallErrored = false,
  /** Draw display math as images (history only: it places them). */
  mathImages = false,
): WrapResult {
  // Hidden results render nothing; do not key a cache on a possibly huge body.
  if (block.type === "tool_result" && !showToolOutput) return HIDDEN_TOOL_RESULT;
  const mathKey = mathImages && block.type === "text" ? mathImageCacheKey() : "";
  const own = blockRenderCache.get(block);
  const reusable = (entry: BlockCacheEntry, contentKey?: string): boolean => (contentKey === undefined ? sameSourceRefs(entry.sourceRefs, block) : entry.contentKey === contentKey)
    && entry.width === contentWidth
    && entry.showToolOutput === showToolOutput
    && entry.toolCallErrored === toolCallErrored
    && entry.themeName === theme.name
    && entry.toolRegistryRef === toolRegistry
    && entry.externalToolStylesRef === externalToolStyles
    && entry.mathKey === mathKey
    && (!entry.result.mathPending || entry.mathGeneration === mathImageGeneration());
  // Fast path: this exact block object with unchanged field references. Every
  // history frame passes here for every loaded block, so it must not
  // serialize or copy content.
  if (own && reusable(own)) return own.result;

  const sourceRefs = blockSourceRefs(block);
  const contentKey = blockContentKey(block);
  const rehydratedKey = `${block.type}:${contentKey}`;
  const cached = own ?? rehydratedBlockRenderCache.get(rehydratedKey);
  if (cached && reusable(cached, contentKey)) {
    blockRenderCache.set(block, { ...cached, sourceRefs });
    return cached.result;
  }

  const mathGeneration = mathImageGeneration();
  const math = mathKey && mathKey !== "text" ? createDisplayMathImageRenderer() : undefined;
  const result = renderBlock(block, contentWidth, toolRegistry, externalToolStyles, showToolOutput, toolCallErrored, math);
  const entry: BlockCacheEntry = {
    contentKey,
    sourceRefs,
    width: contentWidth,
    showToolOutput,
    toolCallErrored,
    themeName: theme.name,
    toolRegistryRef: toolRegistry,
    externalToolStylesRef: externalToolStyles,
    mathKey,
    mathGeneration,
    result,
  };
  blockRenderCache.set(block, entry);
  // A block whose content changed in place is streaming; its intermediate
  // prefixes would only evict reusable entries from the shared LRU.
  const streaming = own !== undefined && own.contentKey !== contentKey;
  if (!streaming) {
    rehydratedBlockRenderCache.set(rehydratedKey, { ...entry, sourceRefs: NO_SOURCE_REFS }, contentKey.length * 2 + wrapResultBytes(result));
  }
  return result;
}

function renderBlock(
  block: Block,
  contentWidth: number,
  toolRegistry: ToolDisplayInfo[],
  externalToolStyles: ExternalToolStyle[],
  showToolOutput: boolean,
  toolCallErrored: boolean,
  math?: DisplayMathImageRenderer,
): WrapResult {
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const copy: WrapResult["copy"] = [];
  const links: NonNullable<WrapResult["links"]> = [];
  const images: NonNullable<WrapResult["images"]> = [];

  switch (block.type) {
    case "thinking": {
      // Claude ends each thinking block with "\n\n"; edge newlines would render
      // as blank rows before the next block.
      const text = sanitizeUntrustedText(block.text).replace(/^\n+|\n+$/g, "");
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
        const md = markdownWordWrap(text, contentWidth, theme.reset, math ? { displayMath: math.render } : {});
        const indented = new Map<WrapImage, WrapImage>();
        for (let i = 0; i < md.lines.length; i++) {
          const imageRow = md.images?.[i];
          if (imageRow) {
            let image = indented.get(imageRow.image);
            if (!image) indented.set(imageRow.image, image = { ...imageRow.image, col: imageRow.image.col + 2 });
            images[lines.length] = { image, row: imageRow.row };
          }
          links[lines.length] = (md.links?.[i] ?? []).map(span => ({ ...span, start: span.start + 2, end: span.end + 2 }));
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
      const summary = sanitizeUntrustedText(toolCallSummary(block));
      const localStyles = callLocalBashStyles(block);
      const localToolRegistry = block.presentation?.toolStyle
        ? [block.presentation.toolStyle, ...toolRegistry.filter((tool) => tool.name !== block.presentation!.toolStyle!.name)]
        : toolRegistry;
      const logical = renderToolCallLogicalLines(
        block.toolName,
        summary,
        localToolRegistry,
        localStyles.length > 0 ? [...localStyles, ...externalToolStyles] : externalToolStyles,
        block.input,
      );

      const firstRow = lines.length;
      for (let k = 0; k < logical.length; k++) {
        const entry = logical[k];
        if (entry.payload) {
          let end = k + 1;
          while (end < logical.length && logical[end].payload?.block === entry.payload.block) end++;
          renderToolCallPayload(logical.slice(k, end), contentWidth, showToolOutput, lines, cont, join, copy);
          k = end - 1;
          continue;
        }
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
        if (entry.meta) {
          // After the entry's first source line: a multi-line command is one entry.
          let j = 1;
          while (j < w.lines.length && w.cont[j]) j++;
          const row = lines.length - w.lines.length + j - 1;
          if (termWidth(w.lines[j - 1] ?? "") + 4 + termWidth(entry.meta) <= contentWidth) {
            lines[row] += `  ${theme.dim}${entry.meta}${theme.reset}`;
          } else {
            lines.splice(row + 1, 0, `  ${theme.dim}${entry.meta}${theme.reset}`);
            cont.splice(row + 1, 0, false);
            join.splice(row + 1, 0, "");
            copy.splice(row + 1, 0, null);
          }
        }
      }
      collapseLongToolCallDetail(block.toolName, showToolOutput, firstRow, lines, cont, join, copy);
      if (toolCallErrored && lines.length > 0) {
        lines[lines.length - 1] += ` ${theme.error}✗${theme.reset}`;
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

  return {
    lines, cont, join, copy, links,
    ...(images.length > 0 ? { images } : {}),
    ...(math?.pending ? { mathPending: true } : {}),
  };
}

const USER_BUBBLE_PADDING = 1;
const USER_BUBBLE_MARGIN = 2;
const adaptiveUserBubbleWidthCache = new WeakMap<UserMessageFlowDocument, Map<number, number>>();

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

export interface UserMessageFlowDocument {
  text: string;
  hardLines: string[];
}

export interface AdaptiveUserMessageRow {
  line: string;
  /** Width-independent position in the sanitized user-message text. */
  sourceStart: UserMessageFlowCursor;
  /** Position at which the following row should resume. */
  nextCursor: UserMessageFlowCursor;
}

function createUserMessageFlowDocument(text: string): UserMessageFlowDocument {
  const sanitized = sanitizeUntrustedText(text);
  return { text: sanitized, hardLines: sanitized.split("\n") };
}

/**
 * Bubble width for the complete message at one viewport width.
 *
 * Adaptive viewport rendering may receive only the visible source range of a
 * message. Deriving its bubble width from those rows makes the background
 * shrink as wider, off-screen rows are scrolled away, so always measure a
 * constant-width wrap of the complete source document instead.
 */
function fullUserMessageBubbleWidth(document: UserMessageFlowDocument, cols: number): number {
  let widthsByCols = adaptiveUserBubbleWidthCache.get(document);
  if (!widthsByCols) {
    widthsByCols = new Map();
    adaptiveUserBubbleWidthCache.set(document, widthsByCols);
  }
  const cached = widthsByCols.get(cols);
  if (cached !== undefined) return cached;

  const maxBubbleWidth = Math.max(1, cols - USER_BUBBLE_MARGIN - 1);
  const innerWidth = Math.max(1, maxBubbleWidth - USER_BUBBLE_PADDING * 2);
  const wrapped = wordWrap(document.text, innerWidth).lines;
  const longestLine = wrapped.reduce((max, line) => Math.max(max, termWidth(line)), 0);
  const bubbleWidth = Math.min(
    maxBubbleWidth,
    longestLine + USER_BUBBLE_PADDING * 2,
  );
  widthsByCols.set(cols, bubbleWidth);
  return bubbleWidth;
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
  return userMessageTextRowOffsetsFromDocument(createUserMessageFlowDocument(text), cols, images);
}

function userMessageTextRowOffsetsFromDocument(
  document: UserMessageFlowDocument,
  cols: number,
  images?: ImageAttachment[],
): { starts: UserMessageFlowCursor[]; end: UserMessageFlowCursor } | null {
  if (!document.text || images?.length) return null;

  const starts: UserMessageFlowCursor[] = [];
  const innerWidth = Math.max(1, cols - USER_BUBBLE_MARGIN - 1 - USER_BUBBLE_PADDING * 2);
  const hardLines = document.hardLines;
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
  text: string | UserMessageFlowDocument,
  sourceStart: UserMessageFlowCursor,
  sourceEnd: UserMessageFlowCursor,
  colsForRow: (rowIndex: number) => number,
  background = theme.userBg,
): AdaptiveUserMessageRow[] {
  const document = typeof text === "string" ? createUserMessageFlowDocument(text) : text;
  const hardLines = document.hardLines;
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
    const visibleContentWidth = Math.max(
      ...rawRows.slice(runStart, runEnd).map(row => termWidth(row.text)),
    );
    const bubbleWidth = Math.min(
      maxBubbleWidth,
      Math.max(
        fullUserMessageBubbleWidth(document, cols),
        visibleContentWidth + USER_BUBBLE_PADDING * 2,
      ),
    );
    const inner = Math.max(0, bubbleWidth - USER_BUBBLE_PADDING * 2);
    const screenOffset = " ".repeat(Math.max(0, cols - bubbleWidth - USER_BUBBLE_MARGIN));
    const padRight = " ".repeat(USER_BUBBLE_PADDING);

    for (let index = runStart; index < runEnd; index++) {
      const row = rawRows[index];
      const padLeft = " ".repeat(Math.max(0, inner - termWidth(row.text)) + USER_BUBBLE_PADDING);
      rendered.push({
        line: `${screenOffset}${background}${padLeft}${row.text}${padRight}${theme.reset}`,
        sourceStart: row.sourceStart,
        nextCursor: row.nextCursor,
      });
    }
    runStart = runEnd;
  }
  return rendered;
}

export function renderUserMessage(
  text: string,
  cols: number,
  images?: ImageAttachment[],
  background = theme.userBg,
): WrapResult {
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
    const styledText = style ? `${style}${lineText}${theme.reset}${background}` : lineText;
    lines.push(`${screenOffset}${background}${padLeft}${styledText}${padRight}${theme.reset}`);
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

export function renderUserMessageCached(
  owner: object,
  text: string,
  cols: number,
  images?: ImageAttachment[],
  background = theme.userBg,
): WrapResult {
  const imagesKey = imageAttachmentsKey(images);
  const cached = userMessageRenderCache.get(owner);
  if (cached && cached.text === text && cached.cols === cols && cached.imagesKey === imagesKey
      && cached.themeName === theme.name && cached.background === background) {
    return cached.result;
  }

  const result = renderUserMessage(text, cols, images, background);
  userMessageRenderCache.set(owner, { text, cols, imagesKey, themeName: theme.name, background, result });
  return result;
}

/** Canonical source document/cursors shared by history and viewport reflow. */
export function userMessageFlowMetadataCached(
  owner: object,
  text: string,
  cols: number,
  images?: ImageAttachment[],
  background = theme.userBg,
): ({ document: UserMessageFlowDocument } & {
  starts: UserMessageFlowCursor[];
  end: UserMessageFlowCursor;
}) | null {
  const imagesKey = imageAttachmentsKey(images);
  let cached = userMessageRenderCache.get(owner);
  if (!cached
    || cached.text !== text
    || cached.cols !== cols
    || cached.imagesKey !== imagesKey
    || cached.themeName !== theme.name
    || cached.background !== background) {
    renderUserMessageCached(owner, text, cols, images, background);
    cached = userMessageRenderCache.get(owner)!;
  }
  cached.flowDocument ??= createUserMessageFlowDocument(text);
  if (cached.flow === undefined) {
    cached.flow = userMessageTextRowOffsetsFromDocument(cached.flowDocument, cols, images);
  }
  return cached.flow ? { document: cached.flowDocument, ...cached.flow } : null;
}

export function renderSystemMessage(text: string, availableWidth: number, color?: string): WrapResult {
  const sysWidth = availableWidth - 2; // 2-char indent
  const width = sysWidth > 0 ? sysWidth : 1;
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  // Notices carry daemon, provider and external-notification text. Styling is
  // kept for locally built notices; any other escape reaching the terminal
  // could write the clipboard (OSC 52), retitle the window or redraw the UI.
  for (const rawLine of sanitizeUntrustedTextKeepingSgr(text).split("\n")) {
    if (rawLine.includes("\x1b[")) {
      // Inline ANSI is used sparingly (for example /tokens heatmaps). Wrap by
      // visible width without splitting escape sequences.
      const ansiWrap = wrapAnsiLine(rawLine, width);
      lines.push(...ansiWrap.lines);
      cont.push(...ansiWrap.lines.map((_, index) => index > 0));
      join.push(...ansiWrap.joins);
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
