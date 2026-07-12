/**
 * Shared chat viewport helpers.
 */

import { buildMessageLines, type RenderLineAnchor, type RenderLineSegment } from "./conversation";
import { computeBottomLayout } from "./chatlayout";
import { SIDEBAR_WIDTH } from "./sidebar";
import type { RenderState } from "./state";
import { isVisuallyBlankLine } from "./terminaltext";

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
type RenderedLineIndex = Map<string, number[]>;

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

function buildRenderedLineIndex(lines: string[]): RenderedLineIndex {
  const index: RenderedLineIndex = new Map();
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (isVisuallyBlankLine(line)) continue;
    const rows = index.get(line);
    if (rows) rows.push(row);
    else index.set(line, [row]);
  }
  return index;
}

/**
 * Match a rendered row by its visible content when a canonical history rebuild
 * replaced all message/block objects and therefore invalidated owner anchors.
 * Nearby rows disambiguate repeated lines; the closest position is only a
 * tiebreaker so insertions before the viewport can still be followed.
 */
function findRenderedLineRow(
  oldRow: number,
  oldLines: string[],
  newLines: string[],
  newLineIndex: RenderedLineIndex,
): number {
  if (oldLines.length === 0 || newLines.length === 0) return -1;
  const clamped = Math.max(0, Math.min(oldRow, oldLines.length - 1));

  for (let distance = 0; distance < oldLines.length; distance++) {
    const sourceRows = distance === 0
      ? [clamped]
      : [clamped + distance, clamped - distance];

    for (const sourceRow of sourceRows) {
      if (sourceRow < 0 || sourceRow >= oldLines.length) continue;
      const sourceLine = oldLines[sourceRow];
      if (isVisuallyBlankLine(sourceLine)) continue;
      const candidates = newLineIndex.get(sourceLine);
      if (!candidates) continue;

      let bestRow = -1;
      let bestContextScore = -1;
      let bestPositionDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        let contextScore = 0;
        for (let delta = -4; delta <= 4; delta++) {
          const oldContextRow = sourceRow + delta;
          const newContextRow = candidate + delta;
          if (oldContextRow < 0 || oldContextRow >= oldLines.length) continue;
          if (newContextRow < 0 || newContextRow >= newLines.length) continue;
          if (oldLines[oldContextRow] === newLines[newContextRow]) contextScore++;
        }
        const positionDistance = Math.abs(candidate - sourceRow);
        if (contextScore > bestContextScore
          || (contextScore === bestContextScore && positionDistance < bestPositionDistance)) {
          bestRow = candidate;
          bestContextScore = contextScore;
          bestPositionDistance = positionDistance;
        }
      }

      if (bestRow !== -1) {
        const mapped = bestRow - (sourceRow - clamped);
        return Math.max(0, Math.min(mapped, newLines.length - 1));
      }
    }
  }
  return -1;
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
function remapRenderedRow(
  oldRow: number,
  oldLines: string[],
  oldAnchors: RenderLineAnchor[],
  newLines: string[],
  newAnchorIndex: AnchorIndex,
  newLineIndex: RenderedLineIndex,
): number {
  if (oldAnchors.length === 0) return Math.max(0, Math.min(oldRow, newLines.length - 1));
  const clamped = Math.max(0, Math.min(oldRow, oldAnchors.length - 1));
  const exact = findAnchorRow(newAnchorIndex, oldAnchors[clamped]);
  if (exact !== -1) return exact;

  const contentMatch = findRenderedLineRow(clamped, oldLines, newLines, newLineIndex);
  if (contentMatch !== -1) return contentMatch;

  for (let row = clamped + 1; row < oldAnchors.length; row++) {
    const mapped = findAnchorRow(newAnchorIndex, oldAnchors[row]);
    if (mapped !== -1) return mapped;
  }
  for (let row = clamped - 1; row >= 0; row--) {
    const mapped = findAnchorRow(newAnchorIndex, oldAnchors[row]);
    if (mapped !== -1) return mapped;
  }
  return Math.max(0, Math.min(clamped, newLines.length - 1));
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
  const newLineIndex = buildRenderedLineIndex(newRender.lines);

  if (state.scrollOffset > 0) {
    const oldViewStart = getViewStartFor(oldRender.lines.length, oldMessageAreaHeight, state.scrollOffset);
    const newViewStart = remapRenderedRow(
      oldViewStart,
      oldRender.lines,
      oldRender.lineAnchors,
      newRender.lines,
      newAnchorIndex,
      newLineIndex,
    );
    state.scrollOffset = getScrollOffsetForViewStart(newRender.lines.length, newMessageAreaHeight, newViewStart);
  }

  state.historyCursor = {
    ...state.historyCursor,
    row: remapRenderedRow(state.historyCursor.row, oldRender.lines, oldRender.lineAnchors, newRender.lines, newAnchorIndex, newLineIndex),
  };
  state.historyVisualAnchor = {
    ...state.historyVisualAnchor,
    row: remapRenderedRow(state.historyVisualAnchor.row, oldRender.lines, oldRender.lineAnchors, newRender.lines, newAnchorIndex, newLineIndex),
  };

  state.historyLines = newRender.lines;
  state.historyWrapContinuation = newRender.wrapContinuation;
  state.historyWrapJoiners = newRender.wrapJoiners;
  state.historyCopyLines = newRender.copyLines;
  state.historyMessageBounds = newRender.messageBounds;
  state.historyLineAnchors = newRender.lineAnchors;
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
  const newLineIndex = buildRenderedLineIndex(newRender.lines);

  if (state.scrollOffset > 0) {
    const newViewStart = remapRenderedRow(
      oldViewStart,
      oldRender.lines,
      oldRender.lineAnchors,
      newRender.lines,
      newAnchorIndex,
      newLineIndex,
    );
    state.scrollOffset = getScrollOffsetForViewStart(newRender.lines.length, messageAreaHeight, newViewStart);
  }

  state.historyCursor = {
    ...state.historyCursor,
    row: remapRenderedRow(oldCursorRow, oldRender.lines, oldRender.lineAnchors, newRender.lines, newAnchorIndex, newLineIndex),
  };
  state.historyVisualAnchor = {
    ...state.historyVisualAnchor,
    row: remapRenderedRow(oldVisualAnchorRow, oldRender.lines, oldRender.lineAnchors, newRender.lines, newAnchorIndex, newLineIndex),
  };

  // Prime render caches so the next frame doesn't apply the generic
  // total-line delta adjustment on top of this semantic remap.
  state.historyLines = newRender.lines;
  state.historyWrapContinuation = newRender.wrapContinuation;
  state.historyWrapJoiners = newRender.wrapJoiners;
  state.historyCopyLines = newRender.copyLines;
  state.historyMessageBounds = newRender.messageBounds;
  state.historyLineAnchors = newRender.lineAnchors;
  state.layout.totalLines = newRender.lines.length;
}

/** Toggle tool output while preserving the user's semantic position in history. */
export function toggleToolOutputPreservingViewport(state: RenderState): void {
  preserveViewportAcrossHistoryMutation(state, () => {
    state.showToolOutput = !state.showToolOutput;
  });
}
