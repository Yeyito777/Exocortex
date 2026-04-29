// Conversations sidebar public facade + top-level orchestrator.
//
// The feature implementation lives in ./sidebar/* modules, grouped by
// responsibility. This file mirrors the previous public surface so existing
// imports can continue to use "./sidebar", while still owning the top-level
// key/action routing in the same spirit as commands.ts + commands/.

import type { KeyEvent } from "./input";
import { resolveAction } from "./keybinds";
import type { SidebarItemRef } from "./messages";
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
  focusNearestVisibleConversation,
  getSelectedSidebarItem,
  getSelectedVisibleConversation,
  selectedVisualItems,
} from "./sidebar/selection";
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

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  if (key.type === "escape" || key.type === "ctrl-c") {
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
      if (item?.type === "folder" || item?.type === "up") return enterSelectedFolder(sidebar);
      return { type: "handled" };
    }

    case "delete": {
      const item = getSelectedSidebarItem(sidebar);
      if (!item || item.type === "up") return { type: "handled" };
      if (sameItem(sidebar.pendingDeleteItem, item)) {
        sidebar.pendingDeleteId = null;
        sidebar.pendingDeleteItem = null;
        const selectedItems = sidebar.visualAnchor ? selectedVisualItems(sidebar) : [item];
        const selectedConvIds = selectedItems
          .filter((selected): selected is SidebarItemRef & { type: "conversation" } => selected.type === "conversation")
          .map(selected => selected.id);
        if (selectedConvIds.length > 1) {
          const selectedSet = new Set(selectedConvIds);
          sidebar.conversations = sidebar.conversations.filter(conv => !selectedSet.has(conv.id));
          sidebar.visualAnchor = null;
          focusNearestVisibleConversation(sidebar, sidebar.selectedIndex);
          return { type: "delete_conversations", convIds: selectedConvIds };
        }
        if (item.type === "conversation") {
          const deletedIndex = sidebar.selectedIndex;
          sidebar.conversations.splice(deletedIndex, 1);
          sidebar.visualAnchor = null;
          focusNearestVisibleConversation(sidebar, deletedIndex);
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
      if (!item || item.type === "up") return { type: "handled" };
      if (item.type === "folder") {
        const folder = sidebar.folders.find(f => f.id === item.id);
        if (!folder) return { type: "handled" };
        folder.pinned = !folder.pinned;
        return { type: "pin_folder", folderId: folder.id, pinned: folder.pinned };
      }
      const conv = sidebar.conversations.find(c => c.id === item.id);
      if (!conv) return { type: "handled" };
      const newPinned = !conv.pinned;
      conv.pinned = newPinned;
      return { type: "pin_conversation", convId: conv.id, pinned: newPinned };
    }

    case "move_up":
    case "move_down": {
      const direction = action === "move_up" ? "up" : "down";
      if (sidebar.visualAnchor) return moveVisualSelectionWithinFolder(sidebar, direction);
      const item = getSelectedSidebarItem(sidebar);
      if (!item || item.type === "up") return { type: "handled" };
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
