import type { ConversationSummary, FolderSummary, SidebarItemRef } from "../messages";
import type { SidebarSelectableItem } from "./items";
import type { SidebarPromptState } from "./prompt";
import type { SidebarSearchState } from "../sidebarsearch";
import type { ConversationActionMenuState } from "./conversationactions";
import type { SidebarFolderView } from "./tree";

export interface SidebarState {
  updateStatus?: import("../update-status").UpdateSnapshot;
  open: boolean;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
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
  prompt: SidebarPromptState | null;
  search: SidebarSearchState | null;
  conversationActionMenu: ConversationActionMenuState | null;
}

export function createSidebarState(folderView: SidebarFolderView = "navigate"): SidebarState {
  return {
    open: false,
    conversations: [],
    folders: [],
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
    prompt: null,
    search: null,
    conversationActionMenu: null,
  };
}
