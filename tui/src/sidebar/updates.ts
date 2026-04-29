import type { ConversationSummary, FolderSummary } from "../messages";
import { sameSidebarItem as sameItem } from "./items";
import { compareSidebarOrder } from "./order";
import { buildDisplayRows } from "./rows";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";

function sidebarSort<T extends { pinned: boolean; sortOrder: number }>(items: T[]): T[] {
  return items.sort(compareSidebarOrder);
}

function sortSidebarCollections(sidebar: SidebarState): void {
  sidebarSort(sidebar.conversations);
  sidebarSort(sidebar.folders);
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
    if (buildDisplayRows(sidebar).some(row => row.type === "entry" && sameItem(row.item ?? null, pendingFocusItem))) {
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
      if (buildDisplayRows(sidebar).some(row => row.type === "entry" && sameItem(row.item ?? null, item))) return;
    }
  }
  if (item?.type === "folder" && sidebar.folders.some(f => f.id === item.id)
      && buildDisplayRows(sidebar).some(row => row.type === "entry" && sameItem(row.item ?? null, item))) {
    sidebar.selectedId = null;
    return;
  }
  const first = buildDisplayRows(sidebar).find(row => row.type === "entry");
  focusSidebarItem(sidebar, first?.item ?? null);
}
