import { sidebarItemKey as itemKey, type SidebarSelectableItem } from "./items";
import { buildDisplayRows, type DisplayRow } from "./rows";
import { focusConversationAt, focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";

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

function foldersWithStreamingIndicator(sidebar: SidebarState): Set<string> {
  const ids = new Set<string>();
  if (sidebar.folders.length === 0) return ids;

  const parentById = new Map<string, string | null>();
  for (const folder of sidebar.folders) parentById.set(folder.id, folder.parentId ?? null);

  for (const conv of sidebar.conversations) {
    if (!conv.streaming && !conv.unread) continue;
    let folderId = conv.folderId ?? null;
    const seen = new Set<string>();
    while (folderId && parentById.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      ids.add(folderId);
      folderId = parentById.get(folderId) ?? null;
    }
  }

  return ids;
}

function hasStreamingIndicator(sidebar: SidebarState, row: DisplayRow, streamingFolderIds: Set<string>): boolean {
  const item = row.item ?? null;
  if (item?.type === "conversation") {
    const conv = row.convIdx === undefined ? sidebar.conversations.find(c => c.id === item.id) : sidebar.conversations[row.convIdx];
    return Boolean(conv?.streaming || conv?.unread);
  }
  if (item?.type === "folder") {
    return streamingFolderIds.has(item.id);
  }
  return false;
}

/** Jump to the next (delta=1) or previous (delta=-1) visible entry with a streaming/unread indicator, wrapping around. */
export function moveToStreaming(sidebar: SidebarState, delta: 1 | -1): void {
  const entries = buildDisplayRows(sidebar)
    .map((row, rowIndex) => ({ row, rowIndex }))
    .filter(({ row }) => row.type === "entry" && row.item);
  const streamingFolderIds = foldersWithStreamingIndicator(sidebar);
  const targets = entries.filter(({ row }) => hasStreamingIndicator(sidebar, row, streamingFolderIds));
  if (targets.length === 0) return;

  const selectedKey = itemKey(sidebar.selectedItem);
  const selectedRowIndex = entries.find(({ row }) => itemKey(row.item ?? null) === selectedKey)?.rowIndex;
  const target = selectedRowIndex === undefined
    ? (delta > 0 ? targets[0] : targets[targets.length - 1])
    : delta > 0
      ? targets.find(({ rowIndex }) => rowIndex > selectedRowIndex) ?? targets[0]
      : targets.findLast(({ rowIndex }) => rowIndex < selectedRowIndex) ?? targets[targets.length - 1];

  focusSidebarItem(sidebar, target.row.item ?? null);
}

/** Jump to the next (delta=1) or previous (delta=-1) boolean-marked conversation, wrapping around. */
export function moveToMarked(sidebar: SidebarState, delta: 1 | -1): void {
  const indices = sidebar.conversations
    .map((conv, index) => ({ conv, index }))
    .filter(({ conv }) => (conv.folderId ?? null) === sidebar.currentFolderId)
    .map(({ index }) => index);
  const len = indices.length;
  if (len === 0) return;
  const current = Math.max(0, indices.indexOf(sidebar.selectedIndex));
  for (let step = 1; step < len; step++) {
    const idx = indices[((current + delta * step) % len + len) % len];
    if (sidebar.conversations[idx]?.marked) {
      focusConversationAt(sidebar, idx);
      return;
    }
  }
}
