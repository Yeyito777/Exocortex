import type { SidebarItemRef } from "../messages";
import { getActiveSidebarSearchQuery } from "../sidebarsearch";
import { currentFolder, descendantFolderIds, parentOfCurrentFolder } from "./folders";
import { isMovableSidebarItem, sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { compareSidebarOrder } from "./order";
import { updateMovePromptAutocomplete } from "./moveautocomplete";
import { applyPendingSidebarItemReorder, applyPendingSidebarItemsMove } from "./optimisticmove";
import { focusTargetAfterRemovingSidebarItems } from "./removal";
import { buildDisplayRows, type DisplayRow } from "./rows";
import {
  focusFolderById,
  focusSidebarItem,
  getSelectedSidebarItem,
  selectedVisualItems,
} from "./selection";
import type { SidebarState } from "./state";
import { isFolderOpenInTree, isTreeFolderView, revealFolderInTree, sidebarItemContainer } from "./tree";
import type { SidebarKeyResult } from "./types";
import { syncSelectedIndex } from "./updates";

export function requestFocusAfterMovingItemsOutOfView(sidebar: SidebarState, items: SidebarItemRef[]): void {
  sidebar.pendingFocusItem = focusTargetAfterRemovingSidebarItems(sidebar, items);
}

function firstFolderChildItem(sidebar: SidebarState, folderId: string): SidebarItemRef | null {
  const entries = [
    ...sidebar.folders
      .filter(folder => (folder.parentId ?? null) === folderId)
      .map(folder => ({ pinned: folder.pinned, sortOrder: folder.sortOrder, item: { type: "folder" as const, id: folder.id } })),
    ...sidebar.conversations
      .filter(conv => (conv.folderId ?? null) === folderId)
      .map(conv => ({ pinned: conv.pinned, sortOrder: conv.sortOrder, item: { type: "conversation" as const, id: conv.id } })),
  ].sort(compareSidebarOrder);
  return entries[0]?.item ?? null;
}

export function requestFocusAfterRecursivelyDeletingFolder(sidebar: SidebarState, item: SidebarItemRef & { type: "folder" }): void {
  // Do not move the cursor optimistically while the folder row is still present.
  // The daemon will recursively delete the folder tree and broadcast the final
  // sidebar in a moment; selecting only after that authoritative update avoids a
  // visible one-frame cursor jump.
  sidebar.pendingFocusItem = focusTargetAfterRemovingSidebarItems(sidebar, [item]);
}

export function requestFocusAfterUnwrappingFolder(sidebar: SidebarState, item: SidebarItemRef & { type: "folder" }): void {
  // Prefer the first unwrapped child after the server update. If the folder is
  // empty, fall back to the next nearby row after removing the folder shell.
  const child = firstFolderChildItem(sidebar, item.id);
  const next = focusTargetAfterRemovingSidebarItems(sidebar, [item]);
  const target = child ?? next;
  sidebar.pendingFocusItem = target;
}

function sidebarItemParent(sidebar: SidebarState, item: SidebarItemRef): string | null | undefined {
  if (item.type === "conversation") return sidebar.conversations.find(c => c.id === item.id)?.folderId ?? null;
  return sidebar.folders.find(f => f.id === item.id)?.parentId ?? null;
}

function sidebarItemPinned(sidebar: SidebarState, item: SidebarItemRef): boolean | undefined {
  if (item.type === "conversation") return sidebar.conversations.find(c => c.id === item.id)?.pinned;
  return sidebar.folders.find(f => f.id === item.id)?.pinned;
}

export function moveVisualSelectionWithinFolder(sidebar: SidebarState, direction: "up" | "down"): SidebarKeyResult {
  // Reordering a visual block only makes sense in an unfiltered folder view.
  if (getActiveSidebarSearchQuery(sidebar)) return { type: "handled" };

  const items = outermostSelectedItems(sidebar, selectedVisualItems(sidebar));
  if (items.length === 0) return { type: "handled" };
  if (items.length === 1) {
    const reqId = applyPendingSidebarItemReorder(sidebar, items[0]!, direction);
    return reqId ? { type: "move_sidebar_item", item: items[0]!, direction, reqId } : { type: "handled" };
  }

  const parentId = sidebarItemParent(sidebar, items[0]);
  const pinned = sidebarItemPinned(sidebar, items[0]);
  if (parentId === undefined || pinned === undefined) return { type: "handled" };
  if (!items.every(item => sidebarItemParent(sidebar, item) === parentId && sidebarItemPinned(sidebar, item) === pinned)) {
    return { type: "handled" };
  }

  // Reorder among siblings; the tree view also lists expanded folders' contents.
  const entries = buildDisplayRows(sidebar).filter((row): row is DisplayRow & { type: "entry"; item: SidebarItemRef } =>
    row.type === "entry" && !!row.item && isMovableSidebarItem(row.item) && sidebarItemParent(sidebar, row.item) === parentId);
  const selectedKeys = new Set(items.map(itemKey));
  const selectedIndices = entries
    .map((row, index) => selectedKeys.has(itemKey(row.item)) ? index : -1)
    .filter(index => index !== -1);
  if (selectedIndices.length !== items.length) return { type: "handled" };

  const firstIndex = Math.min(...selectedIndices);
  const lastIndex = Math.max(...selectedIndices);

  const targetIndex = direction === "up" ? firstIndex - 1 : lastIndex + 1;
  const target = entries[targetIndex]?.item;
  if (!target) return { type: "handled" };
  if (sidebarItemParent(sidebar, target) !== parentId || sidebarItemPinned(sidebar, target) !== pinned) {
    return { type: "handled" };
  }

  if (direction === "up") {
    const options = { preservePinned: true };
    const reqId = applyPendingSidebarItemsMove(sidebar, items, parentId, target, options);
    return reqId ? { type: "move_sidebar_items", items, parentId, before: target, ...options, reqId } : { type: "handled" };
  }

  const afterTarget = entries[targetIndex + 1]?.item;
  const before = afterTarget
    && sidebarItemParent(sidebar, afterTarget) === parentId
    && sidebarItemPinned(sidebar, afterTarget) === pinned
    ? afterTarget
    : undefined;
  const options = { preservePinned: true, placement: before ? undefined : "bottom" as const };
  const reqId = applyPendingSidebarItemsMove(sidebar, items, parentId, before, options);
  return reqId ? { type: "move_sidebar_items", items, parentId, before, ...options, reqId } : { type: "handled" };
}

export function toggleVisualSelection(sidebar: SidebarState): void {
  const item = getSelectedSidebarItem(sidebar);
  if (!item || !isMovableSidebarItem(item)) return;
  sidebar.visualAnchor = sidebar.visualAnchor ? null : item;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
}

/**
 * A tree-view visual block can span a folder and rows inside it. Those rows
 * move with their folder, so only act on the outermost selected items.
 */
function outermostSelectedItems(sidebar: SidebarState, items: SidebarItemRef[]): SidebarItemRef[] {
  if (!isTreeFolderView(sidebar)) return items;
  const nestedFolderIds = new Set<string>();
  for (const item of items) {
    if (item.type !== "folder") continue;
    for (const id of descendantFolderIds(sidebar, item.id)) {
      if (id !== item.id) nestedFolderIds.add(id);
    }
  }
  const selectedFolderIds = new Set(items.filter(item => item.type === "folder").map(item => item.id));
  return items.filter(item => {
    if (item.type === "folder") return !nestedFolderIds.has(item.id);
    const folderId = sidebar.conversations.find(conv => conv.id === item.id)?.folderId ?? null;
    return !folderId || (!selectedFolderIds.has(folderId) && !nestedFolderIds.has(folderId));
  });
}

export function openCreateFolderPrompt(sidebar: SidebarState): void {
  const items = sidebar.visualAnchor ? outermostSelectedItems(sidebar, selectedVisualItems(sidebar)) : [];
  sidebar.prompt = { purpose: "create_folder", input: "", cursorPos: 0, items };
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
}

export function openMoveItemsPrompt(sidebar: SidebarState): void {
  const items = outermostSelectedItems(sidebar, selectedVisualItems(sidebar));
  if (items.length === 0) return;
  sidebar.prompt = { purpose: "move_items", input: "", cursorPos: 0, items, autocomplete: null };
  updateMovePromptAutocomplete(sidebar);
}

export function openRenameSelectedFolderPrompt(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type !== "folder") return { type: "handled" };
  const folder = sidebar.folders.find(f => f.id === item.id);
  if (!folder) return { type: "handled" };
  sidebar.prompt = { purpose: "rename_folder", input: "", cursorPos: 0, items: [], folderId: folder.id };
  return { type: "handled" };
}

