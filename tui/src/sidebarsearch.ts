/**
 * Sidebar conversation search.
 *
 * Implements vim-style / and ? search over conversation titles, filtering the
 * visible sidebar list down to matches until :noh clears highlights.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
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
  savedScrollOffset: number;
}

export interface SidebarSearchableState {
  conversations: ConversationSummary[];
  selectedId: string | null;
  selectedIndex: number;
  scrollOffset: number;
  pendingDeleteId: string | null;
  search: SidebarSearchState | null;
}

export function focusConversationAt(sidebar: SidebarSearchableState, index: number): void {
  if (sidebar.conversations.length === 0) {
    sidebar.selectedIndex = 0;
    sidebar.selectedId = null;
    return;
  }

  const nextIndex = Math.max(0, Math.min(index, sidebar.conversations.length - 1));
  const nextId = sidebar.conversations[nextIndex]?.id ?? null;
  sidebar.selectedIndex = nextIndex;
  sidebar.selectedId = nextId;
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

export function getVisibleConversationIndicesForQuery(
  sidebar: Pick<SidebarSearchableState, "conversations">,
  query: string | null,
): number[] {
  if (!query) return sidebar.conversations.map((_, index) => index);

  const visible: number[] = [];
  for (let i = 0; i < sidebar.conversations.length; i++) {
    if (findAllCaseInsensitiveMatchStarts(getSearchableConversationTitle(sidebar.conversations[i]), query).length > 0) {
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
  sidebar: Pick<SidebarSearchableState, "conversations" | "search">,
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
    savedScrollOffset: sidebar.scrollOffset,
  };
}

function findNextConversationMatch(
  sidebar: Pick<SidebarSearchableState, "conversations">,
  query: string,
  fromIndex: number,
  direction: SidebarSearchDirection,
): number | null {
  return findNextSortedMatch(getVisibleConversationIndicesForQuery(sidebar, query), fromIndex, direction);
}

function getSavedSearchStartIndex(sidebar: SidebarSearchableState, search: SidebarSearchState): number {
  if (sidebar.conversations.length === 0) return 0;
  if (search.savedSelectedId) {
    const idx = sidebar.conversations.findIndex(conv => conv.id === search.savedSelectedId);
    if (idx !== -1) return idx;
  }
  return Math.max(0, Math.min(search.savedSelectedIndex, sidebar.conversations.length - 1));
}

function restoreSidebarSearchOrigin(sidebar: SidebarSearchableState, search: SidebarSearchState): void {
  sidebar.scrollOffset = search.savedScrollOffset;
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

  const matchIndex = findNextConversationMatch(
    sidebar,
    search.barInput,
    getSavedSearchStartIndex(sidebar, search),
    search.direction,
  );
  if (matchIndex == null) return;

  focusConversationAt(sidebar, matchIndex);
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

function executeSidebarCommand(sidebar: SidebarSearchableState, command: string): void {
  const search = sidebar.search;
  if (!search) return;

  switch (command) {
    case "noh":
      search.highlightsVisible = false;
      break;
    default:
      break;
  }
}

export function openSidebarSearchBar(sidebar: SidebarSearchableState, direction: SidebarSearchDirection): void {
  sidebar.pendingDeleteId = null;
  sidebar.search = buildSidebarSearchState(sidebar, "search", direction);
}

export function openSidebarCommandBar(sidebar: SidebarSearchableState): void {
  sidebar.pendingDeleteId = null;
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

  const matchIndex = findNextConversationMatch(sidebar, search.query, sidebar.selectedIndex, direction);
  if (matchIndex == null) return false;

  search.highlightsVisible = true;
  focusConversationAt(sidebar, matchIndex);
  return true;
}

export function handleSidebarSearchBarKey(
  sidebar: SidebarSearchableState,
  key: KeyEvent,
): SidebarSearchKeyResult {
  const search = sidebar.search;
  if (!search?.barOpen) return { type: "handled" };

  if (key.type === "ctrl-q") return { type: "abort" };

  if (key.type === "escape" || key.type === "ctrl-c") {
    closeSidebarSearchBar(sidebar, true);
    return { type: "handled" };
  }

  if (key.type === "enter") {
    if (search.barMode === "command") {
      executeSidebarCommand(sidebar, search.barInput.trim());
      closeSidebarSearchBar(sidebar, false);
      return { type: "handled" };
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
