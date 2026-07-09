// Conversations sidebar public facade + top-level orchestrator.
//
// The feature implementation lives in ./sidebar/* modules, grouped by
// responsibility. This file mirrors the previous public surface so existing
// imports can continue to use "./sidebar", while still owning the top-level
// key/action routing in the same spirit as commands.ts + commands/.

import type { KeyEvent } from "./input";
import { resolveAction } from "./keybinds";
import { bottomPinnedOrder, topUnpinnedOrder, type SidebarItemRef } from "./messages";
import {
  enterSelectedFolder,
  leaveFolder,
  moveSelectionOut,
  moveVisualSelectionWithinFolder,
  openCreateFolderPrompt,
  openMoveItemsPrompt,
  openRenameSelectedFolderPrompt,
  requestFocusAfterRecursivelyDeletingFolder,
  toggleVisualSelection,
  unwrapSelectedFolder,
} from "./sidebar/folderactions";
import { sameSidebarItem as sameItem } from "./sidebar/items";
import { moveSelection, moveToMarked, moveToStreaming } from "./sidebar/navigation";
import {
  focusSidebarItem,
  getSelectedSidebarItem,
  getSelectedVisibleConversation,
  selectedVisualItems,
} from "./sidebar/selection";
import { focusTargetAfterRemovingSidebarItems } from "./sidebar/removal";
import type { SidebarState } from "./sidebar/state";
import type { SidebarKeyResult } from "./sidebar/types";

export { activateSidebarItem } from "./sidebar/folderactions";
export { sidebarHitTest } from "./sidebar/hit";
export { SIDEBAR_WIDTH } from "./sidebar/layout";
export { handleSidebarMark } from "./sidebar/marks";
export { moveSelection } from "./sidebar/navigation";
export { handleSidebarPromptKey } from "./sidebar/promptcontroller";
export { renderSidebar } from "./sidebar/render";
export { buildDisplayRows } from "./sidebar/rows";
export {
  handleSidebarScrollAction,
  handleSidebarViewportAction,
  jumpSidebarSelectionToVisibleEdge,
  jumpSidebarSelectionToVisibleMiddle,
  scrollSidebar,
} from "./sidebar/scroll";
export {
  focusConversationAt,
  focusConversationById,
  focusPreviousEnteredConversation,
  rememberEnteredConversation,
} from "./sidebar/selection";
export { createSidebarState } from "./sidebar/state";
export type { SidebarState } from "./sidebar/state";
export type { SidebarKeyResult } from "./sidebar/types";
export { syncSelectedIndex, updateConversation, updateConversationList } from "./sidebar/updates";

type PlacementEntry = { id: string; pinned: boolean; sortOrder: number };
type PinSidebarItemMutation = { item: SidebarItemRef; pinned: boolean };

function sidebarPlacementEntries(sidebar: SidebarState, parentId: string | null): PlacementEntry[] {
  return [
    ...sidebar.folders
      .filter(folder => (folder.parentId ?? null) === parentId)
      .map(folder => ({ id: folder.id, pinned: folder.pinned, sortOrder: folder.sortOrder })),
    ...sidebar.conversations
      .filter(conv => (conv.folderId ?? null) === parentId)
      .map(conv => ({ id: conv.id, pinned: conv.pinned, sortOrder: conv.sortOrder })),
  ];
}

function optimisticSortOrderAfterPin(sidebar: SidebarState, item: SidebarItemRef, pinned: boolean): number {
  const parentId = item.type === "folder"
    ? sidebar.folders.find(folder => folder.id === item.id)?.parentId ?? null
    : sidebar.conversations.find(conv => conv.id === item.id)?.folderId ?? null;
  const entries = sidebarPlacementEntries(sidebar, parentId);
  return pinned
    ? bottomPinnedOrder(entries, item.id)
    : topUnpinnedOrder(entries, item.id);
}

function getItemPinned(sidebar: SidebarState, item: SidebarItemRef): boolean | null {
  if (item.type === "folder") return sidebar.folders.find(folder => folder.id === item.id)?.pinned ?? null;
  return sidebar.conversations.find(conv => conv.id === item.id)?.pinned ?? null;
}