export function unwrapSelectedFolder(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type !== "folder") return { type: "handled" };
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
  requestFocusAfterUnwrappingFolder(sidebar, item);
  return { type: "delete_folder", folderId: item.id, mode: "unwrap" };
}

function resetFolderViewTransientState(sidebar: SidebarState): void {
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
}

/**
 * A folder found by search opens where it lives: clear the filter and expand
 * the folder along with every folder above it.
 */
function openSearchResultFolderInTree(sidebar: SidebarState, folderId: string): boolean {
  if (!getActiveSidebarSearchQuery(sidebar) || !sidebar.search) return false;
  sidebar.search.highlightsVisible = false;
  revealFolderInTree(sidebar, folderId);
  resetFolderViewTransientState(sidebar);
  focusSidebarItem(sidebar, { type: "folder", id: folderId });
  return true;
}

/** Tree view `l`: expand the folder, or step into it when it is already expanded. */
function expandSelectedTreeFolder(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type !== "folder" || openSearchResultFolderInTree(sidebar, item.id)) return { type: "handled" };
  resetFolderViewTransientState(sidebar);
  if (!sidebar.expandedFolderIds.has(item.id)) {
    sidebar.expandedFolderIds.add(item.id);
    return { type: "handled" };
  }
  const rows = buildDisplayRows(sidebar);
  const folderRow = rows.findIndex(row => row.type === "entry" && row.item?.type === "folder" && row.item.id === item.id);
  const child = rows.slice(folderRow + 1).find(row => row.type === "entry");
  if (folderRow !== -1 && child?.item && (child.depth ?? 0) > (rows[folderRow].depth ?? 0)) focusSidebarItem(sidebar, child.item);
  return { type: "handled" };
}

