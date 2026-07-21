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
import { buildDisplayRows, renderConversationActionMenu, renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { isGlobalIdleQueuedMessage } from "./queue";
import { getSidebarSearchBarViewport } from "./sidebarsearch";
import { buildMessageLines, type BuildMessageLinesResult } from "./conversation";
import { wrappedLineOffsets } from "./promptline";
import { computeBottomLayout, PROMPT_PREFIX_WIDTH } from "./chatlayout";
import { show_cursor, hide_cursor, cursor_block, cursor_underline, cursor_bar, applyLineBg } from "./terminal";
import { theme } from "./theme";
import { clampCursor, stripAnsi, contentBounds, logicalLineRange } from "./historycursor";
import { renderLineWithCursor, renderLineWithSearch, renderLineWithSelection } from "./cursorrender";
import { getPromptHighlightRanges, highlightPromptInput } from "./prompthighlight";
import { formatSize, imageLabel } from "./clipboard";
import { renderQueuePromptOverlay } from "./overlays";
import { renderEditMessageOverlay } from "./overlays";
import { findSearchMatches, getActiveSearchQuery, getSearchBarViewport } from "./search";
import { padRightToWidth, termWidth } from "./textwidth";
import { getVoicePromptRanges } from "./voice";
import { layoutTaskPanel, renderTaskPanel } from "./activitypanel";
import { trimAnsiLeadingSpaces, wrapAnsiLine } from "./ansiwrap";
import { getBtwPanelPreferredHeight, MAX_BTW_PANEL_HEIGHT, renderBtwPanel } from "./btwpanel";
import { wordWrap } from "./textwrap";
import {
  compareUserMessageFlowCursors,
  renderAdaptiveUserMessageRows,
  type UserMessageFlowCursor,
} from "./blockrenderer";
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
  voiceMessageRef: RenderState["voiceMessage"];
  voiceMessageFrameIndex: number | null;
  voiceMessagePhase: string | null;
  historyLoadingFrame: number | null;
  showToolOutput: boolean;
  toolRegistryRef: RenderState["toolRegistry"];
  externalToolStylesRef: RenderState["externalToolStyles"];
  themeName: string;
  result: BuildMessageLinesResult;
}

const historyRenderCache = new WeakMap<RenderState, HistoryRenderCacheEntry>();
const DEFERRED_HISTORY_MIN_MESSAGES = 24;
const DEFERRED_HISTORY_INITIAL_MESSAGE_BATCH = 8;
const DEFERRED_HISTORY_ADVANCE_MESSAGE_BATCH = 8;
const DEFERRED_HISTORY_GRACE_LINES = 200;
const AUTOCOMPLETE_MAX_VISIBLE_ROWS = 10;
const HISTORY_LOADING_FRAME_INTERVAL_MS = 80;

function historyLoadingFrame(state: RenderState): number | null {
  if (!state.historyLoadingOlder) return null;
  return Math.max(0, Math.floor((Date.now() - (state.historyLoadingStartedAt ?? Date.now())) / HISTORY_LOADING_FRAME_INTERVAL_MS));
}

function canReuseHistoryRender(
  cached: HistoryRenderCacheEntry,
  state: RenderState,
  width: number,
): boolean {
  return cached.width === width
    && cached.convId === state.convId
    && cached.messagesRef === state.messages
    && cached.messageCount === state.messages.length
    && cached.queuedMessagesRef === state.queuedMessages
    && cached.queuedMessageCount === state.queuedMessages.length
    && cached.streamingTailRef === state.streamingTailMessages
    && cached.streamingTailCount === state.streamingTailMessages.length
    && cached.voiceMessageRef === state.voiceMessage
    && cached.voiceMessageFrameIndex === (state.voiceMessage?.frameIndex ?? null)
    && cached.voiceMessagePhase === (state.voiceMessage?.phase ?? null)
    && cached.historyLoadingFrame === historyLoadingFrame(state)
    && cached.showToolOutput === state.showToolOutput
    && cached.toolRegistryRef === state.toolRegistry
    && cached.externalToolStylesRef === state.externalToolStyles
    && cached.themeName === theme.name;
}

function shouldForceFullHistoryRender(state: RenderState): boolean {
  return state.pendingAI !== null
    || state.scrollOffset > 0
    || state.showToolOutput
    || state.toolOutputsLoaded
    || state.search?.barOpen === true
    || (state.panelFocus === "chat" && state.chatFocus === "history");
}

function canUseDeferredHistoryRender(state: RenderState, width: number): boolean {
  return !shouldForceFullHistoryRender(state)
    && state.convId !== null
    && state.messages.length >= DEFERRED_HISTORY_MIN_MESSAGES
    && width > 0;
}

