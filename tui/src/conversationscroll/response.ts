import type { StreamingResponseAutoscrollState } from "./types";

export interface StreamingResponseAutoscrollUpdate {
  state: StreamingResponseAutoscrollState | null;
  scrollOffset: number;
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
  /** Visual response height after viewport-only reflow, when it differs. */
  responseHeight?: number;
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

  const responseHeight = options.responseHeight ?? responseEnd - responseStart;
  if (state.mode === "following" && responseHeight > viewportHeight) {
    state.mode = "anchored";
  }

  const nextScrollOffset = state.mode === "following"
    ? 0
    : Math.max(0, totalLines - viewportHeight - responseStart);
  state.lastScrollOffset = nextScrollOffset;
  return { state, scrollOffset: nextScrollOffset };
}