/** Tree view Enter/click: expand a collapsed folder or collapse an expanded one. */
export function toggleSelectedTreeFolder(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type !== "folder" || openSearchResultFolderInTree(sidebar, item.id)) return { type: "handled" };
  resetFolderViewTransientState(sidebar);
  if (!sidebar.expandedFolderIds.delete(item.id)) sidebar.expandedFolderIds.add(item.id);
  return { type: "handled" };
}

/** Tree view `h`: collapse an expanded folder, otherwise collapse the folder listing the cursor. */
function collapseTreeFolder(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type === "folder" && sidebar.expandedFolderIds.has(item.id)) {
    resetFolderViewTransientState(sidebar);
    sidebar.expandedFolderIds.delete(item.id);
    return { type: "handled" };
  }
  const container = item ? sidebarItemContainer(sidebar, item) : sidebar.currentFolderId;
  if (!container) return { type: "handled" };
  resetFolderViewTransientState(sidebar);
  sidebar.expandedFolderIds.delete(container);
  focusFolderById(sidebar, container);
  return { type: "handled" };
}

export function enterSelectedFolder(sidebar: SidebarState): SidebarKeyResult {
  if (isTreeFolderView(sidebar)) return expandSelectedTreeFolder(sidebar);
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type === "folder") {
    sidebar.currentFolderId = item.id;
    if (sidebar.search) sidebar.search.highlightsVisible = false;
    sidebar.scrollOffset = 0;
    sidebar.visualAnchor = null;
    syncSelectedIndex(sidebar);
  } else if (item?.type === "up") {
    return leaveFolder(sidebar);
  }
  return { type: "handled" };
}

export function activateSidebarItem(sidebar: SidebarState, item: SidebarSelectableItem): SidebarKeyResult {
  focusSidebarItem(sidebar, item);
  if (item.type === "conversation") return { type: "select", convId: item.id };
  if (item.type === "folder_instructions") return { type: "open_folder_instructions", folderId: item.folderId };
  return isTreeFolderView(sidebar) ? toggleSelectedTreeFolder(sidebar) : enterSelectedFolder(sidebar);
}

export function leaveFolder(sidebar: SidebarState): SidebarKeyResult {
  if (isTreeFolderView(sidebar)) return collapseTreeFolder(sidebar);
  if (!sidebar.currentFolderId) return { type: "handled" };
  const leaving = sidebar.currentFolderId;
  sidebar.currentFolderId = parentOfCurrentFolder(sidebar);
  sidebar.scrollOffset = 0;
  sidebar.visualAnchor = null;
  focusFolderById(sidebar, leaving);
  return { type: "handled" };
}

export function currentFolderRef(sidebar: SidebarState): SidebarItemRef | undefined {
  return sidebar.currentFolderId ? { type: "folder", id: sidebar.currentFolderId } : undefined;
}

export function topLevelCurrentFolderRef(sidebar: SidebarState): SidebarItemRef | undefined {
  let folder = currentFolder(sidebar);
  if (!folder) return undefined;
  const seen = new Set<string>();
  while (folder.parentId && !seen.has(folder.id)) {
    seen.add(folder.id);
    const parent = sidebar.folders.find(f => f.id === folder?.parentId);
    if (!parent) break;
    folder = parent;
  }
  return { type: "folder", id: folder.id };
}

export function moveSelectionOut(sidebar: SidebarState): SidebarKeyResult {
  if (!sidebar.currentFolderId) return { type: "handled" };
  const items = outermostSelectedItems(sidebar, selectedVisualItems(sidebar));
  const before = currentFolderRef(sidebar);
  if (items.length === 0 || !before) return { type: "handled" };
  sidebar.visualAnchor = null;
  // In the parent folder, place the moved items immediately above the folder
  // they came from so "move out" preserves local context instead of dumping
  // them at the top of the conversation list.
  const parentId = parentOfCurrentFolder(sidebar);
  const leavesView = isTreeFolderView(sidebar) ? !isFolderOpenInTree(sidebar, parentId) : true;
  const focus = leavesView ? focusTargetAfterRemovingSidebarItems(sidebar, items) : undefined;
  const reqId = applyPendingSidebarItemsMove(sidebar, items, parentId, before, {}, focus);
  return reqId ? { type: "move_sidebar_items", items, parentId, before, reqId } : { type: "handled" };
}