function buildDeferredHistorySuffix(
  state: RenderState,
  width: number,
  targetLines: number,
): BuildMessageLinesResult {
  let startMessageIndex = Math.max(0, state.messages.length - DEFERRED_HISTORY_INITIAL_MESSAGE_BATCH);
  let result = buildMessageLines(state, width, { startMessageIndex, partial: startMessageIndex > 0 });

  while (startMessageIndex > 0 && result.lines.length < targetLines) {
    startMessageIndex = Math.max(0, startMessageIndex - DEFERRED_HISTORY_INITIAL_MESSAGE_BATCH);
    result = buildMessageLines(state, width, { startMessageIndex, partial: startMessageIndex > 0 });
  }

  state.deferredHistoryRender = {
    convId: state.convId,
    width,
    startMessageIndex,
    generation: (state.deferredHistoryRender?.generation ?? 0) + 1,
    complete: startMessageIndex === 0,
  };

  return result;
}

function getHistoryRender(
  state: RenderState,
  width: number,
  targetLines: number,
): BuildMessageLinesResult {
  if (state.pendingAI) {
    state.deferredHistoryRender = null;
    historyRenderCache.delete(state);
    return buildMessageLines(state, width);
  }

  const cached = historyRenderCache.get(state);
  if (cached && canReuseHistoryRender(cached, state, width)) {
    return cached.result;
  }

  const deferred = state.deferredHistoryRender;
  let result: BuildMessageLinesResult;
  if (deferred
    && deferred.convId === state.convId
    && deferred.width === width
    && deferred.complete) {
    result = buildMessageLines(state, width);
  } else if (deferred
    && deferred.convId === state.convId
    && deferred.width === width
    && !deferred.complete
    && canUseDeferredHistoryRender(state, width)) {
    result = buildMessageLines(state, width, { startMessageIndex: deferred.startMessageIndex, partial: deferred.startMessageIndex > 0 });
  } else if (canUseDeferredHistoryRender(state, width)) {
    result = buildDeferredHistorySuffix(state, width, targetLines);
  } else {
    state.deferredHistoryRender = null;
    result = buildMessageLines(state, width);
  }

  historyRenderCache.set(state, {
    width,
    convId: state.convId,
    messagesRef: state.messages,
    messageCount: state.messages.length,
    queuedMessagesRef: state.queuedMessages,
    queuedMessageCount: state.queuedMessages.length,
    streamingTailRef: state.streamingTailMessages,
    streamingTailCount: state.streamingTailMessages.length,
    voiceMessageRef: state.voiceMessage,
    voiceMessageFrameIndex: state.voiceMessage?.frameIndex ?? null,
    voiceMessagePhase: state.voiceMessage?.phase ?? null,
    historyLoadingFrame: historyLoadingFrame(state),
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

export function hasDeferredHistoryRenderWork(state: RenderState): boolean {
  const deferred = state.deferredHistoryRender;
  return !!deferred && !deferred.complete && deferred.convId === state.convId;
}

export function advanceDeferredHistoryRender(state: RenderState): boolean {
  const deferred = state.deferredHistoryRender;
  if (!deferred || deferred.complete || deferred.convId !== state.convId) return false;
  const nextStart = Math.max(0, deferred.startMessageIndex - DEFERRED_HISTORY_ADVANCE_MESSAGE_BATCH);
  if (nextStart === deferred.startMessageIndex) return false;
  deferred.startMessageIndex = nextStart;
  deferred.complete = nextStart === 0;
  historyRenderCache.delete(state);
  return true;
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

function colorPlainPromptDecorations(
  line: string,
  wrappedLineIdx: number,
  ranges: Array<{ start: number; end: number; color: string }>,
  offsets: number[],
): string {
  if (wrappedLineIdx >= offsets.length) return line;
  const lineStart = offsets[wrappedLineIdx];
  const lineEndExclusive = lineStart + line.length;
  const relRanges = ranges
    .map(range => ({
      start: Math.max(range.start, lineStart) - lineStart,
      end: Math.min(range.end, lineEndExclusive) - lineStart,
      color: range.color,
    }))
    .filter(range => range.start < range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (relRanges.length === 0) return line;

  let out = "";
  let cursor = 0;
  for (const range of relRanges) {
    const start = Math.max(cursor, range.start);
    if (start >= range.end) continue;
    out += line.slice(cursor, start);
    out += range.color + line.slice(start, range.end) + theme.reset;
    cursor = range.end;
  }
  return out + line.slice(cursor);
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

const SYSTEM_INSTRUCTIONS_SEGMENTS = new Set([
  "system_instructions_top",
  "system_instructions_content",
  "system_instructions_bottom",
]);

interface ViewportHistoryRow {
  line: string;
  lineIndex: number;
  /** Plain-text column in the canonical history line where this row starts. */
  startCol: number;
  /** Display-only indentation repeated in front of a reflow continuation. */
  displayPrefixWidth: number;
  /** ANSI-preserving remainder of the canonical line at startCol. */
  sourceRemainder: string;
  /** Width-independent continuation point for a reflowed user bubble. */
  userFlow?: { owner: object; sourceCursor: UserMessageFlowCursor };
}

type ViewportSourceState = Pick<
  ViewportHistoryRow,
  "lineIndex" | "startCol" | "sourceRemainder" | "userFlow"
>;

interface FloatingHistoryViewportCacheEntry {
  lineAnchors: BuildMessageLinesResult["lineAnchors"];
  viewStart: number;
  instructionStartIndex: number;
  messageAreaHeight: number;
  panelTopOffset: number;
  panelHeight: number;
  narrowWidth: number;
  fullWidth: number;
  rows: ViewportHistoryRow[];
}

/**
 * Task countdown/elapsed labels can repaint without changing chat history or
 * panel geometry. Reusing the adaptive viewport prevents those timer ticks from
 * recomposing the same rows.
 */
const floatingHistoryViewportCache = new WeakMap<string[], FloatingHistoryViewportCacheEntry>();

function wrapRenderedHistoryLine(line: string, width: number): { lines: string[]; joins: string[] } {
  if (line.includes("\x1b[")) {
    return wrapAnsiLine(line, width);
  }
  const wrapped = wordWrap(line, width);
  return { lines: wrapped.lines, joins: wrapped.join };
}

function continuationIndent(line: string, segment: BuildMessageLinesResult["lineAnchors"][number]["segment"] | undefined): string {
  if (segment === "user_content" || segment === "queued_content" || segment === "queued_label") return "";
  return stripAnsi(line).match(/^ +(?=\S)/)?.[0] ?? "";
}

/** Number of viewport rows occupied by a system-instructions box at the top. */
function visibleSystemInstructionsHeight(
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  viewStart: number,
  messageAreaHeight: number,
): number {
  let height = 0;
  while (height < messageAreaHeight) {
    const segment = lineAnchors[viewStart + height]?.segment;
    if (!segment || !SYSTEM_INSTRUCTIONS_SEGMENTS.has(segment)) break;
    height++;
  }
  return height;
}

function composeSemanticUserRows(
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  start: ViewportSourceState,
  lineIndex: number,
  endLineIndex: number,
  colsForRow: (rowOffset: number) => number,
): { rows: ViewportHistoryRow[]; requestedEnd: number } | null {
  const anchor = lineAnchors[lineIndex];
  const isUserFlow = anchor?.segment === "user_content" || anchor?.segment === "queued_content";
  const owner = anchor?.owner as { text?: unknown } | undefined;
  if (!isUserFlow
    || !owner
    || typeof owner.text !== "string"
    || !anchor.userFlowDocument
    || !anchor.userFlowStart
    || !anchor.userFlowEnd) return null;

  let requestedEnd = lineIndex + 1;
  while (requestedEnd < endLineIndex) {
    const next = lineAnchors[requestedEnd];
    if (next?.owner !== anchor.owner
      || next.segment !== anchor.segment
      || !next.userFlowStart
      || !next.userFlowEnd) break;
    requestedEnd++;
  }

  const sourceStart = start.userFlow?.owner === anchor.owner && lineIndex === start.lineIndex
    ? start.userFlow.sourceCursor
    : anchor.userFlowStart;
  const sourceEnd = lineAnchors[requestedEnd - 1].userFlowEnd!;
  const adaptive = renderAdaptiveUserMessageRows(anchor.userFlowDocument, sourceStart, sourceEnd, colsForRow);
  const rows: ViewportHistoryRow[] = [];
  let canonicalLineIndex = lineIndex;

  for (const rendered of adaptive) {
    while (canonicalLineIndex + 1 < requestedEnd) {
      const nextStart = lineAnchors[canonicalLineIndex + 1].userFlowStart;
      if (!nextStart || compareUserMessageFlowCursors(nextStart, rendered.sourceStart) > 0) break;
      canonicalLineIndex++;
    }
    const renderedLine = anchor.segment === "queued_content"
      ? `${theme.muted}${rendered.line}${theme.reset}`
      : rendered.line;
    rows.push({
      line: renderedLine,
      lineIndex: canonicalLineIndex,
      startCol: 0,
      displayPrefixWidth: 0,
      sourceRemainder: renderedLine,
      userFlow: { owner: anchor.owner, sourceCursor: rendered.sourceStart },
    });
  }

  return { rows, requestedEnd };
}

function composeViewportFrom(
  allLines: string[],
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  start: ViewportSourceState,
  endLineIndex: number,
  panelTopOffset: number,
  panelHeight: number,
  narrowWidth: number,
  fullWidth: number,
): ViewportHistoryRow[] {
  const rows: ViewportHistoryRow[] = [];
  const panelEndOffset = panelTopOffset + panelHeight;

  for (let lineIndex = start.lineIndex; lineIndex < endLineIndex; lineIndex++) {
    const userRows = composeSemanticUserRows(
      lineAnchors,
      start,
      lineIndex,
      endLineIndex,
      (rowOffset) => {
        const screenOffset = rows.length + rowOffset;
        return screenOffset >= panelTopOffset && screenOffset < panelEndOffset
          ? narrowWidth
          : fullWidth;
      },
    );
    if (userRows) {
      rows.push(...userRows.rows);
      lineIndex = userRows.requestedEnd - 1;
      continue;
    }

    let remainder = lineIndex === start.lineIndex ? start.sourceRemainder : allLines[lineIndex];
    let startCol = lineIndex === start.lineIndex ? start.startCol : 0;
    let isReflowContinuation = startCol > 0;
    const indent = continuationIndent(allLines[lineIndex], lineAnchors[lineIndex]?.segment);

    for (;;) {
      const screenOffset = rows.length;
      const overlapsPanel = screenOffset >= panelTopOffset && screenOffset < panelEndOffset;
      const width = overlapsPanel ? narrowWidth : fullWidth;
      const segment = lineAnchors[lineIndex]?.segment;
      if (overlapsPanel
        && startCol === 0
        && (segment === "user_content" || segment === "queued_content")) {
        const shifted = trimAnsiLeadingSpaces(remainder, Math.max(0, fullWidth - narrowWidth));
        remainder = shifted.line;
        startCol = shifted.removed;
      }
      const displayPrefix = isReflowContinuation ? indent : "";
      const wrapped = wrapRenderedHistoryLine(displayPrefix + remainder, Math.max(1, width));
      const line = wrapped.lines[0] ?? "";
      rows.push({
        line,
        lineIndex,
        startCol,
        displayPrefixWidth: displayPrefix.length,
        sourceRemainder: remainder,
      });

      if (wrapped.lines.length <= 1) break;
      startCol += Math.max(0, stripAnsi(line).length - displayPrefix.length)
        + (wrapped.joins[1]?.length ?? 0);
      remainder = wrapped.lines.slice(1)
        .map((chunk, index) => `${index === 0 ? "" : (wrapped.joins[index + 1] ?? "")}${chunk}`)
        .join("");
      isReflowContinuation = true;
    }
  }

  return rows;
}

function canonicalSourceState(allLines: string[], lineIndex: number): ViewportSourceState {
  return {
    lineIndex,
    startCol: 0,
    sourceRemainder: allLines[lineIndex] ?? "",
  };
}

function rowSourceState(row: ViewportHistoryRow): ViewportSourceState {
  return {
    lineIndex: row.lineIndex,
    startCol: row.startCol,
    sourceRemainder: row.sourceRemainder,
    userFlow: row.userFlow,
  };
}

function wrappedRemainders(lines: string[], joins: string[]): string[] {
  const remainders = new Array<string>(lines.length);
  let remainder = "";
  for (let index = lines.length - 1; index >= 0; index--) {
    remainder = `${lines[index] ?? ""}${index + 1 < lines.length ? (joins[index + 1] ?? "") : ""}${remainder}`;
    remainders[index] = remainder;
  }
  return remainders;
}

/** Render one bounded source range once at one width. */
function composeFixedWidthRows(
  allLines: string[],
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  start: ViewportSourceState,
  endLineIndex: number,
  width: number,
  canonicalWidth: number,
): ViewportHistoryRow[] {
  const rows: ViewportHistoryRow[] = [];
  const safeWidth = Math.max(1, width);

  for (let lineIndex = start.lineIndex; lineIndex < endLineIndex; lineIndex++) {
    const anchor = lineAnchors[lineIndex];
    const userRows = composeSemanticUserRows(
      lineAnchors,
      start,
      lineIndex,
      endLineIndex,
      () => safeWidth,
    );
    if (userRows) {
      rows.push(...userRows.rows);
      lineIndex = userRows.requestedEnd - 1;
      continue;
    }

    const canonicalLine = allLines[lineIndex] ?? "";
    const indent = continuationIndent(canonicalLine, anchor?.segment);
    let sourceLine = lineIndex === start.lineIndex ? start.sourceRemainder : canonicalLine;
    let sourceCol = lineIndex === start.lineIndex ? start.startCol : 0;
    const startsAsContinuation = sourceCol > 0;
    const segment = anchor?.segment;
    if (!startsAsContinuation
      && (segment === "user_content" || segment === "queued_content")) {
      const shifted = trimAnsiLeadingSpaces(sourceLine, Math.max(0, canonicalWidth - safeWidth));
      sourceLine = shifted.line;
      sourceCol = shifted.removed;
    }

    const firstPrefix = startsAsContinuation ? indent : "";
    const firstWrap = wrapRenderedHistoryLine(
      sourceLine,
      Math.max(1, safeWidth - firstPrefix.length),
    );
    const firstLine = firstWrap.lines[0] ?? "";
    rows.push({
      line: firstPrefix + firstLine,
      lineIndex,
      startCol: sourceCol,
      displayPrefixWidth: firstPrefix.length,
      sourceRemainder: sourceLine,
    });
    if (firstWrap.lines.length <= 1) continue;

    sourceCol += stripAnsi(firstLine).length + (firstWrap.joins[1]?.length ?? 0);
    const remainder = firstWrap.lines.slice(1)
      .map((chunk, index) => `${index === 0 ? "" : (firstWrap.joins[index + 1] ?? "")}${chunk}`)
      .join("");
    // A continuation-start already reserved indentation in the first wrap, so
    // every returned chunk has the correct width and can be emitted directly.
    if (startsAsContinuation || indent.length === 0) {
      const remainders = wrappedRemainders(firstWrap.lines, firstWrap.joins);
      for (let index = 1; index < firstWrap.lines.length; index++) {
        const chunk = firstWrap.lines[index] ?? "";
        rows.push({
          line: firstPrefix + chunk,
          lineIndex,
          startCol: sourceCol,
          displayPrefixWidth: firstPrefix.length,
          sourceRemainder: remainders[index] ?? chunk,
        });
        sourceCol += stripAnsi(chunk).length + (firstWrap.joins[index + 1]?.length ?? 0);
      }
      continue;
    }

    const continuationWrap = wrapRenderedHistoryLine(
      remainder,
      Math.max(1, safeWidth - indent.length),
    );
    const continuationRemainders = wrappedRemainders(continuationWrap.lines, continuationWrap.joins);
    for (let index = 0; index < continuationWrap.lines.length; index++) {
      const chunk = continuationWrap.lines[index] ?? "";
      rows.push({
        line: indent + chunk,
        lineIndex,
        startCol: sourceCol,
        displayPrefixWidth: indent.length,
        sourceRemainder: continuationRemainders[index] ?? chunk,
      });
      sourceCol += stripAnsi(chunk).length + (continuationWrap.joins[index + 1]?.length ?? 0);
    }
  }

  return rows;
}

function canonicalViewportRows(
  allLines: string[],
  startLineIndex: number,
  endLineIndex: number,
): ViewportHistoryRow[] {
  const rows: ViewportHistoryRow[] = [];
  for (let lineIndex = startLineIndex; lineIndex < endLineIndex; lineIndex++) {
    const line = allLines[lineIndex];
    if (line === undefined) continue;
    rows.push({
      line,
      lineIndex,
      startCol: 0,
      displayPrefixWidth: 0,
      sourceRemainder: line,
    });
  }
  return rows;
}

/**
 * Compose the task-panel float as two deterministic history regions.
 *
 * The newest rows below the card are fixed first at full width. The immediately
 * preceding source rows are then rendered once at the narrow width and clipped
 * from the top to the card's height. Unlike the old fixed-point loop, wrapping
 * beside the card can never move the full-width tail or trigger another pass.
 */
function composeFloatingHistoryViewport(
  allLines: string[],
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  viewStart: number,
  instructionStartIndex: number,
  messageAreaHeight: number,
  panelTopOffset: number,
  panelHeight: number,
  narrowWidth: number,
  fullWidth: number,
): ViewportHistoryRow[] {
  const cached = floatingHistoryViewportCache.get(allLines);
  if (cached
    && cached.lineAnchors === lineAnchors
    && cached.viewStart === viewStart
    && cached.instructionStartIndex === instructionStartIndex
    && cached.messageAreaHeight === messageAreaHeight
    && cached.panelTopOffset === panelTopOffset
    && cached.panelHeight === panelHeight
    && cached.narrowWidth === narrowWidth
    && cached.fullWidth === fullWidth) {
    return cached.rows;
  }

  const endLineIndex = Math.min(allLines.length, viewStart + messageAreaHeight);
  if (viewStart >= endLineIndex) return [];

  if (panelHeight <= 0 || narrowWidth === fullWidth) {
    const rows = canonicalViewportRows(allLines, viewStart, endLineIndex);
    floatingHistoryViewportCache.set(allLines, {
      lineAnchors,
      viewStart,
      instructionStartIndex,
      messageAreaHeight,
      panelTopOffset,
      panelHeight,
      narrowWidth,
      fullWidth,
      rows,
    });
    return rows;
  }

  // Genuinely short histories should remain top-aligned. A full canonical
  // viewport can go straight to the bounded bottom-anchored composition.
  if (instructionStartIndex === viewStart && endLineIndex - viewStart < messageAreaHeight) {
    const directRows = composeViewportFrom(
      allLines,
      lineAnchors,
      canonicalSourceState(allLines, viewStart),
      endLineIndex,
      panelTopOffset,
      panelHeight,
      narrowWidth,
      fullWidth,
    );
    if (directRows.length <= messageAreaHeight) {
      floatingHistoryViewportCache.set(allLines, {
        lineAnchors,
        viewStart,
        instructionStartIndex,
        messageAreaHeight,
        panelTopOffset,
        panelHeight,
        narrowWidth,
        fullWidth,
        rows: directRows,
      });
      return directRows;
    }
  }

  const instructionRows = Math.min(
    panelTopOffset,
    messageAreaHeight,
    endLineIndex - instructionStartIndex,
  );
  const instructionEndIndex = instructionStartIndex + instructionRows;
  const availableAfterInstructions = Math.max(0, messageAreaHeight - instructionRows);
  const narrowRowCount = Math.min(panelHeight, availableAfterInstructions);
  const fullRowCount = Math.max(0, availableAfterInstructions - narrowRowCount);

  // Preserve the newest canonical full-width rows. Narrow wrapping above this
  // boundary is presentation-only and cannot displace the tail near the prompt.
  const fullStartIndex = Math.max(instructionEndIndex, endLineIndex - fullRowCount);
  const narrowSourceStartIndex = Math.max(
    instructionEndIndex,
    fullStartIndex - narrowRowCount,
  );

  const instructions = canonicalViewportRows(allLines, instructionStartIndex, instructionEndIndex);
  const narrowProbe = narrowSourceStartIndex < fullStartIndex
    ? composeFixedWidthRows(
        allLines,
        lineAnchors,
        canonicalSourceState(allLines, narrowSourceStartIndex),
        fullStartIndex,
        narrowWidth,
        fullWidth,
      )
    : [];
  const narrowStart = narrowProbe[narrowProbe.length - narrowRowCount];
  const narrowRows = narrowStart
    ? composeFixedWidthRows(
        allLines,
        lineAnchors,
        rowSourceState(narrowStart),
        fullStartIndex,
        narrowWidth,
        fullWidth,
      ).slice(0, narrowRowCount)
    : narrowProbe;
  const fullRows = composeFixedWidthRows(
    allLines,
    lineAnchors,
    canonicalSourceState(allLines, fullStartIndex),
    endLineIndex,
    fullWidth,
    fullWidth,
  );
  const visibleRows = [...instructions, ...narrowRows, ...fullRows].slice(-messageAreaHeight);
  floatingHistoryViewportCache.set(allLines, {
    lineAnchors,
    viewStart,
    instructionStartIndex,
    messageAreaHeight,
    panelTopOffset,
    panelHeight,
    narrowWidth,
    fullWidth,
    rows: visibleRows,
  });
  return visibleRows;
}

/**
 * Render the scrollable message/history area (rows 3 to sepAbove-1).
 * Handles visual selection highlighting, normal-mode line highlight,
 * and history cursor rendering.
 */
function renderMessageArea(
  ctx: RenderCtx,
  allLines: string[],
  viewportRows: ViewportHistoryRow[],
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
    const viewportRow = viewportRows[i];
    if (viewportRow) {
      const { line, lineIndex: lineIdx, startCol, displayPrefixWidth } = viewportRow;
      const plain = stripAnsi(line);
      const canonicalPlain = stripAnsi(allLines[lineIdx]);
      const searchRanges = searchQuery ? findSearchMatches(plain, searchQuery) : [];
      let rendered = line;

      if (inVisual && lineIdx >= vStartRow && lineIdx <= vEndRow) {
        // This line is part of the visual selection — text-bound highlight
        const bounds = contentBounds(canonicalPlain);
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

        const localStart = Math.max(displayPrefixWidth, startCol - viewportRow.startCol + displayPrefixWidth);
        const localEnd = Math.min(plain.length - 1, endCol - viewportRow.startCol + displayPrefixWidth);
        if (localStart <= localEnd) rendered = renderLineWithSelection(rendered, localStart, localEnd);
      }

      if (searchRanges.length > 0) {
        rendered = renderLineWithSearch(rendered, searchRanges);
      }

      const sourceEnd = startCol + plain.length - displayPrefixWidth;
      // Blank canonical lines use a virtual cursor at the end of their padding.
      // Include that otherwise-exclusive endpoint so renderLineWithCursor can
      // append the visible cursor cell, while keeping reflow boundaries exclusive.
      const cursorAtBlankLineEnd = canonicalPlain.trim().length === 0
        && vCursor.col === sourceEnd;
      if (((inVisual && lineIdx === vCursor.row) || (historyFocused && !inVisual && lineIdx === vCursor.row))
        && vCursor.col >= startCol
        && (vCursor.col < sourceEnd || cursorAtBlankLineEnd)) {
        rendered = renderLineWithCursor(rendered, vCursor.col - startCol + displayPrefixWidth);
      }

      const finalLine = historyFocused && !inVisual && lineIdx >= hlFirst && lineIdx <= hlLast
        ? applyLineBg(rendered, theme.historyLineBg)
        : bgLine(rendered);
      appendRowWrite(ctx, row, chatCol, finalLine);
    }
  }
}

function autocompleteDisplayText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "");
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
  const maxVisible = Math.max(1, Math.min(AUTOCOMPLETE_MAX_VISIBLE_ROWS, sepAbove - 3));
  const total = matches.length;
  const winSize = Math.min(total, maxVisible);
  let winStart = 0;

  if (total > maxVisible && sel >= 0) {
    const ideal = sel - Math.floor(winSize / 2);
    winStart = Math.max(0, Math.min(ideal, total - winSize));
  }

  const visibleMatches = matches.slice(winStart, winStart + winSize);
  const visibleNames = visibleMatches.map(match => autocompleteDisplayText(match.name));
  const visibleDescs = visibleMatches.map(match => autocompleteDisplayText(match.desc));
  const maxPopupWidth = Math.max(1, chatW - 2);
  const markerWidth = maxPopupWidth >= 2 ? 2 : 0;
  const indicatorWidth = total > winSize && maxPopupWidth - markerWidth >= 2 ? 2 : 0;
  const maxName = visibleNames.reduce((m, name) => Math.max(m, termWidth(name)), 0);
  const maxDesc = visibleDescs.reduce((m, desc) => Math.max(m, termWidth(desc)), 0);
  const desiredNameWidth = Math.min(maxName + (maxDesc > 0 ? 1 : 0), maxPopupWidth);
  const desiredPopupWidth = Math.max(1, Math.min(maxPopupWidth, markerWidth + indicatorWidth + desiredNameWidth + maxDesc));
  const contentWidth = Math.max(0, desiredPopupWidth - markerWidth - indicatorWidth);
  const nameWidth = Math.min(desiredNameWidth, contentWidth);
  const descWidth = Math.max(0, contentWidth - nameWidth);

  const topRow = sepAbove - winSize;
  for (let vi = 0; vi < winSize; vi++) {
    const i = winStart + vi;
    const row = topRow + vi;
    const isSelected = sel === i;
    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const marker = markerWidth > 0 ? padRightToWidth(isSelected ? "▸ " : "  ", markerWidth) : "";
    const name = padRightToWidth(visibleNames[vi], nameWidth);
    const desc = padRightToWidth(visibleDescs[vi], descWidth);
    const upIndicator = vi === 0 && winStart > 0;
    const downIndicator = vi === winSize - 1 && winStart + winSize < total;
    const indicator = indicatorWidth > 0
      ? padRightToWidth(upIndicator ? " ▲" : downIndicator ? " ▼" : "", indicatorWidth)
      : "";
    appendRowWrite(
      ctx,
      row,
      chatCol,
      bg + theme.accent + marker + theme.text + name + theme.dim + desc + indicator + theme.reset,
    );
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

  if (state.voicePrompt?.phase === "recording") {
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
      new Set(state.queuedMessages.filter(isGlobalIdleQueuedMessage).map(message => message.convId)),
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
    messageAreaHeight: baseMessageAreaHeight,
  } = bottomLayout;
  const { lines: inputLines, isNewLine, cursorLine, cursorCol, scrollOffset: newPromptScroll } = input;
  state.promptScrollOffset = newPromptScroll;

  // Syntax-highlight valid commands/macros in the rendered prompt even while
  // voice placeholders are present. Voice ranges are just another rendered
  // decoration, so slash macros typed after a pending transcription still look
  // and behave like normal prompt text.
  const voicePrompts = [...state.voicePromptJobs, ...(state.voicePrompt ? [state.voicePrompt] : [])];
  const coloredInputLines = voicePrompts.length > 0
    ? (() => {
      const commandRanges = getPromptHighlightRanges(state, renderedPrompt.buffer)
        .map(range => ({ ...range, color: theme.command }));
      const voiceRanges = getVoicePromptRanges(state.inputBuffer, voicePrompts)
        .map(range => ({ ...range, color: theme.accent }));
      const offsets = wrappedLineOffsets(renderedPrompt.buffer, maxInputWidth);
      return inputLines.map((line, idx) => colorPlainPromptDecorations(
        line,
        newPromptScroll + idx,
        [...commandRanges, ...voiceRanges],
        offsets,
      ));
    })()
    : highlightPromptInput(state, inputLines, state.inputBuffer, maxInputWidth, newPromptScroll);

  const slHeight = status.height;
  const statusLines = status.lines;

  // BTW grows upward with the stream, then scrolls once it reaches its limit.
  // It consumes the bottom of the chat viewport rather than hiding history rows.
  let btwPanel = null;
  if (state.btw) {
    const availableRows = Math.max(1, baseMessageAreaHeight);
    const preferredHeight = getBtwPanelPreferredHeight(state.btw, chatW);
    const btwHeight = availableRows >= 3
      ? Math.min(preferredHeight, availableRows, MAX_BTW_PANEL_HEIGHT)
      : 1;
    const btwTop = bottomStartRow - btwHeight;
    btwPanel = renderBtwPanel(state.btw, chatW, btwHeight, btwTop, chatCol);
  }
  const messageAreaHeight = Math.max(0, baseMessageAreaHeight - (btwPanel?.height ?? 0));

  // Prompt separator
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";
  const promptColor = promptFocused ? theme.accent : theme.dim;

  // ── Message area (rows 3 to bottomStartRow-1) ──────────────────
  const messageAreaStart = 3;
  const taskLayout = layoutTaskPanel(state, chatW, messageAreaHeight);
  const historyWidth = taskLayout.historyWidth;
  const deferredTargetLines = messageAreaHeight + DEFERRED_HISTORY_GRACE_LINES;
  const { lines: allLines, messageBounds, wrapContinuation, wrapJoiners, copyLines, lineAnchors } = getHistoryRender(
    state,
    chatW,
    deferredTargetLines,
  );
  const totalLines = allLines.length;

  // Cache rendered lines and message bounds for history cursor navigation
  state.historyLines = allLines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyWrapJoiners = wrapJoiners;
  state.historyCopyLines = copyLines;
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
  state.layout.historyWidth = historyWidth;
  state.layout.chatCol = chatCol;
  state.layout.sepAbove = bottomStartRow;
  state.layout.firstInputRow = firstInputRow;
  state.layout.sepBelow = sepBelow;

  const viewStart = getViewStart(state);

  // Keep leading system instructions full-width, then float the task panel over
  // only the rows it actually occupies. Re-evaluate the offset if top-row
  // wrapping shifts the canonical history row at the viewport's top.
  let taskPanelTopOffset = taskLayout.panel
    ? visibleSystemInstructionsHeight(lineAnchors, viewStart, messageAreaHeight)
    : 0;
  let instructionStartIndex = viewStart;
  let taskPanel = taskLayout.panel && taskPanelTopOffset > 0
    ? renderTaskPanel(state, taskLayout.panel.width, messageAreaHeight - taskPanelTopOffset)
    : taskLayout.panel;
  let viewportRows: ViewportHistoryRow[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    // Keep one extra history row narrow below the card as visual breathing room.
    const panelFlowHeight = taskPanel ? Math.min(
      messageAreaHeight - taskPanelTopOffset,
      taskPanel.lines.length + 1,
    ) : 0;
    viewportRows = composeFloatingHistoryViewport(
      allLines,
      lineAnchors,
      viewStart,
      instructionStartIndex,
      messageAreaHeight,
      taskPanelTopOffset,
      panelFlowHeight,
      taskPanel ? historyWidth : chatW,
      chatW,
    );
    const topLineIndex = viewportRows[0]?.lineIndex ?? viewStart;
    const nextOffset = taskLayout.panel
      ? visibleSystemInstructionsHeight(lineAnchors, topLineIndex, messageAreaHeight)
      : 0;
    if (nextOffset === taskPanelTopOffset
      && (nextOffset === 0 || topLineIndex === instructionStartIndex)) break;
    instructionStartIndex = topLineIndex;
    taskPanelTopOffset = nextOffset;
    taskPanel = renderTaskPanel(
      state,
      taskLayout.panel!.width,
      messageAreaHeight - taskPanelTopOffset,
    );
  }
  state.layout.historyViewportRows = Array.from(
    { length: messageAreaHeight },
    (_, index) => viewportRows[index]
      ? {
        lineIndex: viewportRows[index].lineIndex,
        startCol: viewportRows[index].startCol,
        displayPrefixWidth: viewportRows[index].displayPrefixWidth,
      }
      : null,
  );

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
    ctx, allLines, viewportRows,
    messageAreaStart, messageAreaHeight,
    historyFocused, inVisual, state.vim.mode,
    vAnchor, vCursor, vStartRow, vEndRow,
    hlFirst, hlLast, searchQuery,
  );

  // ── Active task panel (top-right float) ────────────────────────
  state.layout.taskPanelRect = null;
  if (taskPanel) {
    const panelCol = chatCol + chatW - taskPanel.width;
    const panelTop = messageAreaStart + taskPanelTopOffset;
    state.layout.taskPanelRect = {
      top: panelTop,
      bottom: panelTop + taskPanel.lines.length - 1,
      left: panelCol,
      right: panelCol + taskPanel.width - 1,
    };
    for (let i = 0; i < taskPanel.lines.length; i++) {
      appendRowWrite(ctx, panelTop + i, panelCol, taskPanel.lines[i]);
    }
  }

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

  // ── Sidebar conversation action menu ──────────────────────────
  if (sidebarOpen && state.sidebar.conversationActionMenu) {
    const menu = state.sidebar.conversationActionMenu;
    const displayRow = buildDisplayRows(state.sidebar).findIndex(row => (
      row.type === "entry"
      && row.item?.type === "conversation"
      && row.item.id === menu.convId
    ));
    const anchorRow = displayRow === -1 ? 3 : 3 + displayRow - state.sidebar.scrollOffset;
    appendPositionedPayload(ctx, renderConversationActionMenu(
      menu,
      anchorRow,
      SIDEBAR_WIDTH + 1,
      rows,
      cols,
    ));
  }

  // ── Ephemeral BTW panel (foreground, directly above the prompt) ──
  if (btwPanel) {
    // The reduced history viewport no longer paints these rows, so explicitly
    // preserve the sidebar background and right border alongside the BTW card.
    for (let row = btwPanel.top; row < btwPanel.top + btwPanel.height; row++) {
      emitSidebarCol(ctx, row);
    }
    appendPositionedPayload(ctx, btwPanel.payload);
  }

  const canScrollMessageRegion = !sidebarOpen
    && !state.autocomplete
    && !taskPanel
    && !state.search?.barOpen
    && !state.queuePrompt
    && !state.editMessagePrompt
    && !state.btw
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
