import type { RenderState } from "./state";
import { createPendingAI } from "./messages";

export interface ReplayConversationActions {
  replayConversation(convId: string, startedAt: number): void;
}

/**
 * Start a replay from the TUI's point of view before waiting for the daemon.
 *
 * Normal sends optimistically create pendingAI in handleSubmit so the user sees
 * live assistant metadata immediately. Replays do not append a new user message,
 * but they should still create the assistant placeholder locally and then let the
 * daemon's streaming_started event reconcile the canonical metadata/snapshot.
 */
export function startReplayConversation(
  state: RenderState,
  daemon: ReplayConversationActions,
  startedAt = Date.now(),
): boolean {
  if (!state.convId || state.pendingAI) return false;

  state.scrollOffset = 0;
  state.pendingAI = createPendingAI(startedAt, state.model);
  state.pendingAIHydratedFromSnapshot = false;
  state.pendingAICommittedIndex = null;
  state.suppressPendingAIMetadataStartedAt = null;
  daemon.replayConversation(state.convId, startedAt);
  return true;
}
