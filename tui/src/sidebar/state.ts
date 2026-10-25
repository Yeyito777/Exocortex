import type { ConversationSummary, FolderSummary, SidebarItemRef } from "../messages";
import type { SidebarSelectableItem } from "./items";
import type { SidebarPromptState } from "./prompt";
import type { SidebarSearchState } from "../sidebarsearch";
import type { SidebarActionMenuState } from "./actionmenu";
import type { PendingSidebarMove } from "./pendingmoves";
import type { SidebarFolderView } from "./tree";

export interface SidebarState {
  updateStatus?: import("../update-status").UpdateSnapshot;
  open: boolean;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  /** Whether this daemon's conversations list has arrived; until then a saved cursor may not be listed yet. */
  listLoaded: boolean;
  currentFolderId: string | null;
  /** How folders open: replace the list ("navigate") or expand in place ("tree"). */
  folderView: SidebarFolderView;
  /** Folders expanded in the tree view. */
  expandedFolderIds: Set<string>;
  selectedId: string | null;
  previousEnteredId: string | null;
  selectedIndex: number;
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
  pendingDeleteId: string | null;
  pendingDeleteItem: SidebarItemRef | null;
  visualAnchor: SidebarItemRef | null;
  pendingFocusItem: SidebarSelectableItem | null;
  pendingFocusFolder: { name: string; parentId: string | null } | null;
  /** Rows shown for creations the daemon has not acknowledged yet. */
  optimisticConversationIds: Set<string>;
  /** Moves shown locally that the daemon has not settled yet, oldest first. */
  pendingMoves: PendingSidebarMove[];
  prompt: SidebarPromptState | null;
  search: SidebarSearchState | null;
  /** The `;` / right-click menu for a conversation or folder. */
  actionMenu: SidebarActionMenuState | null;
}

export function createSidebarState(folderView: SidebarFolderView = "tree"): SidebarState {
  return {
    open: false,
    conversations: [],
    folders: [],
    listLoaded: false,
    currentFolderId: null,
    folderView,
    expandedFolderIds: new Set(),
    selectedId: null,
    previousEnteredId: null,
    selectedIndex: 0,
    selectedItem: null,
    scrollOffset: 0,
    pendingDeleteId: null,
    pendingDeleteItem: null,
    visualAnchor: null,
    pendingFocusItem: null,
    pendingFocusFolder: null,
    optimisticConversationIds: new Set(),
    pendingMoves: [],
    prompt: null,
    search: null,
    actionMenu: null,
  };
}
