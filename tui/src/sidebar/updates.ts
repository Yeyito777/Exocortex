import type { ConversationSummary, FolderSummary } from "../messages";
import type { SidebarItemOrderUpdate, SidebarStatePatchedEvent } from "../protocol";
import { isMovableSidebarItem, sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { compareSidebarOrder } from "./order";
import { acknowledgePatchEcho, acknowledgeReorderEcho, overlayPendingSidebarMoves } from "./pendingmoves";
import { focusTargetAfterRemovingSidebarItems } from "./removal";
import { buildDisplayRows, nearestDisplayEntry } from "./rows";
import {
  getActiveSidebarSearchQuery,
  getSearchableConversationTitle,
} from "../sidebarsearch";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";
import { isSidebarItemVisibleInTree, isTreeFolderView, sidebarItemContainer, syncTreeFolderContext } from "./tree";

function sidebarSort<T extends { pinned: boolean; sortOrder: number }>(items: T[]): T[] {
  return items.sort(compareSidebarOrder);
}

function sortSidebarCollections(sidebar: SidebarState): void {
  sidebarSort(sidebar.conversations);
  sidebarSort(sidebar.folders);
}

/** Apply an authoritative two-item order delta without replacing every summary. */
export function applySidebarItemOrderUpdates(sidebar: SidebarState, updates: SidebarItemOrderUpdate[]): void {
  // An echo of a move already shown locally must not undo presses made since.
  const unseen = acknowledgeReorderEcho(sidebar, updates);
  if (!unseen) return;
  updates = unseen;
  let changed = false;
  for (const update of updates) {
    const target = update.item.type === "conversation"
      ? sidebar.conversations.find(conversation => conversation.id === update.item.id)
      : sidebar.folders.find(folder => folder.id === update.item.id);
    if (!target || target.sortOrder === update.sortOrder) continue;
    target.sortOrder = update.sortOrder;
    changed = true;
  }
  if (!changed) return;
  overlayPendingSidebarMoves(sidebar);
  syncSelectedIndex(sidebar);
}

/** Apply authoritative structural upserts/removals without a full sidebar snapshot. */
export function applySidebarStatePatch(sidebar: SidebarState, patch: SidebarStatePatchedEvent): void {
  if (acknowledgePatchEcho(sidebar, patch)) return;
  const conversations = new Map(sidebar.conversations.map(summary => [summary.id, summary]));
  const folders = new Map(sidebar.folders.map(folder => [folder.id, folder]));
  for (const id of patch.removedConversationIds ?? []) conversations.delete(id);
  for (const id of patch.removedFolderIds ?? []) folders.delete(id);
  for (const summary of patch.conversations ?? []) conversations.set(summary.id, summary);
  for (const folder of patch.folders ?? []) folders.set(folder.id, folder);
  updateConversationList(
    sidebar,
    [...conversations.values()].sort(compareSidebarOrder),
    [...folders.values()].sort(compareSidebarOrder),
  );
}

function activeLowerQuery(sidebar: SidebarState): string | null {
  return getActiveSidebarSearchQuery(sidebar)?.toLowerCase() ?? null;
}

function conversationMatchesQuery(conv: ConversationSummary, lowerQuery: string): boolean {
  return getSearchableConversationTitle(conv).toLowerCase().includes(lowerQuery);
}

function isSidebarItemVisible(sidebar: SidebarState, item: SidebarSelectableItem): boolean {
  if (isTreeFolderView(sidebar) && !activeLowerQuery(sidebar)) return isSidebarItemVisibleInTree(sidebar, item);
  if (item.type === "up") return sidebar.currentFolderId !== null;

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

/** The tree view reveals any existing row it focuses; other views need it on screen already. */
function canFocusSidebarItem(sidebar: SidebarState, item: SidebarSelectableItem): boolean {
  if (isTreeFolderView(sidebar) && !activeLowerQuery(sidebar)) return sidebarItemContainer(sidebar, item) !== undefined;
  return isSidebarItemVisible(sidebar, item);
}

function firstVisibleSidebarItem(sidebar: SidebarState): SidebarSelectableItem | null {
  if (isTreeFolderView(sidebar) && !activeLowerQuery(sidebar)) {
    return buildDisplayRows(sidebar).find(row => row.type === "entry")?.item ?? null;
  }
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

export function selectedSidebarDisplayRow(sidebar: SidebarState): number | null {
  const selectedKey = itemKey(sidebar.selectedItem);
  if (!selectedKey) return null;
  const row = buildDisplayRows(sidebar).findIndex(displayRow => displayRow.type === "entry" && itemKey(displayRow.item ?? null) === selectedKey);
  return row === -1 ? null : row;
}

export function focusNearestSidebarDisplayEntry(sidebar: SidebarState, preferredRow: number, preferredStep: -1 | 0 | 1 = 0): boolean {
  const item = nearestDisplayEntry(buildDisplayRows(sidebar), preferredRow, preferredStep);
  if (!item) return false;
  focusSidebarItem(sidebar, item);
  return true;
}

/**
 * An authoritative list acknowledges the optimistic rows it contains. One sent
 * before the daemon processed a creation (such as the reconnect bootstrap that
 * precedes a replayed create) must not drop that row.
 */
function keepOptimisticConversations(sidebar: SidebarState, conversations: ConversationSummary[]): ConversationSummary[] {
  if (sidebar.optimisticConversationIds.size === 0) return conversations;
  for (const conv of conversations) sidebar.optimisticConversationIds.delete(conv.id);
  const pending = sidebar.conversations.filter(conv => sidebar.optimisticConversationIds.has(conv.id));
  return pending.length === 0 ? conversations : [...pending, ...conversations].sort(compareSidebarOrder);
}

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[], folders: FolderSummary[] = sidebar.folders): void {
  conversations = keepOptimisticConversations(sidebar, conversations);
  sidebar.listLoaded = true;
  const previousSelectedItem = sidebar.selectedItem;
  const previousSelectedRow = selectedSidebarDisplayRow(sidebar);
  const focusTarget = isMovableSidebarItem(previousSelectedItem)
    ? focusTargetAfterRemovingSidebarItems(sidebar, [previousSelectedItem])
    : null;
  sidebar.conversations = conversations;
  sidebar.folders = folders;
  overlayPendingSidebarMoves(sidebar);
  sidebarSort(sidebar.conversations);
  sidebarSort(sidebar.folders);
  const actionMenuItem = sidebar.actionMenu?.item;
  if (actionMenuItem && !(actionMenuItem.type === "conversation"
    ? sidebar.conversations.some(conv => conv.id === actionMenuItem.id)
    : sidebar.folders.some(folder => folder.id === actionMenuItem.id))) {
    sidebar.actionMenu = null;
  }
  if (sidebar.currentFolderId && !sidebar.folders.some(f => f.id === sidebar.currentFolderId)) {
    sidebar.currentFolderId = null;
  }
  const pendingFocusItem = sidebar.pendingFocusItem;
  if (pendingFocusItem) {
    sidebar.pendingFocusItem = null;
    if (canFocusSidebarItem(sidebar, pendingFocusItem)) {
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
  if (previousSelectedItem && !isSidebarItemVisible(sidebar, previousSelectedItem) && previousSelectedRow !== null) {
    if (focusTarget && isSidebarItemVisible(sidebar, focusTarget)) {
      focusSidebarItem(sidebar, focusTarget);
      return;
    }
    if (focusNearestSidebarDisplayEntry(sidebar, previousSelectedRow - 1, -1)) return;
  }
  syncSelectedIndex(sidebar);
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary | null | undefined): void {
  if (!summary) return;
  sidebar.optimisticConversationIds.delete(summary.id);
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    sidebar.conversations.unshift(summary);
  }
  overlayPendingSidebarMoves(sidebar);
  sortSidebarCollections(sidebar);
  const pendingFocusItem = sidebar.pendingFocusItem;
  if (pendingFocusItem?.type === "conversation" && pendingFocusItem.id === summary.id) {
    sidebar.pendingFocusItem = null;
    sidebar.currentFolderId = summary.folderId ?? null;
    focusSidebarItem(sidebar, pendingFocusItem);
    return;
  }
  syncSelectedIndex(sidebar);
}

/** Resolve selected item after list changes. */
export function syncSelectedIndex(sidebar: SidebarState): void {
  resolveSelectedItem(sidebar);
  // A move can refile the selected row without refocusing it.
  syncTreeFolderContext(sidebar);
}

function resolveSelectedItem(sidebar: SidebarState): void {
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
  // A restored conversation can load before the list (no /ssh round trip
  // between them); keep the saved cursor for the list to resolve.
  if (!sidebar.listLoaded) return;
  focusSidebarItem(sidebar, firstVisibleSidebarItem(sidebar));
}
