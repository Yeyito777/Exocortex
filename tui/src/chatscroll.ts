/**
 * Shared chat viewport helpers.
 */

import { buildMessageLines, type RenderLineAnchor, type RenderLineSegment } from "./conversation";
import { computeBottomLayout } from "./chatlayout";
import { SIDEBAR_WIDTH } from "./sidebar";
import type { RenderState } from "./state";

/**
 * First historyLines index visible in the message area.
 *
 * scrollOffset === 0 means "pinned to bottom" (auto-scroll), so we
 * snap to the tail of the buffer. Any positive offset scrolls up.
 * Always clamped to ≥ 0 so callers never get a negative index.
 */
export function getViewStartFor(totalLines: number, messageAreaHeight: number, scrollOffset: number): number {
  if (scrollOffset === 0) return Math.max(0, totalLines - messageAreaHeight);
  return Math.max(0, totalLines - messageAreaHeight - scrollOffset);
}

/** Convert a desired viewport start row back into a scrollOffset. */
export function getScrollOffsetForViewStart(totalLines: number, messageAreaHeight: number, viewStart: number): number {
  const maxViewStart = Math.max(0, totalLines - messageAreaHeight);
  const clampedViewStart = Math.max(0, Math.min(viewStart, maxViewStart));
  return Math.max(0, totalLines - messageAreaHeight - clampedViewStart);
}

export function getViewStart(state: RenderState): number {
  return getViewStartFor(state.layout.totalLines, state.layout.messageAreaHeight, state.scrollOffset);
}

type AnchorRowMap = Map<number, number>;
type AnchorIndex = WeakMap<object, Map<RenderLineSegment, Map<number, AnchorRowMap>>>;

function buildAnchorIndex(anchors: RenderLineAnchor[]): AnchorIndex {
  const byOwner = new WeakMap<object, Map<RenderLineSegment, Map<number, AnchorRowMap>>>();
  for (let row = 0; row < anchors.length; row++) {
    const anchor = anchors[row];
    let bySegment = byOwner.get(anchor.owner);
    if (!bySegment) {
      bySegment = new Map();
      byOwner.set(anchor.owner, bySegment);
    }
    let byIndex = bySegment.get(anchor.segment);
    if (!byIndex) {
      byIndex = new Map();
      bySegment.set(anchor.segment, byIndex);
    }
    let bySubIndex = byIndex.get(anchor.index);
    if (!bySubIndex) {
      bySubIndex = new Map();
      byIndex.set(anchor.index, bySubIndex);
    }
    bySubIndex.set(anchor.subIndex, row);
  }
  return byOwner;
}

function findAnchorRow(index: AnchorIndex, anchor: RenderLineAnchor | undefined): number {
  if (!anchor) return -1;
  const bySubIndex = index.get(anchor.owner)?.get(anchor.segment)?.get(anchor.index);
  if (!bySubIndex) return -1;

  const exact = bySubIndex.get(anchor.subIndex);
  if (exact !== undefined) return exact;

  let closestRow = -1;
  let closestDist = Number.POSITIVE_INFINITY;
  for (const [subIndex, row] of bySubIndex) {
    const dist = Math.abs(subIndex - anchor.subIndex);
    if (dist < closestDist || (dist === closestDist && subIndex < anchor.subIndex)) {
      closestDist = dist;
      closestRow = row;
    }
  }
  return closestRow;
}

/**
 * Map an old rendered row to the nearest surviving row after a re-render.
 *
 * Exact line anchors are preferred. If the exact line vanished (for example,
 * a tool_result line that was just hidden), walk outward to find the nearest
 * still-rendered neighbor so the viewport stays near the same content.
 */
function remapRenderedRow(oldRow: number, oldAnchors: RenderLineAnchor[], newAnchorIndex: AnchorIndex): number {
  if (oldAnchors.length === 0) return 0;
  const clamped = Math.max(0, Math.min(oldRow, oldAnchors.length - 1));
  const exact = findAnchorRow(newAnchorIndex, oldAnchors[clamped]);
  if (exact !== -1) return exact;

  for (let row = clamped + 1; row < oldAnchors.length; row++) {
    const mapped = findAnchorRow(newAnchorIndex, oldAnchors[row]);
    if (mapped !== -1) return mapped;
  }
  for (let row = clamped - 1; row >= 0; row--) {
    const mapped = findAnchorRow(newAnchorIndex, oldAnchors[row]);
    if (mapped !== -1) return mapped;
  }
  return 0;
}

