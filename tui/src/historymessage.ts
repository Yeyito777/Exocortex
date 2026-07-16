/**
 * Shared helpers for resolving semantic row ranges inside rendered messages.
 */

import type { RenderState } from "./state";
import { stripAnsi } from "./historymotions";

export interface HistoryRowRange {
  startRow: number;
  endRow: number;
}

export function trimRowsToContent(
  state: RenderState,
  startRow: number,
  endRow: number,
): HistoryRowRange | null {
  const lines = state.historyLines;
  let start = startRow;
  let end = endRow;
  while (start < end && stripAnsi(lines[start]).trim() === "") start++;
  while (end > start && stripAnsi(lines[end - 1]).trim() === "") end--;
  return start < end ? { startRow: start, endRow: end } : null;
}

/**
 * Find the final rendered text block in an assistant message, excluding its
 * thinking, tool-call, and tool-result blocks.
 */
export function findFinalAssistantTextRows(
  state: RenderState,
  startRow: number,
  endRow: number,
): HistoryRowRange | null {
  const anchors = state.historyLineAnchors ?? [];
  let currentOwner: object | null = null;
  let currentStart = -1;
  let currentEnd = -1;
  let finalStart = -1;
  let finalEnd = -1;

  const finishCurrent = () => {
    if (currentStart >= 0 && currentEnd > currentStart) {
      finalStart = currentStart;
      finalEnd = currentEnd;
    }
    currentOwner = null;
    currentStart = -1;
    currentEnd = -1;
  };

  for (let row = startRow; row < endRow; row++) {
    const anchor = anchors[row];
    const owner = anchor?.owner as ({ type?: string } & object) | undefined;
    const isTextBlock = anchor?.segment === "assistant_block" && owner?.type === "text";
    if (!isTextBlock || !owner) {
      finishCurrent();
      continue;
    }

    if (currentOwner !== owner) {
      finishCurrent();
      currentOwner = owner;
      currentStart = row;
    }
    currentEnd = row + 1;
  }
  finishCurrent();

  if (finalStart >= 0 && finalEnd > finalStart) {
    return trimRowsToContent(state, finalStart, finalEnd);
  }
  return null;
}
