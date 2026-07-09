import type { ConversationSummary, SidebarItemRef } from "../messages";
import { isMovableSidebarItem, sidebarItemKey as itemKey, sameSidebarItem as sameItem, type SidebarSelectableItem } from "./items";
import { buildDisplayRows, type DisplayRow } from "./rows";
import type { SidebarState } from "./state";
import {
  getActiveSidebarSearchQuery,
  getVisibleConversationIndicesForQuery,
} from "../sidebarsearch";

export function focusSidebarItem(sidebar: SidebarState, item: SidebarSelectableItem | null): void {
  sidebar.selectedItem = item;
  if (item?.type === "conversation") {
    const idx = sidebar.conversations.findIndex(c => c.id === item.id);
    sidebar.selectedIndex = idx === -1 ? 0 : idx;
    sidebar.selectedId = idx === -1 ? null : item.id;
  } else {
    sidebar.selectedId = null;
    sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, sidebar.conversations.length - 1)));
  }
}

export function focusConversationAt(sidebar: SidebarState, index: number): void {
  if (sidebar.conversations.length === 0) {
    focusSidebarItem(sidebar, null);
    sidebar.selectedIndex = 0;
    return;
  }
  const nextIndex = Math.max(0, Math.min(index, sidebar.conversations.length - 1));
  const conv = sidebar.conversations[nextIndex];
  focusSidebarItem(sidebar, { type: "conversation", id: conv.id });
}

export function focusConversationById(sidebar: SidebarState, convId: string): boolean {
  const idx = sidebar.conversations.findIndex(c => c.id === convId);
  if (idx === -1) return false;
  focusConversationAt(sidebar, idx);
  sidebar.currentFolderId = sidebar.conversations[idx].folderId ?? null;
  return true;
}

export function focusFolderById(sidebar: SidebarState, folderId: string): boolean {
  if (!sidebar.folders.some(f => f.id === folderId)) return false;
  focusSidebarItem(sidebar, { type: "folder", id: folderId });
  return true;
}

/** Remember the last conversation the user actually entered/loaded. */
export function rememberEnteredConversation(
  sidebar: SidebarState,
  currentConvId: string | null,
  nextConvId: string | null,
): void {
  if (currentConvId && currentConvId !== nextConvId) {
    sidebar.previousEnteredId = currentConvId;
  }
}

export function focusPreviousEnteredConversation(sidebar: SidebarState): boolean {
  if (!sidebar.previousEnteredId) return false;
  return focusConversationById(sidebar, sidebar.previousEnteredId);
}

export function selectedDisplayRow(displayRows: DisplayRow[], sidebar: SidebarState): number {
  if (!sidebar.selectedItem) {
    const legacyConv = sidebar.selectedId
      ? sidebar.conversations.find(c => c.id === sidebar.selectedId)
      : sidebar.conversations[sidebar.selectedIndex];
    if (legacyConv) focusSidebarItem(sidebar, { type: "conversation", id: legacyConv.id });
  }
  const selectedKey = itemKey(sidebar.selectedItem);
  const row = displayRows.findIndex((dr) => dr.type === "entry" && itemKey(dr.item ?? null) === selectedKey);
  if (row !== -1) return row;
  const firstEntry = displayRows.findIndex((dr) => dr.type === "entry");
  return firstEntry === -1 ? 0 : firstEntry;
}

export function getSelectedSidebarItem(sidebar: SidebarState): SidebarSelectableItem | null {
  const selected = sidebar.selectedItem;
  if (!selected) return null;
  if (selected.type === "up") return selected;
  if (selected.type === "conversation") {
    const convIdx = sidebar.conversations.findIndex(c => c.id === selected.id);
    const conv = sidebar.conversations[convIdx];
    if (!conv) return null;
    if ((conv.folderId ?? null) === sidebar.currentFolderId) return selected;
    const activeQuery = getActiveSidebarSearchQuery(sidebar);
    return activeQuery && getVisibleConversationIndicesForQuery(sidebar, activeQuery).includes(convIdx) ? selected : null;
  }
  if (selected.type === "folder_instructions") {
    return selected.folderId === sidebar.currentFolderId ? selected : null;
  }
  const folder = sidebar.folders.find(f => f.id === selected.id);
  return folder && (folder.parentId ?? null) === sidebar.currentFolderId ? selected : null;
}

export function getSelectedVisibleConversation(sidebar: SidebarState): ConversationSummary | null {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type !== "conversation") return null;
  return sidebar.conversations.find(c => c.id === item.id) ?? null;
}

export function selectedVisualItems(sidebar: SidebarState): SidebarItemRef[] {
  const current = getSelectedSidebarItem(sidebar);
  if (!current || !isMovableSidebarItem(current)) return [];
  if (!sidebar.visualAnchor) return [current];
  const rows = buildDisplayRows(sidebar).filter((row) => row.type === "entry" && row.item && isMovableSidebarItem(row.item));
  const anchorIdx = rows.findIndex(row => sameItem(row.item ?? null, sidebar.visualAnchor));
  const currentIdx = rows.findIndex(row => sameItem(row.item ?? null, current));
  if (anchorIdx === -1 || currentIdx === -1) return [current];
  const start = Math.min(anchorIdx, currentIdx);
  const end = Math.max(anchorIdx, currentIdx);
  return rows.slice(start, end + 1).map(row => row.item as SidebarItemRef);
}
