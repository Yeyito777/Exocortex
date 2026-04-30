import type { ConversationSummary, FolderSummary, SidebarItemRef } from "../messages";
import type { SidebarSelectableItem } from "./items";
import type { SidebarPromptState } from "./prompt";
import type { SidebarSearchState } from "../sidebarsearch";

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  currentFolderId: string | null;
  selectedId: string | null;
  previousEnteredId: string | null;
  selectedIndex: number;
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
  pendingDeleteId: string | null;
  pendingDeleteItem: SidebarItemRef | null;
  visualAnchor: SidebarItemRef | null;
  pendingFocusItem: SidebarItemRef | null;
  pendingFocusFolder: { name: string; parentId: string | null } | null;
  prompt: SidebarPromptState | null;
  search: SidebarSearchState | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    folders: [],
    currentFolderId: null,
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
    prompt: null,
    search: null,
  };
}
