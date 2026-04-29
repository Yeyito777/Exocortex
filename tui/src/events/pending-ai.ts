import type { AIMessage } from "../messages";
import type { RenderState } from "../state";
import { clonePendingAI } from "./streaming-snapshot";

export function markPendingAILive(state: RenderState): AIMessage | null {
  if (!state.pendingAI) return null;
  state.pendingAIHydratedFromSnapshot = false;
  return state.pendingAI;
}

export function hydratePendingAIFromSnapshot(
  state: RenderState,
  snapshot: Pick<AIMessage, "blocks" | "metadata">,
): void {
  state.pendingAI = clonePendingAI(snapshot);
  state.pendingAIHydratedFromSnapshot = true;
}
