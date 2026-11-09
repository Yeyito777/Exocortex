import { getViewStartFor } from "../chatscroll";
import type { RenderLineAnchor } from "../conversation";
import { isActiveConversationLoading, type RenderState } from "../state";
import type { ConversationScrollAnchor } from "./types";

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

/** The first content row of each loaded prompt, by its index among all prompts. */
function promptRows(state: RenderState, lineAnchors: RenderLineAnchor[]): Map<number, number> {
  const userIndexes = new Map<object, number>();
  let userIndex = state.historyStartUserIndex;
  for (const message of state.messages) {
    if (message.role === "user") userIndexes.set(message, userIndex++);
  }
  const rows = new Map<number, number>();
  lineAnchors.forEach((anchor, row) => {
    if (anchor?.segment !== "user_content") return;
    const index = userIndexes.get(anchor.owner);
    if (index !== undefined && !rows.has(index)) rows.set(index, row);
  });
  return rows;
}

/** The top row as an offset from the nearest prompt above it (or the first below). */
function captureScrollAnchor(state: RenderState): ConversationScrollAnchor | null {
  const { totalLines, messageAreaHeight } = state.layout;
  if (state.historyLineAnchors.length !== totalLines) return null;
  const viewStart = getViewStartFor(totalLines, messageAreaHeight, state.scrollOffset);
  let chosen: { userIndex: number; row: number } | null = null;
  for (const [userIndex, row] of promptRows(state, state.historyLineAnchors)) {
    if (row > viewStart && chosen) break;
    chosen = { userIndex, row };
    if (row > viewStart) break;
  }
  return chosen ? { userIndex: chosen.userIndex, rowOffset: viewStart - chosen.row } : null;
}

/** The view start that shows an anchor in these rows, or null when its prompt isn't loaded. */
export function viewStartForScrollAnchor(
  state: RenderState,
  lineAnchors: RenderLineAnchor[],
  anchor: ConversationScrollAnchor,
): number | null {
  const row = promptRows(state, lineAnchors).get(anchor.userIndex);
  return row === undefined ? null : row + anchor.rowOffset;
}

/** Capture the active conversation's viewport before navigating away. */
export function rememberCurrentConversationScroll(state: RenderState): void {
  // A loading placeholder's layout says nothing about where the reader was,
  // nor does a window still waiting to be put back where they left it.
  if (!state.convId || isActiveConversationLoading(state)) return;
  if (state.conversationScroll.pendingRestore?.convId === state.convId) return;
  const percentage = captureScrollPercentage(
    state.layout.totalLines,
    state.layout.messageAreaHeight,
    state.scrollOffset,
  );
  if (percentage === null) return;
  const anchor = percentage < 1 ? captureScrollAnchor(state) : null;
  state.conversationScroll.positions.set(state.convId, anchor ?? percentage);
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
  const position = state.conversationScroll.positions.get(convId);

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
    : typeof position === "object"
      ? {
          convId,
          mode: "anchor",
          anchor: position,
          waitForInitialBackfill: hasOlderHistory,
        }
      : position !== undefined
        ? {
            convId,
            mode: "percentage",
            percentage: position,
            waitForInitialBackfill: hasOlderHistory && position < 1,
          }
        : null;
}

/**
 * Prompts older than the loaded window that a waiting anchor needs, or 0.
 * The window's first loaded prompt is `historyStartUserIndex`.
 */
export function conversationScrollRestoreMissingTurns(state: RenderState): number {
  const pending = state.conversationScroll.pendingRestore;
  if (pending?.convId !== state.convId || pending.mode !== "anchor" || !pending.anchor) return 0;
  if (!state.historyHasOlder || (state.historyStartIndex <= 0 && state.historyStartBlockIndex <= 0)) return 0;
  return Math.max(0, state.historyStartUserIndex - pending.anchor.userIndex);
}

/**
 * A history page (or a failure to get one) arrived. A percentage is placed in
 * the expanded window; an anchor keeps waiting while its prompt is older than
 * the window, unless `force` (a failed or empty page) says no more will come.
 */
export function completeInitialConversationBackfill(state: RenderState, convId: string, force = false): void {
  const pending = state.conversationScroll.pendingRestore;
  if (pending?.convId !== convId || pending.mode === "unread-response") return;
  if (!force && conversationScrollRestoreMissingTurns(state) > 0) return;
  pending.waitForInitialBackfill = false;
}

/** Whether painting now would show the partial opening window at the wrong position. */
export function isConversationScrollRestoreWaitingForInitialBackfill(state: RenderState): boolean {
  const pending = state.conversationScroll.pendingRestore;
  return pending?.convId === state.convId
    && (pending.mode === "anchor" || (pending.mode === "percentage" && (pending.percentage ?? 1) < 1))
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
