import { createPendingAI } from "./messages";
import type { RenderState } from "./state";

export interface CompactConversationActions {
  compactConversation(convId: string, startedAt: number): void;
}

/** Mark the TUI busy immediately, then ask the daemon for one standalone compaction. */
export function startManualCompaction(
  state: RenderState,
  daemon: CompactConversationActions,
  startedAt = Date.now(),
): boolean {
  if (!state.convId || state.pendingAI) return false;

  state.scrollOffset = 0;
  state.pendingAI = createPendingAI(startedAt, state.model);
  state.pendingAIHydratedFromSnapshot = false;
  state.pendingAICommittedIndex = null;
  state.suppressPendingAIMetadataStartedAt = null;
  state.contextCompactionStartedAt = startedAt;
  daemon.compactConversation(state.convId, startedAt);
  return true;
}
