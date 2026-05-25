/**
 * Sidebar conversation search.
 *
 * Implements vim-style / and ? search over conversation titles, filtering the
 * visible sidebar list down to matches until :noh clears highlights.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary, FolderSummary, SidebarItemRef } from "./messages";
import type { SidebarSelectableItem } from "./sidebar/items";
import { sidebarItemKey } from "./sidebar/items";
import { compareSidebarOrder } from "./sidebar/order";
import { convDisplayName } from "./messages";
import { stripMark } from "./marks";
import { theme } from "./theme";
import {
  findAllCaseInsensitiveMatchStarts,
  findNextSortedMatch,
} from "./searchutil";
import { getViewportByWidth, padRightToWidth } from "./textwidth";

export type SidebarSearchDirection = "forward" | "backward";
export type SidebarSearchBarMode = "search" | "command";

export type SidebarSearchKeyResult =
  | { type: "handled" }
  | { type: "abort" };

export interface SidebarSearchState {
  barOpen: boolean;
  barMode: SidebarSearchBarMode;
  direction: SidebarSearchDirection;
  query: string;
  barInput: string;
  barCursorPos: number;
  highlightsVisible: boolean;
  savedSelectedId: string | null;
  savedSelectedIndex: number;
  savedSelectedItem?: SidebarSelectableItem | null;
  savedScrollOffset: number;
}

export interface SidebarSearchableState {
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  selectedId: string | null;
  selectedIndex: number;
  scrollOffset: number;
  pendingDeleteId: string | null;
  pendingDeleteItem?: SidebarItemRef | null;
  visualAnchor?: SidebarItemRef | null;
  currentFolderId?: string | null;
  selectedItem?: SidebarSelectableItem | null;
  search: SidebarSearchState | null;
}

export function focusConversationAt(sidebar: SidebarSearchableState, index: number): void {
  if (sidebar.conversations.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.selectedId = null;
    if ("selectedItem" in sidebar) sidebar.selectedItem = null;
    return;
  }

  const nextIndex = Math.max(0, Math.min(index, sidebar.conversations.length - 1));
  const nextId = sidebar.conversations[nextIndex]?.id ?? null;
  sidebar.selectedIndex = nextIndex;
  sidebar.selectedId = nextId;
  if ("selectedItem" in sidebar) sidebar.selectedItem = nextId ? { type: "conversation", id: nextId } : null;
}

export function focusSidebarItem(sidebar: SidebarSearchableState, item: SidebarSelectableItem | null): void {
  const convItem = item?.type === "conversation" && "id" in item ? item : null;
  if (convItem) {
    const idx = sidebar.conversations.findIndex(c => c.id === convItem.id);
    if (idx !== -1) {
      focusConversationAt(sidebar, idx);
      return;
    }
    item = null;
  }

  sidebar.selectedItem = item;
  sidebar.selectedId = null;
  sidebar.selectedIndex = Math.max(0, Math.min(sidebar.selectedIndex, Math.max(0, sidebar.conversations.length - 1)));
}

export function focusConversationById(sidebar: SidebarSearchableState, convId: string): boolean {
  const idx = sidebar.conversations.findIndex(c => c.id === convId);
  if (idx === -1) return false;
  focusConversationAt(sidebar, idx);
  return true;
}

export function getSearchableConversationTitle(conv: Pick<ConversationSummary, "title">): string {
  return stripMark(convDisplayName(conv, ""));
}

function getSearchFilterConversationTitle(conv: Pick<ConversationSummary, "title">): string {
  const title = convDisplayName(conv, "");
  return title.length === 0 || title.charCodeAt(0) < 0x80 ? title : stripMark(title);
}

function folderMatchesQuery(folder: Pick<FolderSummary, "name">, query: string): boolean {
  return findAllCaseInsensitiveMatchStarts(folder.name || "Folder", query).length > 0;
}

export function getVisibleFolderIndicesForQuery(
  sidebar: Pick<SidebarSearchableState, "folders"> & { currentFolderId?: string | null },
  query: string | null,
): number[] {
  const visible: number[] = [];
  for (let i = 0; i < sidebar.folders.length; i++) {
    const folder = sidebar.folders[i];
    if (query) {
      if (folderMatchesQuery(folder, query)) visible.push(i);
      continue;
    }
    if ((folder.parentId ?? null) === (sidebar.currentFolderId ?? null)) visible.push(i);
  }
  return visible;
}

export function getVisibleConversationIndicesForQuery(
  sidebar: Pick<SidebarSearchableState, "conversations"> & { currentFolderId?: string | null },
  query: string | null,
): number[] {
  const visible: number[] = [];
  const scopedToCurrentFolder = !query;
  for (let i = 0; i < sidebar.conversations.length; i++) {
    const conv = sidebar.conversations[i];
    if (scopedToCurrentFolder && "currentFolderId" in sidebar && (conv.folderId ?? null) !== (sidebar.currentFolderId ?? null)) continue;
    if (!query || findAllCaseInsensitiveMatchStarts(getSearchFilterConversationTitle(conv), query).length > 0) {
      visible.push(i);
    }
  }
  return visible;
}

export function getActiveSidebarSearchQuery(sidebar: Pick<SidebarSearchableState, "search">): string | null {
  const search = sidebar.search;
  if (!search) return null;
  if (search.barOpen && search.barMode === "search") {
    return search.barInput || (search.highlightsVisible ? search.query : null);
  }
  if (search.highlightsVisible && search.query) return search.query;
  return null;
}

export function getVisibleConversationIndices(
  sidebar: Pick<SidebarSearchableState, "conversations" | "search"> & { currentFolderId?: string | null },
): number[] {
  return getVisibleConversationIndicesForQuery(sidebar, getActiveSidebarSearchQuery(sidebar));
}

export function focusNearestVisibleConversation(
  sidebar: SidebarSearchableState,
  preferredIndex: number,
): void {
  const visible = getVisibleConversationIndices(sidebar);
  if (visible.length === 0) {
    focusConversationAt(sidebar, preferredIndex);
    return;
  }

  for (const index of visible) {
    if (index >= preferredIndex) {
      focusConversationAt(sidebar, index);
      return;
    }
  }

  focusConversationAt(sidebar, visible[visible.length - 1]);
}

export function getSelectedVisibleConversation(sidebar: SidebarSearchableState): ConversationSummary | null {
  const conv = sidebar.conversations[sidebar.selectedIndex];
  if (!conv) return null;

  const activeFilterQuery = getActiveSidebarSearchQuery(sidebar);
  if (!activeFilterQuery) return conv;
  if (getVisibleConversationIndicesForQuery(sidebar, activeFilterQuery).includes(sidebar.selectedIndex)) {
    return conv;
  }
  return null;
}

function buildSidebarSearchState(
  sidebar: SidebarSearchableState,
  barMode: SidebarSearchBarMode,
  direction: SidebarSearchDirection,
): SidebarSearchState {
  const savedSelectedItem = sidebar.selectedItem
    ? { ...sidebar.selectedItem }
    : sidebar.selectedId
      ? { type: "conversation" as const, id: sidebar.selectedId }
      : null;
  return {
    barOpen: true,
    barMode,
    direction,
    query: sidebar.search?.query ?? "",
    barInput: "",
    barCursorPos: 0,
    highlightsVisible: sidebar.search?.highlightsVisible ?? false,
    savedSelectedId: sidebar.selectedId,
    savedSelectedIndex: sidebar.selectedIndex,
    savedSelectedItem,
    savedScrollOffset: sidebar.scrollOffset,
  };
}

function findNextSidebarSearchMatch(
  sidebar: Pick<SidebarSearchableState, "conversations" | "folders">,
  query: string,
  fromItem: SidebarSelectableItem | null | undefined,
  direction: SidebarSearchDirection,
): SidebarSelectableItem | null {
  if (!query) return null;
  const entries = [
    ...sidebar.folders
      .map((folder) => ({
        pinned: folder.pinned,
        sortOrder: folder.sortOrder,
        item: { type: "folder" as const, id: folder.id },
        matches: folderMatchesQuery(folder, query),
      })),
    ...sidebar.conversations
      .map((conv) => ({
        pinned: conv.pinned,
        sortOrder: conv.sortOrder,
        item: { type: "conversation" as const, id: conv.id },
        matches: findAllCaseInsensitiveMatchStarts(getSearchFilterConversationTitle(conv), query).length > 0,
      })),
  ].sort(compareSidebarOrder);
  const matches = entries
    .map((entry, index) => entry.matches ? index : -1)
    .filter(index => index !== -1);
  if (matches.length === 0) return null;

  const selectedKey = sidebarItemKey(fromItem ?? null);
  const selectedEntryIndex = selectedKey
    ? entries.findIndex(entry => sidebarItemKey(entry.item) === selectedKey)
    : -1;
  const fromIndex = selectedEntryIndex === -1
    ? direction === "forward" ? -1 : entries.length
    : selectedEntryIndex;
  const matchIndex = findNextSortedMatch(matches, fromIndex, direction);
  return matchIndex == null ? null : entries[matchIndex]?.item ?? null;
}

function restoreSidebarSearchOrigin(sidebar: SidebarSearchableState, search: SidebarSearchState): void {
  sidebar.scrollOffset = search.savedScrollOffset;
  if (search.savedSelectedItem && "selectedItem" in sidebar) {
    sidebar.selectedItem = { ...search.savedSelectedItem };
    if (search.savedSelectedItem.type === "conversation") {
      const savedId = search.savedSelectedItem.id;
      const idx = sidebar.conversations.findIndex(c => c.id === savedId);
      if (idx !== -1) {
        sidebar.selectedIndex = idx;
        sidebar.selectedId = savedId;
        return;
      }
    } else {
      sidebar.selectedId = null;
      return;
    }
  }
  if (search.savedSelectedId && focusConversationById(sidebar, search.savedSelectedId)) return;
  focusConversationAt(sidebar, search.savedSelectedIndex);
}

function liveSidebarSearchToNearestMatch(sidebar: SidebarSearchableState): void {
  const search = sidebar.search;
  if (!search || !search.barOpen || search.barMode !== "search") return;

  if (!search.barInput) {
    restoreSidebarSearchOrigin(sidebar, search);
    return;
  }

  const match = findNextSidebarSearchMatch(
    sidebar,
    search.barInput,
    search.savedSelectedItem ?? sidebar.selectedItem,
    search.direction,
  );
  if (match == null) return;

  focusSidebarItem(sidebar, match);
}

function replaceSidebarSearchBarInput(sidebar: SidebarSearchableState, nextInput: string, nextCursorPos: number): void {
  const search = sidebar.search;
  if (!search) return;
  search.barInput = nextInput;
  search.barCursorPos = nextCursorPos;
  liveSidebarSearchToNearestMatch(sidebar);
}

function insertIntoSidebarSearchBar(sidebar: SidebarSearchableState, text: string): void {
  const search = sidebar.search;
  if (!search || !text) return;
  replaceSidebarSearchBarInput(
    sidebar,
    search.barInput.slice(0, search.barCursorPos) + text + search.barInput.slice(search.barCursorPos),
    search.barCursorPos + text.length,
  );
}

function normalizeSidebarSearchPaste(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, " ");
}

function executeSidebarCommand(sidebar: SidebarSearchableState, command: string): SidebarSearchKeyResult {
  const search = sidebar.search;
  if (!search) return { type: "handled" };

  switch (command) {
    case "noh":
      search.highlightsVisible = false;
      revealFocusedSidebarItemAfterSearch(sidebar);
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
}

function revealFocusedSidebarItemAfterSearch(sidebar: SidebarSearchableState): void {
  const item = sidebar.selectedItem ?? null;
  sidebar.visualAnchor = null;
  sidebar.scrollOffset = 0;

  if (item?.type === "folder") {
    const folder = sidebar.folders.find(f => f.id === item.id);
    if (folder) {
      sidebar.currentFolderId = folder.parentId ?? null;
      focusSidebarItem(sidebar, item);
      return;
    }
  }

  if (item?.type === "conversation") {
    const conv = sidebar.conversations.find(c => c.id === item.id);
    if (conv) {
      sidebar.currentFolderId = conv.folderId ?? null;
      focusSidebarItem(sidebar, item);
      return;
    }
  }

  sidebar.currentFolderId = null;
  focusSidebarItem(sidebar, firstSidebarItemInFolder(sidebar, null));
}

function firstSidebarItemInFolder(sidebar: SidebarSearchableState, parentId: string | null): SidebarSelectableItem | null {
  const entries = [
    ...sidebar.folders
      .filter(folder => (folder.parentId ?? null) === parentId)
      .map(folder => ({ pinned: folder.pinned, sortOrder: folder.sortOrder, item: { type: "folder" as const, id: folder.id } })),
    ...sidebar.conversations
      .filter(conv => (conv.folderId ?? null) === parentId)
      .map(conv => ({ pinned: conv.pinned, sortOrder: conv.sortOrder, item: { type: "conversation" as const, id: conv.id } })),
  ].sort(compareSidebarOrder);
  return entries[0]?.item ?? null;
}

export function openSidebarSearchBar(sidebar: SidebarSearchableState, direction: SidebarSearchDirection): void {
  sidebar.pendingDeleteId = null;
  if ("pendingDeleteItem" in sidebar) sidebar.pendingDeleteItem = null;
  sidebar.search = buildSidebarSearchState(sidebar, "search", direction);
}

export function openSidebarCommandBar(sidebar: SidebarSearchableState): void {
  sidebar.pendingDeleteId = null;
  if ("pendingDeleteItem" in sidebar) sidebar.pendingDeleteItem = null;
  sidebar.search = buildSidebarSearchState(sidebar, "command", sidebar.search?.direction ?? "forward");
}

export function closeSidebarSearchBar(sidebar: SidebarSearchableState, cancel: boolean): void {
  const search = sidebar.search;
  if (!search) return;

  if (cancel) restoreSidebarSearchOrigin(sidebar, search);

  search.barOpen = false;
  search.barInput = "";
  search.barCursorPos = 0;
}

export function jumpToSidebarSearchMatch(
  sidebar: SidebarSearchableState,
  direction: SidebarSearchDirection,
): boolean {
  const search = sidebar.search;
  if (!search?.query) return false;

  const match = findNextSidebarSearchMatch(sidebar, search.query, sidebar.selectedItem, direction);
  if (match == null) return false;

  search.highlightsVisible = true;
  focusSidebarItem(sidebar, match);
  return true;
}

export function handleSidebarSearchBarKey(
  sidebar: SidebarSearchableState,
  key: KeyEvent,
): SidebarSearchKeyResult {
  const search = sidebar.search;
  if (!search?.barOpen) return { type: "handled" };

  if (key.type === "ctrl-q") return { type: "abort" };

  if (key.type === "escape") {
    closeSidebarSearchBar(sidebar, true);
    return { type: "handled" };
  }

  if (key.type === "enter") {
    if (search.barMode === "command") {
      const result = executeSidebarCommand(sidebar, search.barInput.trim());
      closeSidebarSearchBar(sidebar, false);
      return result;
    }

    if (search.barInput) {
      search.query = search.barInput;
      search.highlightsVisible = true;
      liveSidebarSearchToNearestMatch(sidebar);
    }
    closeSidebarSearchBar(sidebar, false);
    return { type: "handled" };
  }

  if (key.type === "backspace") {
    if (search.barCursorPos > 0) {
      replaceSidebarSearchBarInput(
        sidebar,
        search.barInput.slice(0, search.barCursorPos - 1) + search.barInput.slice(search.barCursorPos),
        search.barCursorPos - 1,
      );
    } else if (search.barInput.length === 0) {
      closeSidebarSearchBar(sidebar, true);
    }
    return { type: "handled" };
  }

  if (key.type === "delete") {
    if (search.barCursorPos < search.barInput.length) {
      replaceSidebarSearchBarInput(
        sidebar,
        search.barInput.slice(0, search.barCursorPos) + search.barInput.slice(search.barCursorPos + 1),
        search.barCursorPos,
      );
    }
    return { type: "handled" };
  }

  if (key.type === "left") {
    if (search.barCursorPos > 0) search.barCursorPos--;
    return { type: "handled" };
  }

  if (key.type === "right") {
    if (search.barCursorPos < search.barInput.length) search.barCursorPos++;
    return { type: "handled" };
  }

  if (key.type === "home") {
    search.barCursorPos = 0;
    return { type: "handled" };
  }

  if (key.type === "end") {
    search.barCursorPos = search.barInput.length;
    return { type: "handled" };
  }

  if (key.type === "paste" && key.text) {
    insertIntoSidebarSearchBar(sidebar, normalizeSidebarSearchPaste(key.text));
    return { type: "handled" };
  }

  if (key.type === "char" && key.char) {
    insertIntoSidebarSearchBar(sidebar, key.char);
    return { type: "handled" };
  }

  return { type: "handled" };
}

export function getSidebarSearchBarViewport(
  search: SidebarSearchState,
  width: number,
): { line: string; cursorCol: number } {
  const prompt = search.barMode === "command"
    ? ":"
    : (search.direction === "forward" ? "/" : "?");
  const placeholder = search.barMode === "command" ? "command" : "search";
  const maxWidth = Math.max(0, width - 2);
  const viewport = getViewportByWidth(search.barInput, search.barCursorPos, maxWidth);
  const visibleText = viewport.visibleText;
  const displayText = visibleText ? padRightToWidth(visibleText, maxWidth) : padRightToWidth(placeholder, maxWidth);
  const textStyle = visibleText ? theme.text : theme.dim;

  return {
    line: theme.sidebarBg
      + theme.accent + prompt
      + theme.text + " "
      + textStyle + displayText,
    cursorCol: 2 + viewport.cursorCol,
  };
}