export function preserveViewportAcrossResize(state: RenderState, nextCols: number, nextRows: number): void {
  const oldCols = state.cols;
  state.cols = nextCols;
  state.rows = nextRows;

  const oldMessageAreaHeight = state.layout.messageAreaHeight;
  if (oldMessageAreaHeight <= 0 || state.layout.totalLines <= 0) return;

  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const oldChatW = Math.max(1, oldCols - sidebarW);
  const newChatW = Math.max(1, nextCols - sidebarW);
  const { messageAreaHeight: newMessageAreaHeight } = computeBottomLayout(state, newChatW, nextRows);

  const oldRender = buildMessageLines(state, oldChatW);
  const newRender = buildMessageLines(state, newChatW);
  const newAnchorIndex = buildAnchorIndex(newRender.lineAnchors);

  if (state.scrollOffset > 0) {
    const oldViewStart = getViewStartFor(oldRender.lines.length, oldMessageAreaHeight, state.scrollOffset);
    const newViewStart = remapRenderedRow(oldViewStart, oldRender.lineAnchors, newAnchorIndex);
    state.scrollOffset = getScrollOffsetForViewStart(newRender.lines.length, newMessageAreaHeight, newViewStart);
  }

  state.historyCursor = {
    ...state.historyCursor,
    row: remapRenderedRow(state.historyCursor.row, oldRender.lineAnchors, newAnchorIndex),
  };
  state.historyVisualAnchor = {
    ...state.historyVisualAnchor,
    row: remapRenderedRow(state.historyVisualAnchor.row, oldRender.lineAnchors, newAnchorIndex),
  };

  state.historyLines = newRender.lines;
  state.historyWrapContinuation = newRender.wrapContinuation;
  state.historyMessageBounds = newRender.messageBounds;
  state.layout.totalLines = newRender.lines.length;
  state.layout.messageAreaHeight = newMessageAreaHeight;
}

/**
 * Apply a history mutation while preserving the user's semantic position.
 *
 * The mutation may add/remove/wrap lines (for example toggling tool output or
 * filling in previously omitted tool_result payloads). We therefore anchor the
 * viewport/cursor to rendered line identities and remap them afterward.
 */
export function preserveViewportAcrossHistoryMutation(state: RenderState, mutate: () => void): void {
  const { messageAreaHeight } = state.layout;
  if (messageAreaHeight <= 0) {
    mutate();
    return;
  }

  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const chatW = Math.max(1, state.cols - sidebarW);
  const oldRender = buildMessageLines(state, chatW);
  const oldViewStart = getViewStartFor(oldRender.lines.length, messageAreaHeight, state.scrollOffset);
  const oldCursorRow = state.historyCursor.row;
  const oldVisualAnchorRow = state.historyVisualAnchor.row;

  mutate();

  const newRender = buildMessageLines(state, chatW);
  const newAnchorIndex = buildAnchorIndex(newRender.lineAnchors);

  if (state.scrollOffset > 0) {
    const newViewStart = remapRenderedRow(oldViewStart, oldRender.lineAnchors, newAnchorIndex);
    state.scrollOffset = getScrollOffsetForViewStart(newRender.lines.length, messageAreaHeight, newViewStart);
  }

  state.historyCursor = { ...state.historyCursor, row: remapRenderedRow(oldCursorRow, oldRender.lineAnchors, newAnchorIndex) };
  state.historyVisualAnchor = { ...state.historyVisualAnchor, row: remapRenderedRow(oldVisualAnchorRow, oldRender.lineAnchors, newAnchorIndex) };

  // Prime render caches so the next frame doesn't apply the generic
  // total-line delta adjustment on top of this semantic remap.
  state.historyLines = newRender.lines;
  state.historyWrapContinuation = newRender.wrapContinuation;
  state.historyMessageBounds = newRender.messageBounds;
  state.layout.totalLines = newRender.lines.length;
}

/** Toggle tool output while preserving the user's semantic position in history. */
export function toggleToolOutputPreservingViewport(state: RenderState): void {
  preserveViewportAcrossHistoryMutation(state, () => {
    state.showToolOutput = !state.showToolOutput;
  });
}
