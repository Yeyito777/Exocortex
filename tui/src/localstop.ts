/**
 * What Ctrl+Q shows at once, before the daemon answers: the reply freezes
 * where it is, the interrupt notice appears and the sidebar's dot goes off.
 */

import { preserveViewportAcrossTurnEnd } from "./chatscroll";
import { handleStreamingStopped } from "./events/streaming";
import { clearPendingAI, clearStreamingTailMessages, markStoppedLocally, pushSystemMessage, type RenderState } from "./state";
import { theme } from "./theme";

function pendingAIHasVisibleContent(state: RenderState): boolean {
  return state.pendingAI?.blocks.some((block) => {
    if (block.type === "text" || block.type === "thinking") return block.text.trim().length > 0;
    return true;
  }) ?? false;
}

export function showStoppedLocally(state: RenderState, convId: string, startedAt: number | null): void {
  const pending = state.pendingAI;
  if (pending) {
    // As the daemon does: a tool call cut off before its result isn't kept.
    const answered = new Set(pending.blocks.flatMap(block => block.type === "tool_result" ? [block.toolCallId] : []));
    pending.blocks = pending.blocks.filter(block => block.type !== "tool_call" || answered.has(block.toolCallId));
  }
  if (pendingAIHasVisibleContent(state)) {
    preserveViewportAcrossTurnEnd(state, () => handleStreamingStopped({ type: "streaming_stopped", convId }, state));
  } else {
    // Nothing shown yet (still connecting): no empty reply is left behind.
    clearPendingAI(state);
    clearStreamingTailMessages(state);
  }
  // Stopped first, so the notice goes straight into the history (not the live
  // tail): it is the same row the daemon's copy shows after a reload.
  markStoppedLocally(state, convId, startedAt);
  pushSystemMessage(state, "✗ Interrupted", theme.error);
}
