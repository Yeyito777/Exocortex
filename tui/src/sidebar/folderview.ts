import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";
import { revealFolderInTree, type SidebarFolderView } from "./tree";
import { syncSelectedIndex } from "./updates";

export function loadSidebarFolderViewPreference(): SidebarFolderView {
  return readExocortexConfig().tui?.sidebarFolders === "navigate" ? "navigate" : "tree";
}

export function saveSidebarFolderViewPreference(view: SidebarFolderView): void {
  updateExocortexConfig((config) => {
    config.tui = { ...(config.tui ?? {}), sidebarFolders: view };
  });
}

/** Switch folder views, keeping the cursor on the same row and folder. */
export function setSidebarFolderView(sidebar: SidebarState, view: SidebarFolderView): void {
  if (sidebar.folderView === view) return;
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
  // The tree view has no ".." row; land on the folder it would have left.
  const upFrom = sidebar.selectedItem?.type === "up" ? sidebar.currentFolderId : null;
  sidebar.folderView = view;
  if (view === "tree") revealFolderInTree(sidebar, sidebar.currentFolderId);
  if (upFrom) focusSidebarItem(sidebar, { type: "folder", id: upFrom });
  syncSelectedIndex(sidebar);
}
