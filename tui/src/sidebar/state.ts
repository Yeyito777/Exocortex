import type { ConversationSummary, FolderSummary, SidebarItemRef } from "../messages";
import type { SidebarSelectableItem } from "./items";
import type { SidebarPromptState } from "./prompt";
import type { SidebarSearchState } from "../sidebarsearch";
import type { SidebarActionMenuState } from "./actionmenu";
import type { PendingSidebarMove } from "./pendingmoves";
import type { SidebarFolderView } from "./tree";

export interface SidebarState {
  updateStatus?: import("../update-status").UpdateSnapshot;
  open: boolean;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  /** Whether this daemon's conversations list has arrived; until then a saved cursor may not be listed yet. */
  listLoaded: boolean;
  /**
   * While only the bootstrap's first page is here (sidebar-incremental): the
   * full list's per-folder counts, shown until the rest arrives.
   */
  partial: { folderConversationCounts: Record<string, number> } | null;
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
  /** Moves shown locally that the daemon has not settled yet, oldest first. */
  pendingMoves: PendingSidebarMove[];
  prompt: SidebarPromptState | null;
  search: SidebarSearchState | null;
  /** The `;` / right-click menu for a conversation or folder. */
  actionMenu: SidebarActionMenuState | null;
}

/** id → summary for each conversation list, kept with it (conversationById). */
const conversationIndexes = new WeakMap<ConversationSummary[], Map<string, ConversationSummary>>();

function indexConversations(list: ConversationSummary[]): Map<string, ConversationSummary> {
  const index = new Map(list.map(conversation => [conversation.id, conversation]));
  conversationIndexes.set(list, index);
  return index;
}

/**
 * A conversation's summary by id, without scanning the list: frames ask for
 * the open one from several places, and the list holds thousands. A list
 * assigned anew is indexed on its first lookup; changes in place go through
 * replaceConversationAt / insertConversation / removeConversationAt, which keep
 * the index. Reordering needs nothing. A list grown in place some other way is
 * indexed again on a miss.
 */
export function conversationById(sidebar: { conversations: ConversationSummary[] } | undefined, id: string | null | undefined): ConversationSummary | undefined {
  if (!sidebar || !id) return undefined;
  const list = sidebar.conversations;
  const index = conversationIndexes.get(list) ?? indexConversations(list);
  const found = index.get(id);
  if (found || index.size === list.length) return found;
  return indexConversations(list).get(id);
}

export function replaceConversationAt(sidebar: SidebarState, at: number, summary: ConversationSummary): void {
  const index = conversationIndexes.get(sidebar.conversations);
  const old = sidebar.conversations[at];
  if (index && old && index.get(old.id) === old) index.delete(old.id);
  sidebar.conversations[at] = summary;
  index?.set(summary.id, summary);
}

export function insertConversation(sidebar: SidebarState, at: number, summary: ConversationSummary): void {
  sidebar.conversations.splice(at, 0, summary);
  conversationIndexes.get(sidebar.conversations)?.set(summary.id, summary);
}

export function removeConversationAt(sidebar: SidebarState, at: number): void {
  const [removed] = sidebar.conversations.splice(at, 1);
  const index = conversationIndexes.get(sidebar.conversations);
  if (removed && index?.get(removed.id) === removed) index.delete(removed.id);
}

export function createSidebarState(folderView: SidebarFolderView = "tree"): SidebarState {
  return {
    open: false,
    conversations: [],
    folders: [],
    listLoaded: false,
    partial: null,
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
    pendingMoves: [],
    prompt: null,
    search: null,
    actionMenu: null,
  };
}
