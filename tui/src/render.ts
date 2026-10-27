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

import { isActiveConversationLoading, type RenderState } from "./state";
import type { ImageAttachment, UserMessageAutomation } from "./messages";
import { ownerWords } from "./turncollapse";
import { getViewStart, getViewStartFor } from "./chatscroll";
import { smoothScrollerFor, type ScrollRect } from "./smoothscroll";
import { shouldHoldOpeningFrame } from "./historypagination";
import {
  applyChatConversationScroll,
  hasReadyConversationScrollRestore,
  isConversationScrollRestoreWaitingForInitialBackfill,
} from "./conversationscroll";
import { renderTopbar } from "./topbar";
import { renderSidebar, renderSidebarActionMenu, sidebarActionMenuAnchorRow, SIDEBAR_WIDTH } from "./sidebar";
import { createSidebarState } from "./sidebar/state";
import { isGlobalIdleQueuedMessage, steersInstantly } from "./queue";
import { getSidebarSearchBarViewport } from "./sidebarsearch";
import { buildMessageLines, type BuildMessageLinesResult, type RenderLineSegment } from "./conversation";
import { computeBottomLayout } from "./chatlayout";
import { PROMPT_PREFIX_WIDTH } from "./promptline";
import { show_cursor, hide_cursor, cursor_block, cursor_underline, cursor_bar, applyLineBg } from "./terminal";
import { hexToAnsi, theme } from "./theme";
import { clampCursor, stripAnsi, contentBounds, logicalLineRange } from "./historycursor";
import { renderLineWithCursor, renderLineWithSearch, renderLineWithSelection } from "./cursorrender";
import { getPromptHighlightRanges, highlightPromptInput } from "./prompthighlight";
import { macroDisplayContext } from "./commands";
import { macroGhostText, macroGuide, macroPopupRow } from "./usermacros/guide";
import { macroGuideContext } from "./usermacros/controller";
import { isMacroCommandText } from "./usermacros/parse";
import { fitGhostText } from "./usermacros/render";
import type { SlashCompletion } from "./slashsearch";
import { formatSize, imageLabel } from "./clipboard";
import { renderQueuePromptOverlay } from "./overlays";
import { renderEditMessageOverlay } from "./overlays";
import { renderInstructionsModal, type RenderedInstructionsModal } from "./instructions/render";
import { findSearchMatches, getActiveSearchQuery, getSearchBarViewport } from "./search";
import { padRightToWidth, termWidth, visibleLength } from "./textwidth";
import { getVoicePromptRanges } from "./voice";
import {
  hasFocusedConversationIntegrations,
  hasFocusedConversationTasks,
  isTaskPanelExpanded,
  layoutTaskPanel,
} from "./activitypanel";
import { trimAnsiLeadingSpaces, wrapAnsiLine } from "./ansiwrap";
import { getBtwPanelPreferredHeight, MAX_BTW_PANEL_HEIGHT, renderBtwPanel } from "./btw/panel";
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
  type ScrollRegion,
  moveTo,
  scrollRegionsEnabled,
} from "./frame";
import { pinBottomRelativeScrollOffset } from "./viewportscroll";
import { localDayKey } from "./metadata";
import { durableSleepMetadataFrame } from "./durable-sleep-metadata";
import { inlineImageCellSize, inlineImageGeneration, inlineImageMode, inlineImagesActive } from "./inlineimages";
import { renderAccountsScreen } from "./accountsscreen";
import { renderImageModal } from "./imagemodal";
import {
  collectHistoryImages,
  historyImagesPlaced,
  invalidateHistoryImagePlacements,
  syncHistoryImages,
  type ScreenRect,
} from "./historyimages";
import { mathImageGeneration, mathImagesActive } from "./mathimages";

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
  conversationLoadingFrame: number | null;
  durableSleepMetadataFrame: number | null;
  showToolOutput: boolean;
  showTurnWork: boolean;
  showDiagnostics: boolean;
  clock: RenderState["clock"];
  /** Finish times say "yesterday"/dates relative to the local day. */
  metadataDay: string;
  toolRegistryRef: RenderState["toolRegistry"];
  externalToolStylesRef: RenderState["externalToolStyles"];
  themeName: string;
  terminalRows: number;
  imageGeneration: number;
  mathImageGeneration: number;
  result: BuildMessageLinesResult;
}

const historyRenderCache = new WeakMap<RenderState, HistoryRenderCacheEntry>();
const DEFERRED_HISTORY_FALLBACK_MESSAGE_BATCH = 8;
/** First paint includes the visible viewport plus one viewport of scrollback. */
const DEFERRED_HISTORY_TARGET_VIEWPORTS = 2;
const AUTOCOMPLETE_MAX_VISIBLE_ROWS = 10;
const HISTORY_LOADING_FRAME_INTERVAL_MS = 80;

function historyLoadingFrame(state: RenderState): number | null {
  if (!state.historyLoadingOlder) return null;
  return Math.max(0, Math.floor((Date.now() - (state.historyLoadingStartedAt ?? Date.now())) / HISTORY_LOADING_FRAME_INTERVAL_MS));
}

function conversationLoadingFrame(state: RenderState): number | null {
  if (!isActiveConversationLoading(state)) return null;
  return Math.max(0, Math.floor((Date.now() - state.conversationLoading!.startedAt) / HISTORY_LOADING_FRAME_INTERVAL_MS));
}

function canReuseHistoryRender(
  cached: HistoryRenderCacheEntry,
  state: RenderState,
  width: number,
  currentDurableSleepMetadataFrame: number | null,
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
    && cached.conversationLoadingFrame === conversationLoadingFrame(state)
    && cached.durableSleepMetadataFrame === currentDurableSleepMetadataFrame
    && cached.showToolOutput === state.showToolOutput
    && cached.showTurnWork === state.showTurnWork
    && cached.showDiagnostics === state.showDiagnostics
    && cached.clock === state.clock
    && cached.metadataDay === localDayKey(Date.now())
    && cached.toolRegistryRef === state.toolRegistry
    && cached.externalToolStylesRef === state.externalToolStyles
    && cached.themeName === theme.name
    && cached.terminalRows === state.rows
    && cached.imageGeneration === inlineImageGeneration()
    && cached.mathImageGeneration === mathImageGeneration();
}

