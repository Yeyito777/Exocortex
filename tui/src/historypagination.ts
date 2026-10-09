import { getViewStart } from "./chatscroll";
import type { Message } from "./messages";
import type { RenderState } from "./state";

export const INITIAL_BUFFER_ADDITIONAL_TURNS = 10;
export const OLDER_HISTORY_PAGE_TURNS = 15;

export interface OlderHistoryRequest {
  convId: string;
  beforeEntryIndex: number;
  beforeBlockIndex: number;
  turns: number;
}

/** Whether the loaded window's start cursor has anything before it. */
export function hasOlderHistoryCursor(state: RenderState): boolean {
  return state.historyHasOlder && (state.historyStartIndex > 0 || state.historyStartBlockIndex > 0);
}

export function beginOlderHistoryLoad(state: RenderState, turns: number): OlderHistoryRequest | null {
  if (!state.convId || state.historyLoadingOlder || !hasOlderHistoryCursor(state)) return null;
  state.historyLoadingOlder = true;
  state.historyLoadingStartedAt = Date.now();
  return {
    convId: state.convId,
    beforeEntryIndex: state.historyStartIndex,
    beforeBlockIndex: state.historyStartBlockIndex,
    turns,
  };
}

/** Load before the viewport reaches the oldest rendered row. */
export function shouldLoadOlderHistory(state: RenderState): boolean {
  if (!state.convId || state.historyLoadingOlder || !hasOlderHistoryCursor(state)) return false;
  if (state.pendingHistoryNavigation) return true;
  if (state.layout.messageAreaHeight <= 0 || state.layout.totalLines <= 0) return false;
  const thresholdRows = Math.max(3, Math.ceil(state.layout.messageAreaHeight / 2));
  return getViewStart(state) <= thresholdRows;
}

/**
 * A history window may begin inside a long AI entry. When the leading blocks of
 * that entry arrive (as the last message of `older`), join them onto the loaded
 * tail (the first message of `newer`) so every display entry stays one message.
 */
export function joinSplitAssistantEntry(older: Message[], newer: Message[]): void {
  const head = older.at(-1);
  const tail = newer[0];
  if (head?.role !== "assistant" || tail?.role !== "assistant") return;
  older.pop();
  newer[0] = { ...tail, blocks: [...head.blocks, ...tail.blocks] };
}
