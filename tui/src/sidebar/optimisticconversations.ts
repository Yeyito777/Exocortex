import { topUnpinnedOrder, type ConversationSummary, type EffortLevel, type FastMode, type ModelId, type ProviderId } from "../messages";
import { focusTargetAfterRemovingSidebarItems } from "./removal";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";
import { syncSelectedIndex } from "./updates";

export interface OptimisticConversation {
  convId: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: FastMode;
  folderId: string | null;
  title: string;
}

/** Mirror the daemon, which places new conversations here. */
function topUnpinnedOrderInFolder(sidebar: SidebarState, folderId: string | null): number {
  return topUnpinnedOrder([
    ...sidebar.conversations.filter(conv => (conv.folderId ?? null) === folderId),
    ...sidebar.folders.filter(folder => (folder.parentId ?? null) === folderId),
  ]);
}

/**
 * Show a conversation the daemon was just asked to create. Over SSH creation is
 * a network round trip; the row stays until the daemon's summary replaces it
 * or the creation fails, surviving authoritative lists that predate it.
 */
export function addOptimisticConversation(sidebar: SidebarState, conversation: OptimisticConversation): void {
  if (sidebar.conversations.some(conv => conv.id === conversation.convId)) return;
  // The daemon files a conversation for an unknown folder at the root.
  const folderId = conversation.folderId && sidebar.folders.some(folder => folder.id === conversation.folderId)
    ? conversation.folderId
    : null;
  const now = Date.now();
  const summary: ConversationSummary = {
    id: conversation.convId,
    provider: conversation.provider,
    model: conversation.model,
    effort: conversation.effort,
    fastMode: conversation.fastMode,
    createdAt: now,
    updatedAt: now,
    messageCount: 1,
    title: conversation.title,
    goal: null,
    marked: false,
    pinned: false,
    muted: false,
    streaming: true,
    unread: false,
    sortOrder: topUnpinnedOrderInFolder(sidebar, folderId),
    folderId,
  };
  sidebar.optimisticConversationIds.add(summary.id);
  sidebar.conversations.unshift(summary);
  syncSelectedIndex(sidebar);
}

export function isOptimisticConversation(sidebar: SidebarState, convId: string): boolean {
  return sidebar.optimisticConversationIds.has(convId);
}

/** The daemon created it. Returns whether the row was still optimistic. */
export function acknowledgeOptimisticConversation(sidebar: SidebarState, convId: string): boolean {
  return sidebar.optimisticConversationIds.delete(convId);
}

/** The daemon rejected the creation. Returns whether there was a row to remove. */
export function removeOptimisticConversation(sidebar: SidebarState, convId: string): boolean {
  if (!sidebar.optimisticConversationIds.delete(convId)) return false;
  const idx = sidebar.conversations.findIndex(conv => conv.id === convId);
  if (idx === -1) return true;
  const item = { type: "conversation" as const, id: convId };
  const selected = sidebar.selectedItem?.type === "conversation" && sidebar.selectedItem.id === convId;
  const focusTarget = selected ? focusTargetAfterRemovingSidebarItems(sidebar, [item]) : null;
  sidebar.conversations.splice(idx, 1);
  if (selected) focusSidebarItem(sidebar, focusTarget);
  else syncSelectedIndex(sidebar);
  return true;
}
