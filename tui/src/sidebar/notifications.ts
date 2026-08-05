/** Settling policy for unread/completion notifications in the sidebar. */

import type { ConversationSummary } from "../messages";
import type { SidebarState } from "./state";

/**
 * Match /ping's completion debounce. A queued turn normally starts immediately
 * after the previous turn stops, so this keeps the intermediate streaming=false
 * summary from flashing a finished notification for one or two frames.
 */
export const STREAM_COMPLETION_SETTLE_MS = 200;

type NotificationConversation = Pick<ConversationSummary, "id" | "streaming" | "unread">;
type NotificationSidebar = Pick<SidebarState, "conversations" | "folderNotificationBufferUntil">;

/** Reconcile one canonical summary with the sidebar's transient settle buffer. */
export function reconcileFolderNotificationBuffer(
  sidebar: NotificationSidebar,
  summary: NotificationConversation,
  wasStreaming: boolean,
  now = Date.now(),
): void {
  if (summary.streaming || !summary.unread) {
    delete sidebar.folderNotificationBufferUntil[summary.id];
    return;
  }

  if (wasStreaming) {
    sidebar.folderNotificationBufferUntil[summary.id] = now + STREAM_COMPLETION_SETTLE_MS;
  }
}

/** Remove settle entries that can no longer affect an authoritative list. */
export function pruneFolderNotificationBuffers(sidebar: NotificationSidebar): void {
  const conversationsById = new Map(sidebar.conversations.map(conversation => [conversation.id, conversation]));
  for (const convId of Object.keys(sidebar.folderNotificationBufferUntil)) {
    const conversation = conversationsById.get(convId);
    if (!conversation || conversation.streaming || !conversation.unread) {
      delete sidebar.folderNotificationBufferUntil[convId];
    }
  }
}

export function clearFolderNotificationBuffer(sidebar: NotificationSidebar, convId: string): void {
  delete sidebar.folderNotificationBufferUntil[convId];
}

/** True only when unread output is idle and has survived the settle window. */
export function isSettledUnreadConversation(
  sidebar: NotificationSidebar,
  conversation: NotificationConversation,
  now = Date.now(),
): boolean {
  if (!conversation.unread || conversation.streaming) return false;
  return (sidebar.folderNotificationBufferUntil[conversation.id] ?? 0) <= now;
}

/** Delay until the next buffered notification becomes renderable, if any. */
export function msUntilNextFolderNotification(
  sidebar: NotificationSidebar,
  now = Date.now(),
): number | null {
  let nextDelay: number | null = null;
  for (const conversation of sidebar.conversations) {
    if (!conversation.unread || conversation.streaming) continue;
    const bufferUntil = sidebar.folderNotificationBufferUntil[conversation.id];
    if (bufferUntil === undefined) continue;
    const delay = bufferUntil - now;
    if (delay <= 0) continue;
    if (nextDelay === null || delay < nextDelay) nextDelay = delay;
  }
  return nextDelay;
}
