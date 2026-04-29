import { sidebarItemKey as itemKey } from "./items";
import { buildDisplayRows } from "./rows";
import { focusConversationAt, focusSidebarItem } from "./selection";
import type { SidebarState } from "./state";

export function moveSelection(sidebar: SidebarState, delta: number): void {
  const displayRows = buildDisplayRows(sidebar);
  const entries = displayRows.filter(row => row.type === "entry");
  if (entries.length === 0) return;
  const currentKey = itemKey(sidebar.selectedItem);
  const currentEntryIndex = entries.findIndex(row => itemKey(row.item ?? null) === currentKey);
  const nextEntryIndex = currentEntryIndex === -1
    ? (delta >= 0 ? 0 : entries.length - 1)
    : Math.max(0, Math.min(currentEntryIndex + delta, entries.length - 1));
  focusSidebarItem(sidebar, entries[nextEntryIndex].item ?? null);
}

/** Jump to the next (delta=1) or previous (delta=-1) conversation with a streaming indicator, wrapping around. */
export function moveToStreaming(sidebar: SidebarState, delta: 1 | -1): void {
  const indices = sidebar.conversations
    .map((conv, index) => ({ conv, index }))
    .filter(({ conv }) => (conv.folderId ?? null) === sidebar.currentFolderId)
    .map(({ index }) => index);
  const len = indices.length;
  if (len === 0) return;
  const current = Math.max(0, indices.indexOf(sidebar.selectedIndex));
  for (let step = 1; step < len; step++) {
    const idx = indices[((current + delta * step) % len + len) % len];
    const conv = sidebar.conversations[idx];
    if (conv.streaming || conv.unread) {
      focusConversationAt(sidebar, idx);
      return;
    }
  }
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
