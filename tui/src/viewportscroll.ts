/**
 * Shared cursor-aware viewport scrolling.
 *
 * This is the vim-style Ctrl+E/Y/D/U/F/B behavior used by chat history,
 * expressed in terms of a conventional top-based viewStart so other panes (like
 * the conversations sidebar) can use the same logic even if they store scroll
 * offsets differently.
 */

export interface CursorViewport {
  totalLines: number;
  viewportHeight: number;
  viewStart: number;
  cursorRow: number;
}

export type StreamingResponseAutoscrollMode = "following" | "anchored" | "dismissed";

/**
 * Ephemeral state for following one currently-streaming assistant text block.
 * `lastScrollOffset` lets the next render distinguish an offset that this
 * policy applied from an explicit user scroll between frames.
 */
export interface StreamingResponseAutoscrollState {
  responseId: string;
  mode: StreamingResponseAutoscrollMode;
  lastScrollOffset: number;
}

export interface StreamingResponseAutoscrollUpdate {
  state: StreamingResponseAutoscrollState | null;
  scrollOffset: number;
}

export function maxViewStartFor(totalLines: number, viewportHeight: number): number {
  return Math.max(0, totalLines - viewportHeight);
}

export function clampViewStart(totalLines: number, viewportHeight: number, viewStart: number): number {
  return Math.max(0, Math.min(viewStart, maxViewStartFor(totalLines, viewportHeight)));
}

/**
 * Keep a scrolled-up, bottom-relative viewport on the same content when its
 * document grows or shrinks. Offset zero deliberately remains zero so a
 * bottom-pinned viewport continues following new output.
 */
export function pinBottomRelativeScrollOffset(
  scrollOffset: number,
  previousTotalLines: number,
  nextTotalLines: number,
): number {
  if (scrollOffset <= 0 || previousTotalLines <= 0 || nextTotalLines === previousTotalLines) {
    return scrollOffset;
  }
  return Math.max(0, scrollOffset + nextTotalLines - previousTotalLines);
}

/**
 * Follow a newly-started final text block, then hold its first row once that
 * block becomes taller than the viewport.
 *
 * The caller supplies `scrollOffset` after ordinary bottom-relative pinning and
 * `previousScrollOffset` from before that pinning. A new response deliberately
 * starts following even if the user was elsewhere in history. Once the user
 * scrolls during this response, however, their position wins for the remainder
 * of the block.
 */
export function updateStreamingResponseAutoscroll(options: {
  state: StreamingResponseAutoscrollState | null;
  responseId: string | null;
  responseStart: number;
  responseEnd: number;
  previousScrollOffset: number;
  scrollOffset: number;
  totalLines: number;
  viewportHeight: number;
}): StreamingResponseAutoscrollUpdate {
  const {
    responseId,
    responseStart,
    responseEnd,
    previousScrollOffset,
    totalLines,
    viewportHeight,
  } = options;
  const scrollOffset = Math.max(0, options.scrollOffset);
  if (!responseId || responseStart < 0 || responseEnd <= responseStart || viewportHeight <= 0) {
    return { state: null, scrollOffset };
  }

  const isNewResponse = options.state?.responseId !== responseId;
  let state: StreamingResponseAutoscrollState = isNewResponse
    ? { responseId, mode: "following", lastScrollOffset: previousScrollOffset }
    : { ...options.state! };

  // Offset changes between rendered frames are explicit viewport navigation,
  // not document growth (which has already been applied to `scrollOffset`).
  if (!isNewResponse
    && state.mode !== "dismissed"
    && previousScrollOffset !== state.lastScrollOffset) {
    state.mode = "dismissed";
  }

  if (state.mode === "dismissed") {
    return { state, scrollOffset };
  }

  if (state.mode === "following" && responseEnd - responseStart > viewportHeight) {
    state.mode = "anchored";
  }

  const nextScrollOffset = state.mode === "following"
    ? 0
    : Math.max(0, totalLines - viewportHeight - responseStart);
  state.lastScrollOffset = nextScrollOffset;
  return { state, scrollOffset: nextScrollOffset };
}

