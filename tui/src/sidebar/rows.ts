import type { ConversationSummary, FolderSummary } from "../messages";
import type { SidebarSelectableItem } from "./items";
import type { SidebarPromptState } from "./prompt";
import { sidebarPromptAutocompleteVisibleRows } from "./prompt";
import { compareSidebarOrder } from "./order";
import { isTreeFolderView, type SidebarFolderView } from "./tree";
import {
  getActiveSidebarSearchQuery,
  getVisibleFolderIndicesForQuery,
  getVisibleConversationIndicesForQuery,
} from "../sidebarsearch";

export interface SidebarRowsState {
  updateStatus?: import("../update-status").UpdateSnapshot;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  currentFolderId: string | null;
  folderView?: SidebarFolderView;
  expandedFolderIds?: Set<string>;
  prompt?: SidebarPromptState | null;
  search: import("../sidebarsearch").SidebarSearchState | null;
}

export interface DisplayRow {
  type: "label" | "delimiter" | "entry";
  convIdx?: number;
  folderIdx?: number;
  item?: SidebarSelectableItem;
  text?: string;
  /** Nesting level in the tree folder view; top-level rows are 0. */
  depth?: number;
}

type DisplayEntry = { pinned: boolean; sortOrder: number; row: DisplayRow };

function folderEntry(sidebar: SidebarRowsState, index: number): DisplayEntry {
  const folder = sidebar.folders[index];
  return { pinned: folder.pinned, sortOrder: folder.sortOrder, row: { type: "entry", folderIdx: index, item: { type: "folder", id: folder.id } } };
}

function conversationEntry(sidebar: SidebarRowsState, index: number): DisplayEntry {
  const conv = sidebar.conversations[index];
  return { pinned: conv.pinned, sortOrder: conv.sortOrder, row: { type: "entry", convIdx: index, item: { type: "conversation", id: conv.id } } };
}

/** Lay out every folder level with expanded folders' contents directly below them. */
function buildTreeDisplayRows(sidebar: SidebarRowsState): DisplayRow[] {
  const childrenByParent = new Map<string | null, DisplayEntry[]>();
  const addChild = (parentId: string | null, entry: DisplayEntry) => {
    const children = childrenByParent.get(parentId);
    if (children) children.push(entry);
    else childrenByParent.set(parentId, [entry]);
  };
  sidebar.folders.forEach((folder, index) => addChild(folder.parentId ?? null, folderEntry(sidebar, index)));
  sidebar.conversations.forEach((conv, index) => addChild(conv.folderId ?? null, conversationEntry(sidebar, index)));

  const rows: DisplayRow[] = [];
  const expanded = sidebar.expandedFolderIds;
  const listed = new Set<string>();
  const appendLevel = (parentId: string | null, depth: number) => {
    const entries = (childrenByParent.get(parentId) ?? []).sort(compareSidebarOrder);
    if (parentId) rows.push({ type: "entry", item: { type: "folder_instructions", folderId: parentId }, depth });
    const pinned = entries.filter(entry => entry.pinned);
    const unpinned = entries.filter(entry => !entry.pinned);
    if (pinned.length > 0) {
      if (!parentId) rows.push({ type: "label", text: " Pinned" });
      for (const entry of pinned) appendEntry(entry, depth);
      if (unpinned.length > 0) rows.push({ type: "delimiter", depth });
    }
    for (const entry of unpinned) appendEntry(entry, depth);
  };
  const appendEntry = (entry: DisplayEntry, depth: number) => {
    rows.push({ ...entry.row, depth });
    const item = entry.row.item;
    if (item?.type !== "folder" || !expanded?.has(item.id) || listed.has(item.id)) return;
    listed.add(item.id);
    appendLevel(item.id, depth + 1);
  };
  appendLevel(null, 0);
  return rows;
}

/**
 * Build the flat list of display rows from the conversation/folder lists.
 * Used by rendering, navigation, and mouse hit-testing so the layout is
 * defined in one place.
 */
export function buildDisplayRows(sidebar: SidebarRowsState): DisplayRow[] {
  const activeQuery = getActiveSidebarSearchQuery(sidebar);
  // Search results stay a flat list in either folder view.
  if (!activeQuery && isTreeFolderView(sidebar)) return buildTreeDisplayRows(sidebar);

  const rows: DisplayRow[] = [];
  const visibleConvIndices = getVisibleConversationIndicesForQuery(sidebar, activeQuery);
  const visibleFolderIndices = getVisibleFolderIndicesForQuery(sidebar, activeQuery);

  const entries = [
    ...visibleFolderIndices.map(index => folderEntry(sidebar, index)),
    ...visibleConvIndices.map(index => conversationEntry(sidebar, index)),
  ].sort(compareSidebarOrder);

  if (!activeQuery && sidebar.currentFolderId) {
    rows.push({ type: "entry", item: { type: "up" }, text: ".." });
    rows.push({ type: "entry", item: { type: "folder_instructions", folderId: sidebar.currentFolderId } });
  }

  const pinned = entries.filter(entry => entry.pinned);
  const unpinned = entries.filter(entry => !entry.pinned);
  if (pinned.length > 0) {
    if (!sidebar.currentFolderId) rows.push({ type: "label", text: " Pinned" });
    for (const entry of pinned) rows.push(entry.row);
    if (unpinned.length > 0) rows.push({ type: "delimiter" });
  }
  for (const entry of unpinned) rows.push(entry.row);
  return rows;
}