function shouldForceFullHistoryRender(state: RenderState): boolean {
  const restore = state.conversationScroll.pendingRestore;
  // A remembered bottom is width/history independent. It can be restored from
  // the viewport-sized suffix; wrapping all fifteen buffered turns buys nothing.
  const restoreNeedsFullHistory = hasReadyConversationScrollRestore(state)
    && !(restore?.mode === "percentage" && restore.percentage === 1);
  return state.pendingAI !== null
    || restoreNeedsFullHistory
    || state.scrollOffset > 0
    || state.showToolOutput
    || state.search?.barOpen === true
    || (state.panelFocus === "chat" && state.chatFocus === "history");
}

function canUseDeferredHistoryRender(state: RenderState, width: number): boolean {
  return !shouldForceFullHistoryRender(state)
    && state.convId !== null
    && state.messages.length > 0
    && width > 0;
}

/**
 * Find the start of the complete user turn immediately before `beforeIndex`.
 * Synthetic/test histories without user messages retain the old bounded message
 * batching behavior so progressive rendering still makes forward progress.
 */
function previousHistoryTurnStart(state: RenderState, beforeIndex: number): number {
  const safeBeforeIndex = Math.max(0, Math.min(beforeIndex, state.messages.length));
  for (let index = safeBeforeIndex - 1; index >= 0; index--) {
    if (state.messages[index]?.role === "user") return index;
  }
  return Math.max(0, safeBeforeIndex - DEFERRED_HISTORY_FALLBACK_MESSAGE_BATCH);
}

