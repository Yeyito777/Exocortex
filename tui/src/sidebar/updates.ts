import type { ConversationSummary, FolderSummary } from "../messages";
import { type SidebarSelectableItem } from "./items";
import { compareSidebarOrder } from "./order";
import {
  getActiveSidebarSearchQuery,
  getSearchableConversationTitle,
} from "../sidebarsearch";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";

function sidebarSort<T extends { pinned: boolean; sortOrder: number }>(items: T[]): T[] {
  return items.sort(compareSidebarOrder);
}

function sortSidebarCollections(sidebar: SidebarState): void {
  sidebarSort(sidebar.conversations);
  sidebarSort(sidebar.folders);
}

function activeLowerQuery(sidebar: SidebarState): string | null {
  return getActiveSidebarSearchQuery(sidebar)?.toLowerCase() ?? null;
}

function conversationMatchesQuery(conv: ConversationSummary, lowerQuery: string): boolean {
  return getSearchableConversationTitle(conv).toLowerCase().includes(lowerQuery);
}

function isSidebarItemVisible(sidebar: SidebarState, item: SidebarSelectableItem): boolean {
  if (item.type === "up") return sidebar.currentFolderId !== null;
  if (item.type === "folder_instructions") return item.folderId === sidebar.currentFolderId;

  const lowerQuery = activeLowerQuery(sidebar);
  if (item.type === "folder") {
    const folder = sidebar.folders.find(f => f.id === item.id);
    return Boolean(folder)
      && (lowerQuery
        ? folder!.name.toLowerCase().includes(lowerQuery)
        : (folder!.parentId ?? null) === sidebar.currentFolderId);
  }

  const conv = sidebar.conversations.find(c => c.id === item.id);
  if (!conv) return false;
  if (!lowerQuery) return (conv.folderId ?? null) === sidebar.currentFolderId;
  return conversationMatchesQuery(conv, lowerQuery);
}

function firstVisibleSidebarItem(sidebar: SidebarState): SidebarSelectableItem | null {
  if (sidebar.currentFolderId) return { type: "up" };

  const lowerQuery = activeLowerQuery(sidebar);
  let bestPinned = false;
  let bestSortOrder = 0;
  let bestItem: SidebarSelectableItem | null = null;
  const consider = (pinned: boolean, sortOrder: number, item: SidebarSelectableItem) => {
    if (!bestItem || compareSidebarOrder({ pinned, sortOrder }, { pinned: bestPinned, sortOrder: bestSortOrder }) < 0) {
      bestPinned = pinned;
      bestSortOrder = sortOrder;
      bestItem = item;
    }
  };

  for (const folder of sidebar.folders) {
    if (!lowerQuery && (folder.parentId ?? null) !== sidebar.currentFolderId) continue;
    if (lowerQuery && !folder.name.toLowerCase().includes(lowerQuery)) continue;
    consider(folder.pinned, folder.sortOrder, { type: "folder", id: folder.id });
  }

  for (const conv of sidebar.conversations) {
    if (!lowerQuery && (conv.folderId ?? null) !== sidebar.currentFolderId) continue;
    if (lowerQuery && !conversationMatchesQuery(conv, lowerQuery)) continue;
    consider(conv.pinned, conv.sortOrder, { type: "conversation", id: conv.id });
  }

  return bestItem;
}

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[], folders: FolderSummary[] = sidebar.folders): void {
  sidebar.conversations = conversations;
  sidebar.folders = folders;
  if (sidebar.currentFolderId && !sidebar.folders.some(f => f.id === sidebar.currentFolderId)) {
    sidebar.currentFolderId = null;
  }
  const pendingFocusItem = sidebar.pendingFocusItem;
  if (pendingFocusItem) {
    sidebar.pendingFocusItem = null;
    if (isSidebarItemVisible(sidebar, pendingFocusItem)) {
      focusSidebarItem(sidebar, pendingFocusItem);
      return;
    }
  }

  const pendingFocus = sidebar.pendingFocusFolder;
  if (pendingFocus) {
    const matchingFolder = sidebar.folders
      .filter(folder => folder.name === pendingFocus.name && (folder.parentId ?? null) === pendingFocus.parentId)
      .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt)[0];
    sidebar.pendingFocusFolder = null;
    if (matchingFolder) {
      focusSidebarItem(sidebar, { type: "folder", id: matchingFolder.id });
      return;
    }
  }
  syncSelectedIndex(sidebar);
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary | null | undefined): void {
  if (!summary) return;
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    sidebar.conversations.unshift(summary);
  }
  sortSidebarCollections(sidebar);
  syncSelectedIndex(sidebar);
}

/** Resolve selected item after list changes. */
export function syncSelectedIndex(sidebar: SidebarState): void {
  sortSidebarCollections(sidebar);
  const item = sidebar.selectedItem;
  if (item?.type === "conversation") {
    const idx = sidebar.conversations.findIndex(c => c.id === item.id);
    if (idx !== -1) {
      sidebar.selectedIndex = idx;
      sidebar.selectedId = item.id;
      if (isSidebarItemVisible(sidebar, item)) return;
    }
  }
  if (item?.type === "folder" && sidebar.folders.some(f => f.id === item.id)
      && isSidebarItemVisible(sidebar, item)) {
    sidebar.selectedId = null;
    return;
  }
  if (item?.type === "folder_instructions" && item.folderId === sidebar.currentFolderId
      && isSidebarItemVisible(sidebar, item)) {
    sidebar.selectedId = null;
    return;
  }
  focusSidebarItem(sidebar, firstVisibleSidebarItem(sidebar));
}
