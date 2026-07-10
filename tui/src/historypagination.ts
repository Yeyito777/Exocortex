import { getViewStart } from "./chatscroll";
import type { RenderState } from "./state";

export const INITIAL_BUFFER_ADDITIONAL_TURNS = 10;
export const OLDER_HISTORY_PAGE_TURNS = 15;

export interface OlderHistoryRequest {
  convId: string;
  beforeEntryIndex: number;
  turns: number;
}

export function beginOlderHistoryLoad(state: RenderState, turns: number): OlderHistoryRequest | null {
  if (!state.convId || !state.historyHasOlder || state.historyLoadingOlder || state.historyStartIndex <= 0) return null;
  state.historyLoadingOlder = true;
  state.historyLoadingStartedAt = Date.now();
  return {
    convId: state.convId,
    beforeEntryIndex: state.historyStartIndex,
    turns,
  };
}

/** Load before the viewport reaches the oldest rendered row. */
export function shouldLoadOlderHistory(state: RenderState): boolean {
  if (!state.convId || !state.historyHasOlder || state.historyLoadingOlder || state.historyStartIndex <= 0) return false;
  if (state.layout.messageAreaHeight <= 0 || state.layout.totalLines <= 0) return false;
  const thresholdRows = Math.max(3, Math.ceil(state.layout.messageAreaHeight / 2));
  return getViewStart(state) <= thresholdRows;
}