function applyPinToItem(sidebar: SidebarState, item: SidebarItemRef, pinned: boolean): PinSidebarItemMutation | null {
  if (item.type === "folder") {
    const folder = sidebar.folders.find(f => f.id === item.id);
    if (!folder || folder.pinned === pinned) return null;
    folder.sortOrder = optimisticSortOrderAfterPin(sidebar, item, pinned);
    folder.pinned = pinned;
    return { item, pinned };
  }

  const conv = sidebar.conversations.find(c => c.id === item.id);
  if (!conv || conv.pinned === pinned) return null;
  conv.sortOrder = optimisticSortOrderAfterPin(sidebar, item, pinned);
  conv.pinned = pinned;
  return { item, pinned };
}

function pinSelectedVisualItems(sidebar: SidebarState, items: SidebarItemRef[]): PinSidebarItemMutation[] {
  const existingItems = items.filter(item => getItemPinned(sidebar, item) !== null);
  const allPinned = existingItems.length > 0 && existingItems.every(item => getItemPinned(sidebar, item) === true);
  const pinned = !allPinned;

  // Pinning appends to the bottom of the pinned section. Unpinning prepends to
  // the top of the unpinned section, so apply those mutations in reverse to keep
  // the selected visual block in its original top-to-bottom order.
  const applyOrder = pinned ? existingItems : [...existingItems].reverse();
  const pins: PinSidebarItemMutation[] = [];
  for (const selected of applyOrder) {
    const mutation = applyPinToItem(sidebar, selected, pinned);
    if (mutation) pins.push(mutation);
  }
  return pins;
}

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  if (key.type === "escape") {
    sidebar.visualAnchor = null;
    sidebar.pendingDeleteId = null;
    sidebar.pendingDeleteItem = null;
    return { type: "handled" };
  }
  if (key.type === "backspace") return leaveFolder(sidebar);
  if (key.type === "char" && key.char) {
    switch (key.char) {
      case "v":
      case "V":
        toggleVisualSelection(sidebar);
        return { type: "handled" };
      case "f":
        openCreateFolderPrompt(sidebar);
        return { type: "handled" };
      case "F":
        openMoveItemsPrompt(sidebar);
        return { type: "handled" };
      case "<":
        return moveSelectionOut(sidebar);
      case "h":
        return leaveFolder(sidebar);
      case "l":
        return enterSelectedFolder(sidebar);
      case "r":
        return openRenameSelectedFolderPrompt(sidebar);
      case "x":
        return unwrapSelectedFolder(sidebar);
    }
  }
  const action = resolveAction(key, "navigation");
  if (!action) return { type: "handled" };
  return handleSidebarAction(action, sidebar);
}

