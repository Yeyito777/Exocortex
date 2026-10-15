/**
 * Tree folder view for the conversations sidebar.
 *
 * In the default "navigate" view, opening a folder replaces the list with that
 * folder's contents. In the "tree" view folders expand in place instead, and the
 * folder context (`currentFolderId`, where `f`, `F` and `<` act) follows the
 * cursor: it is always the folder that lists the selected row.
 */

import type { ConversationSummary, FolderSummary } from "../messages";
import type { SidebarSelectableItem } from "./items";

export type SidebarFolderView = "navigate" | "tree";
export type NewConversationPlacement = "selected" | "top_level";

export interface SidebarTreeState {
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  folderView?: SidebarFolderView;
  expandedFolderIds?: Set<string>;
}

type SidebarTreeContextState = SidebarTreeState & {
  currentFolderId?: string | null;
  selectedItem?: SidebarSelectableItem | null;
};

export function isTreeFolderView(state: { folderView?: SidebarFolderView }): boolean {
  return state.folderView === "tree";
}

/** The folder an item is listed in, or undefined when the item no longer exists. */
export function sidebarItemContainer(state: SidebarTreeState, item: SidebarSelectableItem): string | null | undefined {
  switch (item.type) {
    case "conversation": {
      const conversation = state.conversations.find(candidate => candidate.id === item.id);
      return conversation ? conversation.folderId ?? null : undefined;
    }
    case "folder": {
      const folder = state.folders.find(candidate => candidate.id === item.id);
      return folder ? folder.parentId ?? null : undefined;
    }
    case "folder_instructions":
      return state.folders.some(folder => folder.id === item.folderId) ? item.folderId : undefined;
    case "up":
      return undefined;
  }
}

/** Whether a folder's contents are on screen: it and every ancestor are expanded. */
export function isFolderOpenInTree(state: SidebarTreeState, folderId: string | null): boolean {
  const seen = new Set<string>();
  let currentId = folderId;
  while (currentId) {
    if (seen.has(currentId) || !state.expandedFolderIds?.has(currentId)) return false;
    seen.add(currentId);
    const folder = state.folders.find(candidate => candidate.id === currentId);
    if (!folder) return false;
    currentId = folder.parentId ?? null;
  }
  return true;
}

export function isSidebarItemVisibleInTree(state: SidebarTreeState, item: SidebarSelectableItem): boolean {
  const container = sidebarItemContainer(state, item);
  return container !== undefined && isFolderOpenInTree(state, container);
}

/** Expand a folder and all of its ancestors so its contents are on screen. */
export function revealFolderInTree(state: SidebarTreeState, folderId: string | null): void {
  const expanded = state.expandedFolderIds;
  if (!expanded) return;
  const seen = new Set<string>();
  let currentId = folderId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    expanded.add(currentId);
    currentId = state.folders.find(candidate => candidate.id === currentId)?.parentId ?? null;
  }
}

/** Keep the tree view's folder context on the folder that lists the selected row. */
export function syncTreeFolderContext(state: SidebarTreeContextState): void {
  if (!isTreeFolderView(state) || !state.selectedItem) return;
  const container = sidebarItemContainer(state, state.selectedItem);
  if (container !== undefined) state.currentFolderId = container;
}

/**
 * The folder a new conversation is filed in. The navigate view uses the open
 * folder. The tree view files Ctrl+P conversations in the folder under the
 * cursor (or the folder listing the cursor's row) and Ctrl+Shift+O ones at the
 * top level.
 */
export function newConversationFolderId(state: SidebarTreeContextState, placement: NewConversationPlacement): string | null {
  if (!isTreeFolderView(state)) return state.currentFolderId ?? null;
  if (placement === "top_level") return null;
  const item = state.selectedItem;
  if (item?.type === "folder" && state.folders.some(folder => folder.id === item.id)) return item.id;
  return (item ? sidebarItemContainer(state, item) : undefined) ?? state.currentFolderId ?? null;
}
