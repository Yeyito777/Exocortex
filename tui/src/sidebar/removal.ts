import type { SidebarItemRef } from "../messages";
import { sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { buildDisplayRows, type DisplayRow } from "./rows";
import type { SidebarState } from "./state";

interface RemovalEntry {
  item: SidebarSelectableItem;
  pinned: boolean | null;
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
  return buildDisplayRows(sidebar)
    .flatMap(row => row.type === "entry" && row.item && row.item.type !== "folder_instructions"
      ? [{ item: row.item, pinned: displayRowPinned(sidebar, row) }]
      : []);
}

/**
 * Pick the visible item that should receive focus after items leave this view.
 *
 * Prefer the entry above the removed block, matching the established sidebar
 * behavior. Pinned and unpinned entries are separate visual sections, though:
 * at a section boundary, keep focus in the removed item's section by choosing
 * the entry below instead of jumping across the divider. Only cross sections
 * when no entry remains in the original section.
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
  const entriesAfter = entriesBefore.filter(entry => !removedKeys.has(itemKey(entry.item)));
  if (entriesAfter.length === 0) return null;

  const entriesAbove = entriesAfter.slice(0, firstRemovedIndex);
  const entriesBelow = entriesAfter.slice(firstRemovedIndex);
  const sameSection = (entry: RemovalEntry): boolean => entry.pinned === removedSection;

  const aboveInSection = entriesAbove.findLast(sameSection);
  if (aboveInSection) return aboveInSection.item;

  const belowInSection = entriesBelow.find(sameSection);
  if (belowInSection) return belowInSection.item;

  return entriesAbove[entriesAbove.length - 1]?.item
    ?? entriesBelow[0]?.item
    ?? null;
}
