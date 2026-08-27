import { getViewStartFor } from "../chatscroll";
import type { RenderState } from "../state";

export function captureScrollPercentage(
  totalLines: number,
  viewportHeight: number,
  scrollOffset: number,
): number | null {
  if (totalLines <= 0 || viewportHeight <= 0) return null;
  const maxViewStart = Math.max(0, totalLines - viewportHeight);
  if (maxViewStart === 0) return 1;
  const viewStart = getViewStartFor(totalLines, viewportHeight, scrollOffset);
  return Math.max(0, Math.min(1, viewStart / maxViewStart));
}

export function scrollOffsetForPercentage(
  totalLines: number,
  viewportHeight: number,
  percentage: number,
): number {
  const maxViewStart = Math.max(0, totalLines - viewportHeight);
  const normalized = Math.max(0, Math.min(1, percentage));
  const viewStart = Math.round(maxViewStart * normalized);
  return Math.max(0, totalLines - viewportHeight - viewStart);
}

/** Capture the active conversation's viewport before navigating away. */
export function rememberCurrentConversationScroll(state: RenderState): void {
  if (!state.convId || state.folderInstructionsDoc) return;
  const percentage = captureScrollPercentage(
    state.layout.totalLines,
    state.layout.messageAreaHeight,
    state.scrollOffset,
  );
  if (percentage !== null) state.conversationScroll.positions.set(state.convId, percentage);
}

/** Leave chat history for a draft/document and cancel any in-flight placement intent. */
export function leaveConversationView(state: RenderState): void {
  rememberCurrentConversationScroll(state);
  state.conversationScroll.pendingOpen = null;
  state.conversationScroll.pendingRestore = null;
  state.conversationScroll.streamingResponse = null;
  state.conversationScroll.finalResponseViewport = null;
}

/** Capture unread before loadConversation clears it, and remember the outgoing viewport. */
export function prepareConversationOpen(state: RenderState, convId: string): void {
  if (state.convId !== convId) rememberCurrentConversationScroll(state);
  const summary = state.sidebar.conversations.find(conversation => conversation.id === convId);
  state.conversationScroll.pendingOpen = {
    convId,
    unreadAtOpen: summary?.unread === true,
  };
}

/**
 * Select the one-shot placement policy for a canonical conversation load.
 * Called before the old transcript/layout are discarded so same-conversation
 * refreshes retain their current percentage too.
 */
export function beginConversationScrollRestore(
  state: RenderState,
  convId: string,
  sameConversation: boolean,
  hasOlderHistory: boolean,
): void {
  rememberCurrentConversationScroll(state);
  const pendingOpen = state.conversationScroll.pendingOpen?.convId === convId
    ? state.conversationScroll.pendingOpen
    : null;
  const unreadAtOpen = pendingOpen?.unreadAtOpen
    ?? (!sameConversation && state.sidebar.conversations.find(conversation => conversation.id === convId)?.unread === true);
  const percentage = state.conversationScroll.positions.get(convId);

  state.conversationScroll.pendingOpen = null;
  state.conversationScroll.streamingResponse = sameConversation
    ? state.conversationScroll.streamingResponse
    : null;
  state.conversationScroll.finalResponseViewport = sameConversation
    ? state.conversationScroll.finalResponseViewport
    : null;
  state.conversationScroll.pendingRestore = unreadAtOpen
    ? {
        convId,
        mode: "unread-response",
        waitForInitialBackfill: false,
      }
    : percentage !== undefined
      ? {
          convId,
          mode: "percentage",
          percentage,
          waitForInitialBackfill: hasOlderHistory,
        }
      : null;
}

export function completeInitialConversationBackfill(state: RenderState, convId: string): void {
  const pending = state.conversationScroll.pendingRestore;
  if (pending?.convId === convId && pending.mode === "percentage") {
    pending.waitForInitialBackfill = false;
  }
}

/** Whether painting now would show the partial opening window at the wrong position. */
export function isConversationScrollRestoreWaitingForInitialBackfill(state: RenderState): boolean {
  const pending = state.conversationScroll.pendingRestore;
  return pending?.convId === state.convId
    && pending.mode === "percentage"
    && (pending.percentage ?? 1) < 1
    && pending.waitForInitialBackfill;
}

export function hasReadyConversationScrollRestore(state: RenderState): boolean {
  const pending = state.conversationScroll.pendingRestore;
  return pending?.convId === state.convId && !pending.waitForInitialBackfill;
}

export function forgetConversationScroll(state: RenderState, convId: string): void {
  state.conversationScroll.positions.delete(convId);
  if (state.conversationScroll.pendingOpen?.convId === convId) state.conversationScroll.pendingOpen = null;
  if (state.conversationScroll.pendingRestore?.convId === convId) state.conversationScroll.pendingRestore = null;
  if (state.conversationScroll.finalResponseViewport?.convId === convId) {
    state.conversationScroll.finalResponseViewport = null;
  }
}

export function pruneConversationScrollPositions(state: RenderState, validConversationIds: Iterable<string>): void {
  const valid = new Set(validConversationIds);
  for (const convId of state.conversationScroll.positions.keys()) {
    if (!valid.has(convId)) state.conversationScroll.positions.delete(convId);
  }
  const pendingOpenId = state.conversationScroll.pendingOpen?.convId;
  if (pendingOpenId && !valid.has(pendingOpenId)) state.conversationScroll.pendingOpen = null;
  const pendingRestoreId = state.conversationScroll.pendingRestore?.convId;
  if (pendingRestoreId && !valid.has(pendingRestoreId)) state.conversationScroll.pendingRestore = null;
  const responseViewportId = state.conversationScroll.finalResponseViewport?.convId;
  if (responseViewportId && !valid.has(responseViewportId)) {
    state.conversationScroll.finalResponseViewport = null;
  }
}