export function sidebarListRows(totalRows: number, sidebar: SidebarRowsState): number {
  const promptAutocompleteRows = sidebarPromptAutocompleteVisibleRows(sidebar.prompt ?? null, Boolean(sidebar.search?.barOpen), totalRows);
  const bottomBarRows = sidebar.search?.barOpen ? 1 : sidebar.prompt ? 1 + promptAutocompleteRows : 0;
  return Math.max(0, totalRows - 2 - bottomBarRows - sidebarUpdateRows(totalRows, sidebar));
}

/** Editing bars take precedence, including on very small terminals. */
export function sidebarUpdateRows(totalRows: number, sidebar: SidebarRowsState): number {
  const status = sidebar.updateStatus;
  if (!status || sidebar.search?.barOpen || sidebar.prompt) return 0;
  if (status.remote !== null) {
    if (status.remote === "none" && status.local === "none") return 0;
    return totalRows >= 6 && !(status.remote === "disabled" && status.local === "disabled") ? 3 : 0;
  }
  return totalRows >= 5 && (status.local === "update_available" || status.local === "restart_needed") ? 2 : 0;
}

export function findDisplayEntry(
  displayRows: DisplayRow[],
  start: number,
  end: number,
  step: 1 | -1,
): SidebarSelectableItem | null {
  for (let row = start; step > 0 ? row <= end : row >= end; row += step) {
    if (displayRows[row]?.type === "entry") return displayRows[row].item ?? null;
  }
  return null;
}

export function nearestDisplayEntry(
  displayRows: DisplayRow[],
  targetRow: number,
  preferredStep: -1 | 0 | 1,
): SidebarSelectableItem | null {
  const clampedTarget = Math.max(0, Math.min(targetRow, Math.max(0, displayRows.length - 1)));
  if (displayRows[clampedTarget]?.type === "entry") return displayRows[clampedTarget].item ?? null;

  const scan = (step: 1 | -1): SidebarSelectableItem | null => {
    for (let row = clampedTarget + step; row >= 0 && row < displayRows.length; row += step) {
      if (displayRows[row]?.type === "entry") return displayRows[row].item ?? null;
    }
    return null;
  };

  if (preferredStep < 0) return scan(-1) ?? scan(1);
  if (preferredStep > 0) return scan(1) ?? scan(-1);
  return scan(1) ?? scan(-1);
}

export function revealPrecedingSectionLabel(displayRows: DisplayRow[], viewStart: number): number {
  if (viewStart > 0
      && displayRows[viewStart]?.type === "entry"
      && displayRows[viewStart - 1]?.type === "label") {
    return viewStart - 1;
  }
  return viewStart;
}

export function snapSidebarViewStartToEntry(
  displayRows: DisplayRow[],
  listRows: number,
  viewStart: number,
  direction: -1 | 0 | 1,
): number {
  const maxStart = Math.max(0, displayRows.length - listRows);
  const clamped = Math.max(0, Math.min(viewStart, maxStart));
  const revealSectionLabel = direction < 0;
  const snapEntry = (row: number): number => revealSectionLabel ? revealPrecedingSectionLabel(displayRows, row) : row;

  if (displayRows[clamped]?.type === "label" && displayRows[clamped + 1]?.type === "entry") return clamped;
  if (displayRows[clamped]?.type === "entry") return snapEntry(clamped);

  const scan = (step: 1 | -1): number | null => {
    for (let row = clamped + step; row >= 0 && row <= maxStart; row += step) {
      if (displayRows[row]?.type === "label" && displayRows[row + 1]?.type === "entry") return row;
      if (displayRows[row]?.type === "entry") return snapEntry(row);
    }
    return null;
  };

  // Sidebar labels/delimiters are chrome, not cursor-bearing content. If a
  // scroll lands the viewport top on a delimiter, keep moving in the scroll
  // direction until the top row is an entry. Section labels such as "Pinned"
  // are different: when scrolling up into a section, keep that label visible;
  // when scrolling down, don't pull the viewport back and disturb the cursor's
  // screen position just to reveal a label above it.
  if (direction > 0) return scan(1) ?? scan(-1) ?? clamped;
  if (direction < 0) return scan(-1) ?? scan(1) ?? clamped;
  return scan(1) ?? scan(-1) ?? clamped;
}
