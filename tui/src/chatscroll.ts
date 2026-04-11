/**
 * Shared chat viewport helpers.
 */

import { buildMessageLines, type RenderLineAnchor, type RenderLineSegment } from "./conversation";
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

type AnchorIndex = WeakMap<object, Map<RenderLineSegment, Map<number, number>>>;

function buildAnchorIndex(anchors: RenderLineAnchor[]): AnchorIndex {
  const byOwner = new WeakMap<object, Map<RenderLineSegment, Map<number, number>>>();
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
    byIndex.set(anchor.index, row);
  }
  return byOwner;
}

function findAnchorRow(index: AnchorIndex, anchor: RenderLineAnchor | undefined): number {
  if (!anchor) return -1;
  return index.get(anchor.owner)?.get(anchor.segment)?.get(anchor.index) ?? -1;
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

/**
 * Toggle tool output while preserving the user's semantic position in history.
 *
 * When tool_result blocks appear/disappear, absolute row numbers are no longer
 * stable. We therefore anchor the viewport/cursor to rendered line identities
 * and remap them into the newly rendered conversation.
 */
export function toggleToolOutputPreservingViewport(state: RenderState): void {
  const { messageAreaHeight } = state.layout;
  if (messageAreaHeight <= 0) {
    state.showToolOutput = !state.showToolOutput;
    return;
  }

  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  const chatW = Math.max(1, state.cols - sidebarW);
  const oldRender = buildMessageLines(state, chatW);
  const oldViewStart = getViewStartFor(oldRender.lines.length, messageAreaHeight, state.scrollOffset);
  const oldCursorRow = state.historyCursor.row;
  const oldVisualAnchorRow = state.historyVisualAnchor.row;

  state.showToolOutput = !state.showToolOutput;

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
