/**
 * The incremental sidebar bootstrap (`sidebar-incremental`): which
 * conversations the first page of the list must carry so the rows the TUI
 * draws first are exactly the rows the full list gives, before the rest lands.
 *
 * The walk mirrors tui/src/sidebar/rows.ts: each level lists its folders and
 * conversations together, pinned first then by sortOrder; the top level opens
 * with a "Pinned" label, a delimiter separates a level's pinned rows from the
 * rest; in the tree view an expanded folder's contents follow it, in the
 * navigate view one folder is listed under a ".." row. Every conversation in
 * the first `scrollOffset + rows + margin` rows is included, so the partial
 * layout's prefix is identical (an entry is never missing ahead of a shown one).
 */

export interface SidebarViewHint {
  folderView: "tree" | "navigate";
  /** The navigate view's open folder (ignored by the tree view). */
  currentFolderId: string | null;
  expandedFolderIds: string[];
  /** First display row on screen, and how many rows the terminal has. */
  scrollOffset: number;
  rows: number;
  /** Included wherever they are: the open conversation, the cursor's. */
  conversationIds: string[];
}

interface OrderedRow { id: string; pinned: boolean; sortOrder: number }
type ConversationRow = OrderedRow & { folderId?: string | null };
type FolderRow = OrderedRow & { parentId?: string | null };

/** Rows past the screen that are also exact, for scrolling before the rest lands. */
const MIN_MARGIN_ROWS = 40;
/** Hints are untrusted input: bound the walk. */
const MAX_PAGE_ROWS = 2_000;

function compareSidebarOrder(a: OrderedRow, b: OrderedRow): number {
  return (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder;
}

export function isSidebarViewHint(value: unknown): value is SidebarViewHint {
  if (!value || typeof value !== "object") return false;
  const hint = value as Partial<SidebarViewHint>;
  return (hint.folderView === "tree" || hint.folderView === "navigate")
    && (hint.currentFolderId === null || typeof hint.currentFolderId === "string")
    && Array.isArray(hint.expandedFolderIds) && hint.expandedFolderIds.every(id => typeof id === "string")
    && Number.isSafeInteger(hint.scrollOffset) && hint.scrollOffset! >= 0
    && Number.isSafeInteger(hint.rows) && hint.rows! >= 0
    && Array.isArray(hint.conversationIds) && hint.conversationIds.every(id => typeof id === "string");
}

/** Conversations on the first rows this view draws, in display order. */
export function sidebarFirstPageConversationIds(
  conversations: readonly ConversationRow[],
  folders: readonly FolderRow[],
  view: SidebarViewHint,
): string[] {
  const budget = Math.min(MAX_PAGE_ROWS, view.scrollOffset + view.rows + Math.max(MIN_MARGIN_ROWS, view.rows));
  type Entry = { row: OrderedRow; folder: boolean };
  const children = new Map<string | null, Entry[]>();
  const add = (parentId: string | null, entry: Entry) => {
    const list = children.get(parentId);
    if (list) list.push(entry);
    else children.set(parentId, [entry]);
  };
  for (const folder of folders) add(folder.parentId ?? null, { row: folder, folder: true });
  for (const conversation of conversations) add(conversation.folderId ?? null, { row: conversation, folder: false });

  const ids: string[] = [];
  let rowCount = 0;
  const expanded = new Set(view.expandedFolderIds);
  const listed = new Set<string>();
  const tree = view.folderView === "tree";
  // Returns false once the budget is spent.
  const appendLevel = (parentId: string | null): boolean => {
    const entries = (children.get(parentId) ?? []).slice().sort((a, b) => compareSidebarOrder(a.row, b.row));
    const pinned = entries.filter(entry => entry.row.pinned);
    const unpinned = entries.filter(entry => !entry.row.pinned);
    if (pinned.length > 0) {
      if (!parentId) rowCount++;
      for (const entry of pinned) if (!appendEntry(entry)) return false;
      if (unpinned.length > 0) rowCount++;
    }
    for (const entry of unpinned) if (!appendEntry(entry)) return false;
    return true;
  };
  const appendEntry = (entry: Entry): boolean => {
    if (rowCount >= budget) return false;
    rowCount++;
    if (!entry.folder) {
      ids.push(entry.row.id);
      return true;
    }
    if (!tree || !expanded.has(entry.row.id) || listed.has(entry.row.id)) return true;
    listed.add(entry.row.id);
    return appendLevel(entry.row.id);
  };

  if (tree) {
    appendLevel(null);
  } else {
    const folderId = view.currentFolderId && folders.some(folder => folder.id === view.currentFolderId) ? view.currentFolderId : null;
    if (folderId) rowCount++; // the ".." row
    appendLevel(folderId);
  }
  return ids;
}

/** Conversations in each folder, counting those in its subfolders, as the sidebar's folder rows show. */
export function sidebarFolderConversationCounts(
  conversations: readonly ConversationRow[],
  folders: readonly FolderRow[],
): Record<string, number> {
  const parentById = new Map(folders.map(folder => [folder.id, folder.parentId ?? null] as const));
  const counts: Record<string, number> = {};
  for (const folder of folders) counts[folder.id] = 0;
  for (const conversation of conversations) {
    const seen = new Set<string>();
    let folderId = conversation.folderId ?? null;
    while (folderId && parentById.has(folderId) && !seen.has(folderId)) {
      seen.add(folderId);
      counts[folderId]!++;
      folderId = parentById.get(folderId) ?? null;
    }
  }
  return counts;
}
