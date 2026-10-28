import type { SidebarItemRef } from "../messages";
import { descendantFolderIds } from "./folders";
import { sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { buildDisplayRows, type DisplayRow } from "./rows";
import type { SidebarState } from "./state";
import { isTreeFolderView, sidebarItemContainer } from "./tree";

interface RemovalEntry {
  item: SidebarSelectableItem;
  pinned: boolean | null;
  /** Folder listing the row in the tree view, where each level is its own section. */
  container: string | null | undefined;
}

function displayRowPinned(sidebar: SidebarState, row: DisplayRow): boolean | null {
  if (row.item?.type === "conversation" && row.convIdx !== undefined) {
    return sidebar.conversations[row.convIdx]?.pinned ?? null;
  }
  if (row.item?.type === "folder" && row.folderIdx !== undefined) {
    return sidebar.folders[row.folderIdx]?.pinned ?? null;
  }
  return null;
}

function removableDisplayEntries(sidebar: SidebarState): RemovalEntry[] {
  const treeView = isTreeFolderView(sidebar);
  return buildDisplayRows(sidebar)
    .flatMap(row => row.type === "entry" && row.item
      ? [{ item: row.item, pinned: displayRowPinned(sidebar, row), container: treeView ? sidebarItemContainer(sidebar, row.item) : null }]
      : []);
}

/** Folders whose rows leave the view with the removed items, nested ones included. */
function removedFolderIds(sidebar: SidebarState, items: SidebarItemRef[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.type === "folder") for (const id of descendantFolderIds(sidebar, item.id)) ids.add(id);
  }
  return ids;
}

function leavesWithRemovedFolder(sidebar: SidebarState, item: SidebarSelectableItem, folderIds: Set<string>): boolean {
  if (folderIds.size === 0) return false;
  if (item.type === "folder") return folderIds.has(item.id);
  if (item.type !== "conversation") return false;
  const folderId = sidebar.conversations.find(conv => conv.id === item.id)?.folderId;
  return !!folderId && folderIds.has(folderId);
}

/**
 * Pick the visible item that should receive focus after items leave this view.
 *
 * Like vim's `dd`: the cursor stays in the removed row's slot, so it lands on
 * the entry that was directly below the removed block. Pinned and unpinned
 * entries are separate visual sections, though (as is each folder level in the
 * tree view): when the removed block was the last of its section, take the
 * entry above it instead of jumping across the divider. Only cross sections
 * when the removed block emptied its own; then too prefer the entry above.
 */
export function focusTargetAfterRemovingSidebarItems(
  sidebar: SidebarState,
  items: SidebarItemRef[],
): SidebarSelectableItem | null {
  const removedKeys = new Set(items.map(item => itemKey(item)));
  const entriesBefore = removableDisplayEntries(sidebar);
  const firstRemovedIndex = entriesBefore.findIndex(entry => removedKeys.has(itemKey(entry.item)));
  if (firstRemovedIndex === -1) return entriesBefore[0]?.item ?? null;

  const removedSection = entriesBefore[firstRemovedIndex].pinned;
  const removedContainer = entriesBefore[firstRemovedIndex].container;
  // A removed folder takes the rows listed inside it (tree view, search) along.
  const goneFolders = removedFolderIds(sidebar, items);
  const entriesAbove = entriesBefore.slice(0, firstRemovedIndex);
  const entriesBelow = entriesBefore.slice(firstRemovedIndex + 1).filter(entry =>
    !removedKeys.has(itemKey(entry.item)) && !leavesWithRemovedFolder(sidebar, entry.item, goneFolders));
  if (entriesAbove.length === 0 && entriesBelow.length === 0) return null;

  const sameSection = (entry: RemovalEntry): boolean => entry.pinned === removedSection && entry.container === removedContainer;

  const belowInSection = entriesBelow.find(sameSection);
  if (belowInSection) return belowInSection.item;

  const aboveInSection = entriesAbove.findLast(sameSection);
  if (aboveInSection) return aboveInSection.item;

  return entriesAbove[entriesAbove.length - 1]?.item
    ?? entriesBelow[0]?.item
    ?? null;
}