export function ensureCursorRowVisibleInViewport(view: CursorViewport): CursorViewport {
  const viewportHeight = Math.max(0, view.viewportHeight);
  const totalLines = Math.max(0, view.totalLines);
  if (totalLines === 0 || viewportHeight <= 0 || totalLines <= viewportHeight) {
    return {
      ...view,
      totalLines,
      viewportHeight,
      viewStart: 0,
      cursorRow: Math.max(0, Math.min(view.cursorRow, Math.max(0, totalLines - 1))),
    };
  }

  const cursorRow = Math.max(0, Math.min(view.cursorRow, totalLines - 1));
  let viewStart = clampViewStart(totalLines, viewportHeight, view.viewStart);
  const viewEndExclusive = viewStart + viewportHeight;

  if (cursorRow < viewStart) {
    viewStart = cursorRow;
  } else if (cursorRow >= viewEndExclusive) {
    viewStart = cursorRow - viewportHeight + 1;
  }

  return {
    ...view,
    totalLines,
    viewportHeight,
    viewStart: clampViewStart(totalLines, viewportHeight, viewStart),
    cursorRow,
  };
}

/**
 * Ctrl+E / Ctrl+Y behavior: scroll the viewport by one row while the cursor
 * sticks to its buffer row, moving only if it would leave the visible viewport.
 * `dir`: positive = up/older, negative = down/newer.
 */
export function scrollLineWithStickyCursorInViewport(view: CursorViewport, dir: number): CursorViewport {
  const totalLines = Math.max(0, view.totalLines);
  if (totalLines === 0) return { ...view, totalLines, viewStart: 0, cursorRow: 0 };

  const viewportHeight = Math.max(0, view.viewportHeight);
  const viewStart = clampViewStart(totalLines, viewportHeight, view.viewStart - dir);
  const viewEnd = viewStart + viewportHeight - 1;
  let cursorRow = Math.max(0, Math.min(view.cursorRow, totalLines - 1));

  if (cursorRow < viewStart) cursorRow = viewStart;
  else if (cursorRow > viewEnd) cursorRow = viewEnd;
  cursorRow = Math.max(0, Math.min(cursorRow, totalLines - 1));

  return { ...view, totalLines, viewportHeight, viewStart, cursorRow };
}

/**
 * Ctrl+U / Ctrl+D behavior: scroll the viewport and move the cursor by the same
 * amount. `dir`: positive = up/older, negative = down/newer.
 */
export function scrollWithCursorInViewport(view: CursorViewport, dir: number, amount: number): CursorViewport {
  const totalLines = Math.max(0, view.totalLines);
  if (totalLines === 0) return { ...view, totalLines, viewStart: 0, cursorRow: 0 };

  const lines = dir * amount;
  const viewportHeight = Math.max(0, view.viewportHeight);
  const cursorRow = Math.max(0, Math.min(view.cursorRow - lines, totalLines - 1));
  const viewStart = clampViewStart(totalLines, viewportHeight, view.viewStart - lines);

  return ensureCursorRowVisibleInViewport({ ...view, totalLines, viewportHeight, viewStart, cursorRow });
}

/**
 * Ctrl+B / Ctrl+F behavior: scroll a page and place the cursor at the edge of
 * the new page, matching Vim's page-scroll feel. Vim uses roughly one window
 * minus two context lines.  `dir`: positive = up/older, negative = down/newer.
 *
 * Note: Exocortex viewports clamp to a full viewport of content at EOF/BOF (they
 * do not represent Vim's trailing blank rows after EOF), so EOF page placement is
 * Vim-like within that storage constraint.
 */
export function scrollPageWithCursorInViewport(view: CursorViewport, dir: number): CursorViewport {
  const totalLines = Math.max(0, view.totalLines);
  if (totalLines === 0) return { ...view, totalLines, viewStart: 0, cursorRow: 0 };

  const viewportHeight = Math.max(0, view.viewportHeight);
  if (viewportHeight <= 0 || totalLines <= viewportHeight) {
    return {
      ...view,
      totalLines,
      viewportHeight,
      viewStart: 0,
      cursorRow: Math.max(0, Math.min(view.cursorRow, totalLines - 1)),
    };
  }

  const amount = Math.max(1, viewportHeight - 2);
  const viewStart = clampViewStart(totalLines, viewportHeight, view.viewStart - dir * amount);
  const cursorRow = dir < 0
    ? viewStart
    : Math.min(totalLines - 1, viewStart + viewportHeight - 1);

  return { ...view, totalLines, viewportHeight, viewStart, cursorRow };
}