/** Handle a semantic action on the sidebar — used by both key handler and vim. */
export function handleSidebarAction(action: string, sidebar: SidebarState): SidebarKeyResult {
  // Any action that isn't "delete" clears the pending delete.
  if (action !== "delete") {
    sidebar.pendingDeleteId = null;
    sidebar.pendingDeleteItem = null;
  }

  switch (action) {
    case "nav_down":
    case "cursor_down":
      moveSelection(sidebar, 1);
      return { type: "handled" };

    case "nav_up":
    case "cursor_up":
      moveSelection(sidebar, -1);
      return { type: "handled" };

    case "nav_select":
    case "submit": {
      const item = getSelectedSidebarItem(sidebar);
      if (item?.type === "conversation") return { type: "select", convId: item.id };
      if (item?.type === "folder_instructions") return { type: "open_folder_instructions", folderId: item.folderId };
      if (item?.type === "folder" || item?.type === "up") return enterSelectedFolder(sidebar);
      return { type: "handled" };
    }

    case "delete": {
      const item = getSelectedSidebarItem(sidebar);
      if (!item || item.type === "up" || item.type === "folder_instructions") return { type: "handled" };
      if (sameItem(sidebar.pendingDeleteItem, item)) {
        sidebar.pendingDeleteId = null;
        sidebar.pendingDeleteItem = null;
        const selectedItems = sidebar.visualAnchor ? selectedVisualItems(sidebar) : [item];
        const selectedConvIds = selectedItems
          .filter((selected): selected is SidebarItemRef & { type: "conversation" } => selected.type === "conversation")
          .map(selected => selected.id);
        if (selectedConvIds.length > 1) {
          const deletedItems = selectedConvIds.map(id => ({ type: "conversation" as const, id }));
          const focusTarget = focusTargetAfterRemovingSidebarItems(sidebar, deletedItems);
          const selectedSet = new Set(selectedConvIds);
          sidebar.conversations = sidebar.conversations.filter(conv => !selectedSet.has(conv.id));
          sidebar.visualAnchor = null;
          focusSidebarItem(sidebar, focusTarget);
          return { type: "delete_conversations", convIds: selectedConvIds };
        }
        if (item.type === "conversation") {
          const focusTarget = focusTargetAfterRemovingSidebarItems(sidebar, [item]);
          sidebar.conversations = sidebar.conversations.filter(conv => conv.id !== item.id);
          sidebar.visualAnchor = null;
          focusSidebarItem(sidebar, focusTarget);
          return { type: "delete_conversation", convId: item.id };
        }
        sidebar.visualAnchor = null;
        requestFocusAfterRecursivelyDeletingFolder(sidebar, item);
        return { type: "delete_folder", folderId: item.id, mode: "recursive" };
      }
      sidebar.pendingDeleteItem = item;
      sidebar.pendingDeleteId = item.type === "conversation" ? item.id : null;
      return { type: "handled" };
    }

    case "undo_delete":
      return { type: "undo_delete" };

    case "redo_delete":
      return { type: "redo_delete" };

    case "unwrap_folder":
      return unwrapSelectedFolder(sidebar);

    case "clone": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      return { type: "clone_conversation", convId: conv.id };
    }

    case "mark": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      const newMarked = !conv.marked;
      conv.marked = newMarked;
      return { type: "mark_conversation", convId: conv.id, marked: newMarked };
    }

    case "pin": {
      const item = getSelectedSidebarItem(sidebar);
      if (!item || item.type === "up" || item.type === "folder_instructions") return { type: "handled" };
      if (sidebar.visualAnchor) {
        const selectedItems = selectedVisualItems(sidebar);
        if (selectedItems.length > 1) {
          const pins = pinSelectedVisualItems(sidebar, selectedItems);
          sidebar.visualAnchor = null;
          return pins.length > 0 ? { type: "pin_sidebar_items", pins } : { type: "handled" };
        }
      }
      if (item.type === "folder") {
        const pinned = getItemPinned(sidebar, item);
        if (pinned === null) return { type: "handled" };
        const newPinned = !pinned;
        applyPinToItem(sidebar, item, newPinned);
        const folder = sidebar.folders.find(f => f.id === item.id);
        if (!folder) return { type: "handled" };
        return { type: "pin_folder", folderId: folder.id, pinned: folder.pinned };
      }
      const pinned = getItemPinned(sidebar, item);
      if (pinned === null) return { type: "handled" };
      const newPinned = !pinned;
      applyPinToItem(sidebar, item, newPinned);
      const conv = sidebar.conversations.find(c => c.id === item.id);
      if (!conv) return { type: "handled" };
      return { type: "pin_conversation", convId: conv.id, pinned: newPinned };
    }

    case "move_up":
    case "move_down": {
      const direction = action === "move_up" ? "up" : "down";
      if (sidebar.visualAnchor) return moveVisualSelectionWithinFolder(sidebar, direction);
      const item = getSelectedSidebarItem(sidebar);
      if (!item || item.type === "up" || item.type === "folder_instructions") return { type: "handled" };
      return { type: "move_sidebar_item", item, direction };
    }

    case "nav_next_streaming":
      moveToStreaming(sidebar, 1);
      return { type: "handled" };

    case "nav_prev_streaming":
      moveToStreaming(sidebar, -1);
      return { type: "handled" };

    case "nav_next_marked":
      moveToMarked(sidebar, 1);
      return { type: "handled" };

    case "nav_prev_marked":
      moveToMarked(sidebar, -1);
      return { type: "handled" };

    case "focus_prompt":
      return { type: "unhandled" };

    default:
      return { type: "handled" };
  }
}
