import { conversationActivityState, sidebarConversationActivityContext, type SidebarActivityInputs } from "./activityindicator";
import { sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { buildDisplayRows, type DisplayRow } from "./rows";
import { focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";
import { isTreeFolderView } from "./tree";
import { getActiveSidebarSearchQuery } from "../sidebarsearch";

export function moveSelection(sidebar: SidebarState, delta: number): void {
  const displayRows = buildDisplayRows(sidebar);
  const currentKey = itemKey(sidebar.selectedItem);
  let firstEntry: SidebarSelectableItem | null = null;
  let previousEntry: SidebarSelectableItem | null = null;
  let lastEntry: SidebarSelectableItem | null = null;
  let foundCurrent = false;
  for (const row of displayRows) {
    if (row.type !== "entry") continue;
    const item = row.item ?? null;
    firstEntry ??= item;
    if (foundCurrent && delta > 0) {
      focusSidebarItem(sidebar, item);
      return;
    }
    if (itemKey(item) === currentKey) {
      foundCurrent = true;
      if (delta < 0) {
        focusSidebarItem(sidebar, previousEntry ?? item);
        return;
      }
    }
    previousEntry = item;
    lastEntry = item;
  }
  if (!firstEntry) return;
  if (!foundCurrent) focusSidebarItem(sidebar, delta >= 0 ? firstEntry : lastEntry);
  else if (delta > 0) focusSidebarItem(sidebar, lastEntry);
}

/**
 * Move to the nearest entry of `rows` below (delta=1) or above (delta=-1) that
 * matches, wrapping around and skipping the selected row. No match leaves the
 * selection where it is. Focusing a row inside collapsed tree folders expands them.
 */
function moveToEntry(
  sidebar: SidebarState,
  rows: readonly DisplayRow[],
  delta: 1 | -1,
  matches: (row: DisplayRow) => boolean,
): void {
  const entries = rows
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => row.type === "entry" && row.item);
  const selectedKey = itemKey(sidebar.selectedItem);
  const selectedRowIndex = entries.find(({ row }) => itemKey(row.item ?? null) === selectedKey)?.rowIndex;
  const targets = entries.filter(({ row, rowIndex }) => rowIndex !== selectedRowIndex && matches(row));
  if (targets.length === 0) return;
  const target = selectedRowIndex === undefined
    ? (delta > 0 ? targets[0] : targets[targets.length - 1])
    : delta > 0
      ? targets.find(({ rowIndex }) => rowIndex > selectedRowIndex) ?? targets[0]
      : targets.findLast(({ rowIndex }) => rowIndex < selectedRowIndex) ?? targets[targets.length - 1];
  focusSidebarItem(sidebar, target.row.item ?? null);
}

/** ] / [ in the sidebar: the next or previous visible folder row. */
export function moveToFolder(sidebar: SidebarState, delta: 1 | -1): void {
  moveToEntry(sidebar, buildDisplayRows(sidebar), delta, row => row.item?.type === "folder");
}

/**
 * The tree as it would read with every folder expanded, so a jump can reach
 * rows inside collapsed folders. Other views (navigate, search results) keep
 * their visible rows.
 */
function fullyExpandedRows(sidebar: SidebarState): readonly DisplayRow[] {
  if (!isTreeFolderView(sidebar) || getActiveSidebarSearchQuery(sidebar)) return buildDisplayRows(sidebar);
  return buildDisplayRows({ ...sidebar, expandedFolderIds: new Set(sidebar.folders.map(folder => folder.id)) });
}

/**
 * Shift+L / Shift+H in the sidebar: the next or previous conversation drawn as
 * streaming (blue) or waiting (yellow: a long Chrono sleep or wait, the global
 * idle gate, a provider wait), in tree order with collapsed folders included;
 * landing inside one expands it and its ancestors. Folders and finished-unread
 * rows are skipped.
 */
export function moveToActiveConversation(sidebar: SidebarState, delta: 1 | -1, inputs: SidebarActivityInputs): void {
  moveToEntry(sidebar, fullyExpandedRows(sidebar), delta, row => {
    const item = row.item;
    if (item?.type !== "conversation") return false;
    const listed = sidebar.conversations[row.convIdx ?? -1];
    const conv = listed?.id === item.id ? listed : sidebar.conversations.find(c => c.id === item.id);
    if (!conv) return false;
    const state = conversationActivityState(conv, sidebarConversationActivityContext(sidebar, conv, inputs));
    return state === "streaming" || state === "warning";
  });
}

/**
 * The nearest conversation row below (delta=1) or above (delta=-1) showing the
 * green finished-and-unread indicator, wrapping around. Counts from the sidebar
 * cursor's row, or the open conversation's when the cursor is on no listed row,
 * and never returns the open conversation. Rows in collapsed folders are not listed.
 */
export function finishedUnreadConversationFrom(
  sidebar: SidebarState,
  currentConvId: string | null,
  delta: 1 | -1,
  inputs: SidebarActivityInputs,
): string | null {
  const entries = buildDisplayRows(sidebar).filter(row => row.type === "entry" && row.item);
  const count = entries.length;
  const selectedKey = itemKey(sidebar.selectedItem);
  let anchor = selectedKey === null ? -1 : entries.findIndex(row => itemKey(row.item ?? null) === selectedKey);
  if (anchor === -1 && currentConvId) {
    anchor = entries.findIndex(row => row.item?.type === "conversation" && row.item.id === currentConvId);
  }
  for (let step = 1; step <= count; step++) {
    const index = anchor === -1
      ? (delta > 0 ? step - 1 : count - step)
      : ((anchor + delta * step) % count + count) % count;
    const item = entries[index].item;
    if (item?.type !== "conversation" || item.id === currentConvId) continue;
    const listed = sidebar.conversations[entries[index].convIdx ?? -1];
    const conv = listed?.id === item.id ? listed : sidebar.conversations.find(c => c.id === item.id);
    if (!conv) continue;
    if (conversationActivityState(conv, sidebarConversationActivityContext(sidebar, conv, inputs)) === "unread") return conv.id;
  }
  return null;
}
