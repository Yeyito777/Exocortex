/**
 * Shared chat viewport helpers.
 */

import type { RenderState } from "./state";

/**
 * First historyLines index visible in the message area.
 *
 * scrollOffset === 0 means "pinned to bottom" (auto-scroll), so we
 * snap to the tail of the buffer. Any positive offset scrolls up.
 * Always clamped to ≥ 0 so callers never get a negative index.
 */
export function getViewStart(state: RenderState): number {
  const { totalLines, messageAreaHeight } = state.layout;
  if (state.scrollOffset === 0) return Math.max(0, totalLines - messageAreaHeight);
  return Math.max(0, totalLines - messageAreaHeight - state.scrollOffset);
}