function buildDeferredHistorySuffix(
  state: RenderState,
  width: number,
  targetLines: number,
): BuildMessageLinesResult {
  // Start with one complete newest turn, then add older turns only until the
  // suffix fills the visible viewport and its scrollback buffer. Turn sizes vary
  // wildly (a single tool-heavy turn can be hundreds of terminal rows), so fixed
  // message/turn counts either leave the screen sparse or do excessive work.
  let startMessageIndex = previousHistoryTurnStart(state, state.messages.length);
  let result = buildMessageLines(state, width, { startMessageIndex, partial: startMessageIndex > 0, reuseArrays: true });

  while (startMessageIndex > 0 && result.lines.length < targetLines) {
    const nextStartMessageIndex = previousHistoryTurnStart(state, startMessageIndex);
    if (nextStartMessageIndex === startMessageIndex) break;
    startMessageIndex = nextStartMessageIndex;
    result = buildMessageLines(state, width, { startMessageIndex, partial: startMessageIndex > 0, reuseArrays: true });
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

/**
 * A full build has every loaded row, so there is nothing left to defer at this
 * width. Clearing the state instead restarted the progressive suffix after
 * every streamed turn or scrolled-up frame, walking the whole loaded history
 * back one turn per tick (seconds of CPU in a long conversation).
 */
function markHistoryRenderComplete(state: RenderState, width: number): void {
  const deferred = state.deferredHistoryRender;
  if (deferred?.complete && deferred.convId === state.convId && deferred.width === width) return;
  state.deferredHistoryRender = {
    convId: state.convId,
    width,
    startMessageIndex: 0,
    generation: (deferred?.generation ?? 0) + 1,
    complete: true,
  };
}

function getHistoryRender(
  state: RenderState,
  width: number,
  targetLines: number,
): BuildMessageLinesResult {
  if (state.pendingAI) {
    markHistoryRenderComplete(state, width);
    historyRenderCache.delete(state);
    return buildMessageLines(state, width, { reuseArrays: true });
  }

  const currentDurableSleepMetadataFrame = durableSleepMetadataFrame(state);
  const cached = historyRenderCache.get(state);
  if (cached && canReuseHistoryRender(cached, state, width, currentDurableSleepMetadataFrame)) {
    return cached.result;
  }

  const deferred = state.deferredHistoryRender;
  let result: BuildMessageLinesResult;
  if (deferred
    && deferred.convId === state.convId
    && deferred.width === width
    && deferred.complete) {
    result = buildMessageLines(state, width, { reuseArrays: true });
  } else if (deferred
    && deferred.convId === state.convId
    && deferred.width === width
    && !deferred.complete
    && canUseDeferredHistoryRender(state, width)) {
    result = buildMessageLines(state, width, { startMessageIndex: deferred.startMessageIndex, partial: deferred.startMessageIndex > 0, reuseArrays: true });
  } else if (canUseDeferredHistoryRender(state, width)) {
    result = buildDeferredHistorySuffix(state, width, targetLines);
  } else {
    markHistoryRenderComplete(state, width);
    result = buildMessageLines(state, width, { reuseArrays: true });
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
    conversationLoadingFrame: conversationLoadingFrame(state),
    durableSleepMetadataFrame: currentDurableSleepMetadataFrame,
    showToolOutput: state.showToolOutput,
    showTurnWork: state.showTurnWork,
    showDiagnostics: state.showDiagnostics,
    clock: state.clock,
    metadataDay: localDayKey(Date.now()),
    toolRegistryRef: state.toolRegistry,
    externalToolStylesRef: state.externalToolStyles,
    themeName: theme.name,
    terminalRows: state.rows,
    imageGeneration: inlineImageGeneration(),
    mathImageGeneration: mathImageGeneration(),
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
  // Each step rebuilds the rows it includes, so grow the suffix geometrically:
  // one turn per step made extending to a long loaded history quadratic.
  let includedTurns = 0;
  for (let index = deferred.startMessageIndex; index < state.messages.length; index++) {
    if (state.messages[index]?.role === "user") includedTurns++;
  }
  let nextStart = deferred.startMessageIndex;
  for (let step = 0; step < Math.max(1, includedTurns); step++) {
    const previous = previousHistoryTurnStart(state, nextStart);
    if (previous === nextStart) break;
    nextStart = previous;
  }
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
  lineStart: number | undefined,
  selStart: number,
  selEnd: number,
  buffer: string,
  isLinewise: boolean,
): string {
  if (lineStart === undefined) return line;

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
  lineStart: number | undefined,
  ranges: Array<{ start: number; end: number; color: string }>,
): string {
  if (lineStart === undefined) return line;
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
  /** Per-screen-row sidebar segment within `frameRows` (see RenderFrame.pinned). */
  pinnedRows: (string | undefined)[];
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
    ctx.pinnedRows[screenRow - 1] = moveTo(screenRow, 1) + ctx.sbRows[screenRow - 1];
  }
}

// ── Extracted sub-functions ──────────────────────────────────────────

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
  revision: number;
  lineAnchors: BuildMessageLinesResult["lineAnchors"];
  viewStart: number;
  messageAreaHeight: number;
  panelHeight: number;
  narrowWidth: number;
  fullWidth: number;
  preserveTop: boolean;
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

function isRightAlignedHistorySegment(segment: RenderLineSegment | undefined): boolean {
  return segment === "automation_label"
    || segment === "queued_label";
}

/** Rows whose leading spaces express viewport alignment rather than semantic indentation. */
function shiftsWithNarrowHistory(segment: RenderLineSegment | undefined): boolean {
  return segment === "user_content"
    || segment === "user_image"
    || segment === "queued_content"
    || isRightAlignedHistorySegment(segment);
}

function continuationIndent(line: string, segment: RenderLineSegment | undefined): string {
  if (shiftsWithNarrowHistory(segment)) return "";
  return stripAnsi(line).match(/^ +(?=\S)/)?.[0] ?? "";
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
  const owner = anchor?.owner as {
    text?: unknown;
    automation?: unknown;
    metadata?: { automation?: unknown } | null;
  } | undefined;
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
  // The same background the bubble was built with: the owner's words (typed or relayed) only.
  const automation = (owner.automation ?? owner.metadata?.automation) as UserMessageAutomation | undefined;
  const adaptive = renderAdaptiveUserMessageRows(
    anchor.userFlowDocument,
    sourceStart,
    sourceEnd,
    colsForRow,
    ownerWords(owner.text, automation) ? theme.userBg : theme.automatedUserBg,
  );
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
        && shiftsWithNarrowHistory(segment)) {
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

      // Image rows are pictures, not text: clip instead of wrapping.
      if (wrapped.lines.length <= 1 || lineAnchors[lineIndex]?.images) break;
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
      && shiftsWithNarrowHistory(segment)) {
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
    if (firstWrap.lines.length <= 1 || anchor?.images) continue;

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

/**
 * Visible widths of recently drawn history rows. Rows keep their content (and
 * mostly their string identity) across frames, so each is measured once.
 */
const historyRowWidths = new Map<string, number>();
const HISTORY_ROW_WIDTHS_MAX = 4096;

function historyRowWidth(line: string): number {
  let width = historyRowWidths.get(line);
  if (width === undefined) {
    if (historyRowWidths.size >= HISTORY_ROW_WIDTHS_MAX) historyRowWidths.clear();
    width = visibleLength(line);
    historyRowWidths.set(line, width);
  }
  return width;
}

/**
 * History rows as built, which should fit the width they were built for. Any
 * that do not (image rows, or a renderer bug) are clipped to it: a row drawn
 * past the pane auto-wraps onto the terminal's next row, where it lingers over
 * the sidebar or prompt after the next incremental frame.
 */
function canonicalViewportRows(
  allLines: string[],
  startLineIndex: number,
  endLineIndex: number,
  width: number,
): ViewportHistoryRow[] {
  const rows: ViewportHistoryRow[] = [];
  for (let lineIndex = startLineIndex; lineIndex < endLineIndex; lineIndex++) {
    let line = allLines[lineIndex];
    if (line === undefined) continue;
    // No glyph is wider than two columns per UTF-16 unit, so short rows skip measuring.
    if (line.length * 2 > width && historyRowWidth(line) > width) {
      line = wrapRenderedHistoryLine(line, Math.max(1, width)).lines[0] ?? "";
    }
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
/**
 * What moves when the history scrolls smoothly: the history columns of the
 * band, except the Tasks panel's columns above the first row below it.
 */
export function smoothScrollRects(
  band: ScrollRegion,
  chatCol: number,
  chatW: number,
  panelCol: number | null,
  belowPanel: number,
): ScrollRect[] {
  const right = chatCol + chatW - 1;
  if (panelCol === null || panelCol <= chatCol || panelCol > right) {
    return [{ top: band.start, left: chatCol, bottom: band.end, right }];
  }
  const rects: ScrollRect[] = [{ top: band.start, left: chatCol, bottom: band.end, right: panelCol - 1 }];
  const top = Math.max(band.start, belowPanel);
  if (top <= band.end) rects.push({ top, left: panelCol, bottom: band.end, right });
  return rects;
}

/** The longest run of rows in [start, end] that no rectangle touches (null below 4 rows). */
export function freeMessageBand(start: number, end: number, floats: readonly ScreenRect[]): ScrollRegion | null {
  let best: ScrollRegion | null = null;
  let runStart = start;
  for (let row = start; row <= end + 1; row++) {
    const covered = row > end || floats.some(rect => rect.top <= row && row <= rect.bottom);
    if (!covered) continue;
    if (row - runStart >= 4 && (!best || row - runStart > best.end - best.start + 1)) {
      best = { start: runStart, end: row - 1 };
    }
    runStart = row + 1;
  }
  return best;
}

function composeFloatingHistoryViewport(
  allLines: string[],
  lineAnchors: BuildMessageLinesResult["lineAnchors"],
  revision: number,
  viewStart: number,
  messageAreaHeight: number,
  panelHeight: number,
  narrowWidth: number,
  fullWidth: number,
  preserveTop = false,
): ViewportHistoryRow[] {
  const cached = floatingHistoryViewportCache.get(allLines);
  if (cached
    && cached.revision === revision
    && cached.lineAnchors === lineAnchors
    && cached.viewStart === viewStart
    && cached.messageAreaHeight === messageAreaHeight
    && cached.panelHeight === panelHeight
    && cached.narrowWidth === narrowWidth
    && cached.fullWidth === fullWidth
    && cached.preserveTop === preserveTop) {
    return cached.rows;
  }

  const endLineIndex = Math.min(allLines.length, viewStart + messageAreaHeight);
  if (viewStart >= endLineIndex) return [];

  if (panelHeight <= 0 || narrowWidth === fullWidth) {
    const rows = canonicalViewportRows(allLines, viewStart, endLineIndex, fullWidth);
    floatingHistoryViewportCache.set(allLines, {
      revision,
      lineAnchors,
      viewStart,
      messageAreaHeight,
      panelHeight,
      narrowWidth,
      fullWidth,
      preserveTop,
      rows,
    });
    return rows;
  }

  // Final-response autoscroll is a semantic top anchor. The canonical history
  // was wrapped at full chat width, so task-panel reflow can otherwise clip the
  // first one or two visual chunks while preserving the viewport's bottom tail.
  // Compose forward from the exact source start for this one placement mode.
  if (preserveTop) {
    const rows = composeViewportFrom(
      allLines,
      lineAnchors,
      canonicalSourceState(allLines, viewStart),
      endLineIndex,
      0,
      panelHeight,
      narrowWidth,
      fullWidth,
    ).slice(0, messageAreaHeight);
    floatingHistoryViewportCache.set(allLines, {
      revision,
      lineAnchors,
      viewStart,
      messageAreaHeight,
      panelHeight,
      narrowWidth,
      fullWidth,
      preserveTop,
      rows,
    });
    return rows;
  }

  // At the canonical top there is no preceding viewport that can reveal rows
  // displaced by narrow wrapping, so keep the beginning anchored and clip any
  // reflow overflow at the bottom. Genuinely short histories also stay
  // top-aligned; a full canonical viewport can use the bottom-anchored path.
  const atCanonicalTop = viewStart === 0;
  if (atCanonicalTop || endLineIndex - viewStart < messageAreaHeight) {
    const directRows = composeViewportFrom(
      allLines,
      lineAnchors,
      canonicalSourceState(allLines, viewStart),
      endLineIndex,
      0,
      panelHeight,
      narrowWidth,
      fullWidth,
    );
    if (atCanonicalTop || directRows.length <= messageAreaHeight) {
      const rows = directRows.slice(0, messageAreaHeight);
      floatingHistoryViewportCache.set(allLines, {
        revision,
        lineAnchors,
        viewStart,
        messageAreaHeight,
        panelHeight,
        narrowWidth,
        fullWidth,
        preserveTop,
        rows,
      });
      return rows;
    }
  }

  const narrowRowCount = Math.min(panelHeight, messageAreaHeight);
  const fullRowCount = Math.max(0, messageAreaHeight - narrowRowCount);

  // Preserve the newest canonical full-width rows. Narrow wrapping above this
  // boundary is presentation-only and cannot displace the tail near the prompt.
  const fullStartIndex = Math.max(viewStart, endLineIndex - fullRowCount);
  const narrowSourceStartIndex = Math.max(viewStart, fullStartIndex - narrowRowCount);

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
  const visibleRows = [...narrowRows, ...fullRows].slice(-messageAreaHeight);
  floatingHistoryViewportCache.set(allLines, {
    revision,
    lineAnchors,
    viewStart,
    messageAreaHeight,
    panelHeight,
    narrowWidth,
    fullWidth,
    preserveTop,
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
  lineAnchors: BuildMessageLinesResult["lineAnchors"] = [],
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
      const math = inVisual ? mathImageSpan(lineAnchors[lineIdx], lineIdx) : null;

      if (math) {
        // A display-math image selects as one unit, like one glyph: when the
        // selection touches any of its rows, its whole cell rectangle is selected.
        if (math.first <= vEndRow && math.last >= vStartRow) {
          const localStart = Math.max(displayPrefixWidth, math.col - viewportRow.startCol + displayPrefixWidth);
          const localEnd = localStart + math.cols - 1;
          const padded = rendered + " ".repeat(Math.max(0, localEnd + 1 - plain.length));
          rendered = renderLineWithSelection(padded, localStart, localEnd);
        }
      } else if (inVisual && lineIdx >= vStartRow && lineIdx <= vEndRow) {
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

/** The history rows and columns of the display-math image on line `lineIndex`, if any. */
function mathImageSpan(
  anchor: BuildMessageLinesResult["lineAnchors"][number] | undefined,
  lineIndex: number,
): { first: number; last: number; col: number; cols: number } | null {
  const image = anchor?.images?.[0];
  if (!image || !("kitty" in image.layout)) return null;
  const first = lineIndex - image.row;
  return { first, last: first + image.layout.rows - 1, col: image.layout.col, cols: image.layout.cols };
}

function autocompleteDisplayText(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1F\x7F]/g, "");
}

/** Pad an autocomplete name, accenting the matched characters that survive truncation. */
function renderAutocompleteName(
  match: NonNullable<RenderState["autocomplete"]>["matches"][number],
  displayName: string,
  width: number,
): string {
  const padded = padRightToWidth(displayName, width);
  const ranges = match.matchRanges;
  // Ranges index the raw name; skip them if display sanitizing changed it.
  if (!ranges?.length || displayName !== match.name) return padded;

  let visible = 0;
  while (visible < displayName.length && padded[visible] === displayName[visible]) visible++;
  let result = "";
  let pos = 0;
  for (const { start, end } of ranges) {
    const from = Math.max(start, pos);
    const to = Math.min(end, visible);
    if (from >= to) continue;
    result += padded.slice(pos, from) + theme.accent + theme.bold + padded.slice(from, to) + theme.boldOff + theme.text;
    pos = to;
  }
  return result + padded.slice(pos);
}

function renderAutocompleteDescription(
  match: NonNullable<RenderState["autocomplete"]>["matches"][number],
  text: string,
  width: number,
): string {
  if (!match.colorSwatches || match.colorSwatches.length === 0) {
    return (match.descColor ?? theme.dim) + padRightToWidth(text, width);
  }
  const colors = match.colorSwatches.slice(0, Math.max(0, width));
  const swatches = colors.map((color) => `${hexToAnsi(color)}█`).join("");
  return swatches + theme.dim + " ".repeat(Math.max(0, width - colors.length));
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
  shown: { matches: SlashCompletion[]; selection: number } | null = state.autocomplete,
): ScreenRect | null {
  if (!shown || shown.matches.length === 0) return null;

  const { chatCol } = ctx;
  const { matches, selection: sel } = shown;
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
    const name = renderAutocompleteName(visibleMatches[vi], visibleNames[vi], nameWidth);
    const desc = renderAutocompleteDescription(visibleMatches[vi], visibleDescs[vi], descWidth);
    const upIndicator = vi === 0 && winStart > 0;
    const downIndicator = vi === winSize - 1 && winStart + winSize < total;
    const indicator = indicatorWidth > 0
      ? padRightToWidth(upIndicator ? " ▲" : downIndicator ? " ▼" : "", indicatorWidth)
      : "";
    appendRowWrite(
      ctx,
      row,
      chatCol,
      bg + theme.accent + marker + theme.text + name + desc + indicator + theme.reset,
    );
  }
  return { top: topRow, bottom: sepAbove - 1, left: chatCol, right: chatCol + desiredPopupWidth - 1 };
}

/**
 * What the normal popup shows. A /macro line puts its error, preview or next
 * part there as a row of its own when there is nothing to complete (an error
 * always wins); every other prompt shows its completions as usual.
 */
function macroPopupRows(state: RenderState): { matches: SlashCompletion[]; selection: number } | null {
  if (!editingMacroCommand(state)) return state.autocomplete;
  const guide = macroGuide(state.inputBuffer, state.cursorPos, macroGuideContext(state, macroDisplayContext(state)));
  const completing = state.autocomplete && state.autocomplete.matches.length > 0;
  if (guide?.detail?.kind !== "error" && completing) return state.autocomplete;
  const row = guide ? macroPopupRow(guide) : null;
  return row ? { matches: [row], selection: -1 } : null;
}

/** Whether the prompt holds a /macro command the user is editing. */
function editingMacroCommand(state: RenderState): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "prompt" && !state.instructionsModal
    && isMacroCommandText(state.inputBuffer);
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
  lineStarts: number[],
  promptFocused: boolean,
): void {
  const { chatCol, bgLine } = ctx;
  const promptInVisual = promptFocused
    && (state.vim.mode === "visual" || state.vim.mode === "visual-line");

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
      lineContent = highlightPromptLine(lineContent, lineStarts[i], selStart, selEnd,
        state.inputBuffer, state.vim.mode === "visual-line");
    }

    emitSidebarCol(ctx, row);
    appendRowWrite(ctx, row, chatCol, bgLine(prompt + lineContent));
  }
}

/** The editor's cursor, shaped like the prompt's for the same Vim mode; hidden in the picker. */
function instructionsCursorPayload(overlay: RenderedInstructionsModal): string {
  const cursor = overlay.cursor;
  if (!cursor) return hide_cursor;
  const shape = cursor.shape === "bar" ? cursor_bar : cursor.shape === "underline" ? cursor_underline : cursor_block;
  return moveTo(cursor.row, cursor.col) + shape + show_cursor;
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
  if (state.imageModal || state.accountsScreen || state.instructionsModal) return hide_cursor;
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
        : (state.vim.pendingOperator || state.vim.pendingReplace
          || state.vim.pendingKeys === "<" || state.vim.pendingKeys === ">") ? cursor_underline
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

/**
 * Build and present one retained terminal frame.
 *
 * A remembered percentage is meaningful only after the initial history backfill
 * has arrived. Keep the previously presented frame intact until then; otherwise
 * the partial five-turn window is painted at the bottom for one frame before the
 * completed window jumps to its restored position.
 */
export function render(state: RenderState): boolean {
  if (state.sshConnecting) {
    // Paint progress outside the transcript: a speculative startup load can
    // replace messages while SSH is probing, but must never erase this view.
    const { cols, rows } = state;
    const appBg = theme.appBg ?? "";
    const frameRows = createFrameRows(rows, appBg + clearLine);
    const sidebarWidth = state.sidebar.open ? SIDEBAR_WIDTH : 0;
    const chatCol = sidebarWidth + 1;
    const chatW = Math.max(1, cols - sidebarWidth);
    const writeChatRow = (row: number, text: string) => appendFrameRowWrite(
      frameRows, row, chatCol, appBg ? applyLineBg(text, appBg) : text,
    );
    if (state.sidebar.open) {
      const sidebarRows = renderSidebar(createSidebarState(), rows, false, null);
      sidebarRows.forEach((line, index) => appendFrameRowWrite(frameRows, index + 1, 1, line));
    }
    writeChatRow(1, renderTopbar(state, chatW));
    const separator = `${theme.dim}${"─".repeat(chatW)}${theme.reset}`;
    writeChatRow(2, separator);

    // Only the top bar and progress are visible until the connection is ready.
    // The normal prompt/footer returns after loading or cancellation.
    const width = Math.max(1, chatW - 2);
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][Math.floor(Date.now() / 80) % 10];
    const { lines } = wordWrap(`${spinner} ${state.sshConnecting.message}`, width);
    const progressRows = Math.max(0, rows - 2);
    lines.slice(0, progressRows).forEach((line, index) => writeChatRow(
      index + 3, `${theme.warning}${chatW > 1 ? " " : ""}${line}${theme.reset}`,
    ));
    flushFrame(state, { rows: frameRows, cursor: hide_cursor, scrollRegion: null, viewStart: 0, graphics: syncHistoryImages(state, []) });
    return true;
  }
  if (isConversationScrollRestoreWaitingForInitialBackfill(state)) return false;

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
      state.pendingAI ? state.convId : null,
      state.sshRemote?.alias ?? null,
    );
  }

  // ── Shared render context ─────────────────────────────────────
  const ctx: RenderCtx = {
    frameRows: createFrameRows(rows, cl),
    pinnedRows: [],
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
  const { lines: inputLines, lineStarts, isNewLine, cursorLine, cursorCol, scrollOffset: newPromptScroll } = input;
  state.promptScrollOffset = newPromptScroll;

  // Syntax-highlight valid commands/macros in the rendered prompt even while
  // voice placeholders are present. Voice ranges are just another rendered
  // decoration, so slash macros typed after a pending transcription still look
  // and behave like normal prompt text.
  const voicePrompts = [...state.voicePromptJobs, ...(state.voicePrompt ? [state.voicePrompt] : [])];
  const coloredInputLines = voicePrompts.length > 0
    ? (() => {
      const commandRanges = getPromptHighlightRanges(state, renderedPrompt.buffer)
        .map(range => ({ ...range, color: range.color ?? theme.command }));
      const voiceRanges = getVoicePromptRanges(state.inputBuffer, voicePrompts)
        .map(range => ({ ...range, color: theme.accent }));
      return inputLines.map((line, idx) => colorPlainPromptDecorations(
        line,
        lineStarts[idx],
        [...commandRanges, ...voiceRanges],
      ));
    })()
    : highlightPromptInput(state, inputLines, state.inputBuffer, lineStarts);

  // Dim ghost text after the cursor names the /macro parts still to type.
  if (editingMacroCommand(state) && state.vim.mode === "insert" && voicePrompts.length === 0) {
    const ghost = macroGhostText(state.inputBuffer, state.cursorPos, macroDisplayContext(state));
    const line = coloredInputLines[cursorLine];
    if (ghost && line !== undefined) {
      coloredInputLines[cursorLine] = line + fitGhostText(ghost, visibleLength(line), chatW - PROMPT_PREFIX_WIDTH);
    }
  }

  const slHeight = status.height;
  const statusLines = status.lines;

  // BTW grows upward with the stream, then scrolls once it reaches its limit.
  // It consumes the bottom of the chat viewport rather than hiding history rows.
  let btwPanel = null;
  if (state.btw) {
    const availableRows = Math.max(1, baseMessageAreaHeight);
    const btwRenderOptions = {
      toolRegistry: state.toolRegistry,
      externalToolStyles: state.externalToolStyles,
      showToolOutput: state.showToolOutput,
      focused: state.panelFocus === "chat" && state.chatFocus === "btw",
      vimMode: state.vim.mode,
      searchQuery: state.chatFocus === "btw" ? getActiveSearchQuery(state) : null,
    };
    const preferredHeight = getBtwPanelPreferredHeight(state.btw, chatW, btwRenderOptions);
    const btwHeight = availableRows >= 3
      ? Math.min(preferredHeight, availableRows, MAX_BTW_PANEL_HEIGHT)
      : 1;
    const btwTop = bottomStartRow - btwHeight;
    btwPanel = renderBtwPanel(state.btw, chatW, btwHeight, btwTop, chatCol, btwRenderOptions);
  }
  const messageAreaHeight = Math.max(0, baseMessageAreaHeight - (btwPanel?.height ?? 0));

  // Prompt separator
  const promptFocused = state.panelFocus === "chat" && state.chatFocus === "prompt";
  const promptColor = promptFocused ? theme.accent : theme.dim;

  // ── Message area (rows 3 to bottomStartRow-1) ──────────────────
  const messageAreaStart = 3;
  // An expanded panel belongs to the conversation it was opened in, and ends with its last entry.
  if (state.taskPanelExpansion && (!isTaskPanelExpanded(state)
    || (!hasFocusedConversationTasks(state) && !hasFocusedConversationIntegrations(state)))) {
    state.taskPanelExpansion = null;
  }
  const taskLayout = layoutTaskPanel(state, chatW, messageAreaHeight);
  const historyWidth = taskLayout.historyWidth;
  const deferredTargetLines = Math.max(1, messageAreaHeight * DEFERRED_HISTORY_TARGET_VIEWPORTS);
  const { lines: allLines, messageBounds, wrapContinuation, wrapJoiners, copyLines, lineAnchors, revision: historyRevision } = getHistoryRender(
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
  const previousScrollOffset = state.scrollOffset;
  const unpinnedScrollOffset = state.scrollOffset;
  state.scrollOffset = pinBottomRelativeScrollOffset(state.scrollOffset, prevTotal, totalLines);
  const scrollPinDelta = state.scrollOffset - unpinnedScrollOffset;

  // Cache layout for scroll and mouse functions
  state.layout.totalLines = totalLines;
  state.layout.messageAreaHeight = messageAreaHeight;
  state.layout.historyWidth = historyWidth;
  state.layout.chatWidth = chatW;
  state.layout.chatCol = chatCol;
  state.layout.sepAbove = bottomStartRow;
  state.layout.firstInputRow = firstInputRow;
  state.layout.sepBelow = sepBelow;
  const usagePlacement = status.placements.find(placement => placement.id === "usage");
  state.layout.usageBlockRect = usagePlacement ? {
    top: sepBelow + 1,
    bottom: sepBelow + usagePlacement.height,
    left: chatCol + usagePlacement.col,
    right: chatCol + usagePlacement.col + usagePlacement.width - 1,
  } : null;
  // Keep the previous frame (the opening spinner) rather than paint a partial
  // screen that the in-flight older history would immediately push down.
  if (shouldHoldOpeningFrame(state)) return false;

  const taskPanelFlowHeight = taskLayout.panel
    ? Math.min(messageAreaHeight, taskLayout.panel.lines.length + 1)
    : 0;
  const scrollUpdate = applyChatConversationScroll(
    state,
    lineAnchors,
    messageBounds,
    totalLines,
    messageAreaHeight,
    previousScrollOffset,
    (responseStart) => {
      // Following pins the entire history tail, not just the text block. Its
      // metadata (and any other rows below it) consumes viewport space too.
      // Omitting that footer lets task-panel reflow clip the first response
      // chunk even when the measured text height still fits exactly.
      if (taskPanelFlowHeight <= 0 || historyWidth === chatW) {
        return totalLines - responseStart;
      }
      return composeViewportFrom(
        allLines,
        lineAnchors,
        canonicalSourceState(allLines, responseStart),
        totalLines,
        0,
        taskPanelFlowHeight,
        historyWidth,
        chatW,
      ).length;
    },
  );

  // App-driven smooth scrolling lays the history out at a whole offset next
  // to the animated position (smoothscroll.ts); everything else (input,
  // cursor, pinning) keeps working on the logical scrollOffset.
  const smooth = smoothScrollerFor(state);
  let viewStart = scrollUpdate.topAnchorRow ?? getViewStart(state);
  if (smooth) {
    const maxOffset = Math.max(0, totalLines - messageAreaHeight);
    const logical = Math.min(state.scrollOffset, maxOffset);
    // A different conversation, terminal size, pane height or history width
    // (the sidebar, the Tasks panel) re-lays everything out: no glide.
    const context = `${state.convId ?? ""}|${state.cols}x${state.rows}|${messageAreaHeight}|${chatW}|${historyWidth}`;
    if (scrollUpdate.topAnchorRow !== null) smooth.snap(logical);
    else viewStart = getViewStartFor(totalLines, messageAreaHeight, smooth.layout(logical, maxOffset, scrollPinDelta, messageAreaHeight, context));
  }
  const preserveViewportTop = scrollUpdate.topAnchorRow !== null;

  // Float the task panel over only the history rows it actually occupies,
  // keeping one extra row narrow below the card as visual breathing room.
  const taskPanel = taskLayout.panel;
  const panelFlowHeight = taskPanel ? Math.min(messageAreaHeight, taskPanel.lines.length + 1) : 0;
  const viewportRows = composeFloatingHistoryViewport(
    allLines,
    lineAnchors,
    historyRevision,
    viewStart,
    messageAreaHeight,
    panelFlowHeight,
    taskPanel ? historyWidth : chatW,
    chatW,
    preserveViewportTop,
  );
  state.layout.historyViewportRows = Array.from(
    { length: messageAreaHeight },
    (_, index) => viewportRows[index]
      ? {
        lineIndex: viewportRows[index].lineIndex,
        startCol: viewportRows[index].startCol,
        displayPrefixWidth: viewportRows[index].displayPrefixWidth,
        endCol: viewportRows[index].startCol + stripAnsi(viewportRows[index].line).length - viewportRows[index].displayPrefixWidth,
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

  // Search belongs to the focused history surface. When BTW is focused its
  // renderer paints the matches; do not also highlight the background chat.
  const searchQuery = state.chatFocus === "btw" ? null : getActiveSearchQuery(state);

  renderMessageArea(
    ctx, allLines, viewportRows,
    messageAreaStart, messageAreaHeight,
    historyFocused, inVisual, state.vim.mode,
    vAnchor, vCursor, vStartRow, vEndRow,
    hlFirst, hlLast, searchQuery, lineAnchors,
  );

  // ── Active task panel (top-right float) ────────────────────────
  state.layout.taskPanelRect = null;
  state.layout.taskPanelMaxScroll = taskPanel?.maxScroll ?? 0;
  state.layout.taskPanelToggleable = taskPanel?.toggleable ?? false;
  if (state.taskPanelExpansion && taskPanel) state.taskPanelExpansion.scroll = taskPanel.scroll;
  if (taskPanel) {
    const panelCol = chatCol + chatW - taskPanel.width;
    const panelTop = messageAreaStart;
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
  const autocompleteRect = renderAutocompletePopup(ctx, state, chatW, bottomStartRow, macroPopupRows(state));

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
    coloredInputLines, isNewLine, lineStarts,
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
  const queuePromptOverlay = state.queuePrompt
    ? renderQueuePromptOverlay(state.queuePrompt, chatW, chatCol, bottomStartRow, steersInstantly(state.provider))
    : null;
  if (queuePromptOverlay) {
    appendPositionedPayload(ctx, queuePromptOverlay.payload);
  }

  // ── Edit message overlay ──────────────────────────────────────
  const editMessageOverlay = state.editMessagePrompt
    ? renderEditMessageOverlay(state.editMessagePrompt, chatW, chatCol, bottomStartRow, messageAreaHeight)
    : null;
  if (editMessageOverlay) appendPositionedPayload(ctx, editMessageOverlay.payload);

  // ── Sidebar action menu ───────────────────────────────────────
  let sidebarMenuOverlay: ReturnType<typeof renderSidebarActionMenu> | null = null;
  if (sidebarOpen && state.sidebar.actionMenu) {
    const menu = state.sidebar.actionMenu;
    sidebarMenuOverlay = renderSidebarActionMenu(
      menu,
      sidebarActionMenuAnchorRow(state.sidebar, menu.item),
      SIDEBAR_WIDTH + 1,
      rows,
      cols,
    );
    appendPositionedPayload(ctx, sidebarMenuOverlay.payload);
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

  // ── Inline history images (Kitty graphics placements) ─────────
  // Floating overlays are drawn as text, which images (z above text) would
  // cover. The task panel, autocomplete, queue prompt, edit menu, conversation
  // menu, accounts screen and image viewer crop them around their box.
  const imageCovers: ScreenRect[] = [state.layout.taskPanelRect, autocompleteRect]
    .filter((rect): rect is ScreenRect => rect !== null);
  // A daemon switch can turn images off under an open viewer.
  if (state.imageModal && !inlineImagesActive()) state.imageModal = null;
  // ── Full-size image viewer (top-most) ─────────────────────────
  // Thumbnails stay where they are around it; closing it lets the next frame
  // delete its placement and restore what it covered.
  const modal = state.imageModal
    ? renderImageModal(state.imageModal, rows, cols, inlineImageCellSize(), inlineImageMode())
    : null;
  if (modal) appendPositionedPayload(ctx, modal.payload);
  // ── Accounts screen (above everything but the image viewer) ───
  const accountsOverlay = state.accountsScreen && !modal
    ? renderAccountsScreen(state, state.accountsScreen, rows, cols)
    : null;
  if (accountsOverlay) appendPositionedPayload(ctx, accountsOverlay.payload);
  // ── /instructions picker or editor ────────────────────────────
  const instructionsOverlay = state.instructionsModal && !modal && !accountsOverlay
    ? renderInstructionsModal(state.instructionsModal, rows, cols)
    : null;
  if (instructionsOverlay) appendPositionedPayload(ctx, instructionsOverlay.payload);
  const hadHistoryImages = historyImagesPlaced(state);
  // With st's image clip regions (mode 2033) the conversation pane is
  // declared as them, like the moving rectangles: the history's columns left
  // of the Tasks panel for the full height, and the panel's columns below
  // it. History images never draw outside it. Not while the image viewer is
  // open (its placement is anchored in the pane).
  const imageClips = smooth?.imageClipSupported && messageAreaHeight > 0 && !modal
    ? smoothScrollRects(
      { start: messageAreaStart, end: messageAreaStart + messageAreaHeight - 1 },
      chatCol, chatW, taskPanel ? chatCol + chatW - taskPanel.width : null, messageAreaStart + panelFlowHeight,
    )
    : [];
  // Display math may be forced to images on a terminal that failed detection.
  const kittyHistory = inlineImageMode() === "kitty";
  const collectedImages = kittyHistory || mathImagesActive()
    ? collectHistoryImages({
      viewportRows: state.layout.historyViewportRows,
      lineAnchors,
      messageAreaStart,
      chatCol,
      maxCol: chatCol + chatW - 1,
      obstructions: [],
      covers: [...imageCovers, modal?.rect, queuePromptOverlay?.rect, editMessageOverlay?.rect, sidebarMenuOverlay?.rect, accountsOverlay?.rect, instructionsOverlay?.rect].filter((rect): rect is ScreenRect => !!rect),
      cursorLineIndex: historyFocused ? state.historyCursor.row : null,
      cursorCol: state.historyCursor.col,
      mathOnly: !kittyHistory,
      // Only while gliding: at rest images are cropped exactly as without it,
      // unless st clips them to the conversation pane (image clip regions):
      // then they stay placed whole past it and slide in and out uncropped.
      extendBelow: smooth?.busy() || imageClips.length > 0 ? messageAreaStart + messageAreaHeight - 1 : undefined,
    })
    : { placements: [], notices: [] };
  // Thumbnails without pixels yet say so on their first visible row.
  for (const notice of collectedImages.notices) {
    appendRowWrite(ctx, notice.row, notice.col, bgLine(`${theme.dim}${notice.text}${theme.reset}`));
  }
  const historyImagePlacements = collectedImages.placements;
  if (modal?.placement) historyImagePlacements.push(modal.placement);
  const graphics = (regionScrolled: boolean): string => {
    // The terminal moved (or dropped) placements with the scrolled rows, so
    // place every visible one again where this frame wants it.
    if (regionScrolled) invalidateHistoryImagePlacements(state);
    return syncHistoryImages(state, historyImagePlacements);
  };

  // Floating elements sit still while the history under them moves.
  // Legacy: any overlay leaves the frame to the plain row diff.
  const overlaysOpen = !!state.autocomplete
    || !!state.search?.barOpen
    || !!state.queuePrompt
    || !!state.editMessagePrompt
    || !!state.btw
    || !!state.imageModal
    || !!state.accountsScreen
    || !!state.instructionsModal;
  const legacyScrollRegion = messageAreaHeight > 0 && !overlaysOpen
    && !sidebarOpen && !taskPanel && !hadHistoryImages && historyImagePlacements.length === 0
    ? { start: messageAreaStart, end: messageAreaStart + messageAreaHeight - 1 }
    : null;
  // Region scrolls: the band is the longest run of message rows no floating
  // element touches. Rows beside one (the Tasks panel and the row it reflows,
  // autocomplete, menus, modals) are drawn in place, so a terminal that
  // animates region scrolls glides only rows that really moved. The sidebar
  // is repainted beside the scrolled rows and images are placed again.
  // With app-driven smooth scrolling the rows beside the Tasks panel scroll
  // too: the panel's columns are simply not part of a moving rectangle.
  const floatRows: ScreenRect[] = [
    panelFlowHeight > 0 && !smooth
      ? { top: messageAreaStart, bottom: messageAreaStart + panelFlowHeight - 1, left: chatCol, right: chatCol + chatW - 1 }
      : null,
    autocompleteRect, queuePromptOverlay?.rect, editMessageOverlay?.rect, sidebarMenuOverlay?.rect,
    modal?.rect, accountsOverlay?.rect, instructionsOverlay?.rect,
  ].filter((rect): rect is ScreenRect => !!rect);
  const scrollRegion = scrollRegionsEnabled()
    ? freeMessageBand(messageAreaStart, messageAreaStart + messageAreaHeight - 1, floatRows)
    : legacyScrollRegion;

  const smoothRects = smooth && scrollRegion
    ? smoothScrollRects(scrollRegion, chatCol, chatW, taskPanel ? chatCol + chatW - taskPanel.width : null, messageAreaStart + panelFlowHeight)
    : [];
  flushFrame(state, {
    afterScroll: smooth ? (regionShift, intact) => smooth.afterFlush(regionShift, smoothRects, intact, imageClips) : undefined,
    rows: ctx.frameRows,
    pinned: ctx.pinnedRows,
    cursor: instructionsOverlay ? instructionsCursorPayload(instructionsOverlay) : buildCursorPayload(
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
    scrollRegion,
    viewStart,
    graphics,
  });
  return true;
}
