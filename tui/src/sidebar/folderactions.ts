import type { SidebarItemRef } from "../messages";
import { getActiveSidebarSearchQuery } from "../sidebarsearch";
import { currentFolder, parentOfCurrentFolder } from "./folders";
import { isMovableSidebarItem, sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { compareSidebarOrder } from "./order";
import { updateMovePromptAutocomplete } from "./moveautocomplete";
import { buildDisplayRows, type DisplayRow } from "./rows";
import {
  focusFolderById,
  focusSidebarItem,
  getSelectedSidebarItem,
  selectedVisualItems,
} from "./selection";
import type { SidebarState } from "./state";
import type { SidebarKeyResult } from "./types";
import { syncSelectedIndex } from "./updates";

function nextItemAfterRemovingItems(sidebar: SidebarState, items: SidebarItemRef[]): SidebarItemRef | { type: "up" } | null {
  const removedKeys = new Set(items.map(item => itemKey(item)));
  const rowsBefore = buildDisplayRows(sidebar).filter((row): row is DisplayRow & { type: "entry"; item: SidebarItemRef | { type: "up" } } => row.type === "entry" && !!row.item && row.item.type !== "folder_instructions");
  const removedIndices = rowsBefore
    .map((row, index) => removedKeys.has(itemKey(row.item)) ? index : -1)
    .filter(index => index !== -1);
  const rowsAfter = rowsBefore.filter(row => !removedKeys.has(itemKey(row.item)));
  if (rowsAfter.length === 0) return null;
  const removedIndex = removedIndices.length === 0 ? 0 : Math.min(...removedIndices);
  const nextIndex = Math.min(removedIndex, rowsAfter.length - 1);
  return rowsAfter[nextIndex]?.item ?? null;
}

function nextItemAfterRemovingItem(sidebar: SidebarState, item: SidebarItemRef): SidebarItemRef | { type: "up" } | null {
  return nextItemAfterRemovingItems(sidebar, [item]);
}

export function requestFocusAfterMovingItemsOutOfView(sidebar: SidebarState, items: SidebarItemRef[]): void {
  const next = nextItemAfterRemovingItems(sidebar, items);
  sidebar.pendingFocusItem = next?.type === "up" ? null : next;
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
  const next = nextItemAfterRemovingItem(sidebar, item);
  sidebar.pendingFocusItem = next?.type === "up" ? null : next;
}

export function requestFocusAfterUnwrappingFolder(sidebar: SidebarState, item: SidebarItemRef & { type: "folder" }): void {
  // Prefer the first unwrapped child after the server update. If the folder is
  // empty, fall back to the next nearby row after removing the folder shell.
  const child = firstFolderChildItem(sidebar, item.id);
  const next = nextItemAfterRemovingItem(sidebar, item);
  const target = child ?? (next?.type === "up" ? null : next);
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

  const items = selectedVisualItems(sidebar);
  if (items.length === 0) return { type: "handled" };
  if (items.length === 1) return { type: "move_sidebar_item", item: items[0], direction };

  const entries = buildDisplayRows(sidebar).filter((row): row is DisplayRow & { type: "entry"; item: SidebarItemRef } => row.type === "entry" && !!row.item && isMovableSidebarItem(row.item));
  const selectedKeys = new Set(items.map(itemKey));
  const selectedIndices = entries
    .map((row, index) => selectedKeys.has(itemKey(row.item)) ? index : -1)
    .filter(index => index !== -1);
  if (selectedIndices.length !== items.length) return { type: "handled" };

  const firstIndex = Math.min(...selectedIndices);
  const lastIndex = Math.max(...selectedIndices);
  const parentId = sidebarItemParent(sidebar, items[0]);
  const pinned = sidebarItemPinned(sidebar, items[0]);
  if (parentId === undefined || pinned === undefined) return { type: "handled" };
  if (!items.every(item => sidebarItemParent(sidebar, item) === parentId && sidebarItemPinned(sidebar, item) === pinned)) {
    return { type: "handled" };
  }

  const targetIndex = direction === "up" ? firstIndex - 1 : lastIndex + 1;
  const target = entries[targetIndex]?.item;
  if (!target) return { type: "handled" };
  if (sidebarItemParent(sidebar, target) !== parentId || sidebarItemPinned(sidebar, target) !== pinned) {
    return { type: "handled" };
  }

  if (direction === "up") {
    return { type: "move_sidebar_items", items, parentId, before: target, preservePinned: true };
  }

  const afterTarget = entries[targetIndex + 1]?.item;
  const before = afterTarget
    && sidebarItemParent(sidebar, afterTarget) === parentId
    && sidebarItemPinned(sidebar, afterTarget) === pinned
    ? afterTarget
    : undefined;
  return { type: "move_sidebar_items", items, parentId, before, preservePinned: true, placement: before ? undefined : "bottom" };
}

export function toggleVisualSelection(sidebar: SidebarState): void {
  const item = getSelectedSidebarItem(sidebar);
  if (!item || !isMovableSidebarItem(item)) return;
  sidebar.visualAnchor = sidebar.visualAnchor ? null : item;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
}

export function openCreateFolderPrompt(sidebar: SidebarState): void {
  sidebar.prompt = { purpose: "create_folder", input: "", cursorPos: 0, items: sidebar.visualAnchor ? selectedVisualItems(sidebar) : [] };
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
}

export function openMoveItemsPrompt(sidebar: SidebarState): void {
  const items = selectedVisualItems(sidebar);
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

export function enterSelectedFolder(sidebar: SidebarState): SidebarKeyResult {
  const item = getSelectedSidebarItem(sidebar);
  if (item?.type === "folder") {
    sidebar.currentFolderId = item.id;
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
  return enterSelectedFolder(sidebar);
}

export function leaveFolder(sidebar: SidebarState): SidebarKeyResult {
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
  const items = selectedVisualItems(sidebar);
  const before = currentFolderRef(sidebar);
  if (items.length === 0 || !before) return { type: "handled" };
  sidebar.visualAnchor = null;
  // In the parent folder, place the moved items immediately above the folder
  // they came from so "move out" preserves local context instead of dumping
  // them at the top of the conversation list.
  return { type: "move_sidebar_items", items, parentId: parentOfCurrentFolder(sidebar), before };
}
