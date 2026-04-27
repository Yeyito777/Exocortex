/**
 * Conversations sidebar.
 *
 * Owns the sidebar state, key handling, and rendering.
 * The only file that knows how to display the sidebar.
 */

import type { KeyEvent } from "./input";
import type { ConversationSummary } from "./messages";
import { sortConversations, bottomPinnedOrder, topUnpinnedOrder } from "./messages";
import type { Action } from "./keybinds";
import { resolveAction } from "./keybinds";
import {
  clampViewStart,
  ensureCursorRowVisibleInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollWithCursorInViewport,
} from "./viewportscroll";
import { theme } from "./theme";
import { getMarkFromTitle, toggleMark } from "./marks";
import { padRightToWidth, termWidth, truncateToWidth } from "./textwidth";
import type { SidebarSearchState } from "./sidebarsearch";
import {
  focusConversationAt as focusSidebarConversationAt,
  focusConversationById as focusSidebarConversationById,
  focusNearestVisibleConversation,
  getActiveSidebarSearchQuery,
  getSearchableConversationTitle,
  getSelectedVisibleConversation,
  getSidebarSearchBarViewport,
  getVisibleConversationIndices,
  getVisibleConversationIndicesForQuery,
} from "./sidebarsearch";

// ── Constants ───────────────────────────────────────────────────────

export const SIDEBAR_WIDTH = 28;

// ── State ───────────────────────────────────────────────────────────

export interface SidebarState {
  open: boolean;
  conversations: ConversationSummary[];
  selectedId: string | null;
  previousEnteredId: string | null;
  selectedIndex: number;
  scrollOffset: number;
  pendingDeleteId: string | null;
  search: SidebarSearchState | null;
}

export function createSidebarState(): SidebarState {
  return {
    open: false,
    conversations: [],
    selectedId: null,
    previousEnteredId: null,
    selectedIndex: 0,
    scrollOffset: 0,
    pendingDeleteId: null,
    search: null,
  };
}

// ── Selection helpers ───────────────────────────────────────────────

export function focusConversationAt(sidebar: SidebarState, index: number): void {
  focusSidebarConversationAt(sidebar, index);
}

export function focusConversationById(sidebar: SidebarState, convId: string): boolean {
  return focusSidebarConversationById(sidebar, convId);
}

/** Remember the last conversation the user actually entered/loaded. */
export function rememberEnteredConversation(
  sidebar: SidebarState,
  currentConvId: string | null,
  nextConvId: string | null,
): void {
  if (currentConvId && currentConvId !== nextConvId) {
    sidebar.previousEnteredId = currentConvId;
  }
}

export function focusPreviousEnteredConversation(sidebar: SidebarState): boolean {
  if (!sidebar.previousEnteredId) return false;
  return focusConversationById(sidebar, sidebar.previousEnteredId);
}

function truncateSidebarTitle(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth);
}

// ── Key handling ────────────────────────────────────────────────────

export type SidebarKeyResult =
  | { type: "handled" }
  | { type: "select"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "rename_conversation"; convId: string; title: string }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "clone_conversation"; convId: string }
  | { type: "unhandled" };

export function handleSidebarKey(key: KeyEvent, sidebar: SidebarState): SidebarKeyResult {
  const action = resolveAction(key, "navigation");
  if (!action) return { type: "handled" };
  return handleSidebarAction(action, sidebar);
}

/** Handle sidebar actions that depend on the current viewport height. */
export function handleSidebarViewportAction(action: Action | null, sidebar: SidebarState, totalRows: number): boolean {
  if (!action) return false;

  switch (action) {
    case "sidebar_visible_top":
      jumpSidebarSelectionToVisibleEdge(sidebar, totalRows, "top");
      return true;
    case "sidebar_visible_middle":
      jumpSidebarSelectionToVisibleMiddle(sidebar, totalRows);
      return true;
    case "sidebar_visible_bottom":
      jumpSidebarSelectionToVisibleEdge(sidebar, totalRows, "bottom");
      return true;
    default:
      return false;
  }
}

/** Handle a semantic action on the sidebar — used by both key handler and vim. */
export function handleSidebarAction(action: string, sidebar: SidebarState): SidebarKeyResult {
  // Any action that isn't "delete" clears the pending delete
  if (action !== "delete") {
    sidebar.pendingDeleteId = null;
  }

  switch (action) {
    case "nav_down":
    case "cursor_down":
      moveSelection(sidebar, 1);
      return { type: "handled" };

    case "nav_up":
    case "cursor_up":
      moveSelection(sidebar, -1);
      return { type: "handled" };

    case "nav_select":
    case "submit": {
      const selectedConv = getSelectedVisibleConversation(sidebar);
      if (selectedConv) {
        return { type: "select", convId: selectedConv.id };
      }
      return { type: "handled" };
    }

    case "delete": {
      const selectedConv = getSelectedVisibleConversation(sidebar);
      if (!selectedConv) return { type: "handled" };

      if (sidebar.pendingDeleteId === selectedConv.id) {
        // Second d — confirm deletion
        sidebar.pendingDeleteId = null;
        const deletedIndex = sidebar.selectedIndex;
        sidebar.conversations.splice(deletedIndex, 1);
        // Follow the next visible conversation in the filtered view when possible,
        // clamping to the last remaining visible match when deleting the tail.
        focusNearestVisibleConversation(sidebar, deletedIndex);
        return { type: "delete_conversation", convId: selectedConv.id };
      }

      // First d — mark for deletion
      sidebar.pendingDeleteId = selectedConv.id;
      return { type: "handled" };
    }

    case "undo_delete":
      return { type: "undo_delete" };

    case "clone": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      return { type: "clone_conversation", convId: conv.id };
    }

    case "mark": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      const newMarked = !conv.marked;
      conv.marked = newMarked;
      return { type: "mark_conversation", convId: conv.id, marked: newMarked };
    }

    case "pin": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      const newPinned = !conv.pinned;
      conv.pinned = newPinned;
      // Compute the sortOrder the daemon will assign so the optimistic
      // sort matches the authoritative order and avoids a visible snap.
      conv.sortOrder = newPinned
        ? bottomPinnedOrder(sidebar.conversations, conv.id)
        : topUnpinnedOrder(sidebar.conversations, conv.id);
      sortConversations(sidebar.conversations);
      syncSelectedIndex(sidebar);
      return { type: "pin_conversation", convId: conv.id, pinned: newPinned };
    }

    case "move_up":
    case "move_down": {
      const conv = getSelectedVisibleConversation(sidebar);
      if (!conv) return { type: "handled" };
      const direction = action === "move_up" ? "up" : "down";
      const targetIdx = direction === "up"
        ? sidebar.selectedIndex - 1
        : sidebar.selectedIndex + 1;
      if (targetIdx < 0 || targetIdx >= sidebar.conversations.length) return { type: "handled" };
      const target = sidebar.conversations[targetIdx];
      // Don't cross the pinned/unpinned boundary
      if (target.pinned !== conv.pinned) return { type: "handled" };
      // Optimistic swap
      sidebar.conversations[sidebar.selectedIndex] = target;
      sidebar.conversations[targetIdx] = conv;
      // Swap sortOrder values
      const tmp = conv.sortOrder;
      conv.sortOrder = target.sortOrder;
      target.sortOrder = tmp;
      // If sortOrders were equal the swap is a no-op — differentiate them
      if (conv.sortOrder === target.sortOrder) {
        if (direction === "up") {
          conv.sortOrder -= 0.5;
        } else {
          conv.sortOrder += 0.5;
        }
      }
      // Follow the moved item
      focusConversationAt(sidebar, targetIdx);
      return { type: "move_conversation", convId: conv.id, direction };
    }

    case "nav_next_streaming":
      moveToStreaming(sidebar, 1);
      return { type: "handled" };

    case "nav_prev_streaming":
      moveToStreaming(sidebar, -1);
      return { type: "handled" };

    case "nav_next_marked":
      moveToMarked(sidebar, 1);
      return { type: "handled" };

    case "nav_prev_marked":
      moveToMarked(sidebar, -1);
      return { type: "handled" };

    case "focus_prompt":
      return { type: "unhandled" };

    default:
      return { type: "handled" };
  }
}

export function moveSelection(sidebar: SidebarState, delta: number): void {
  const visible = getVisibleConversationIndices(sidebar);
  if (visible.length === 0) return;

  const currentVisibleIndex = visible.indexOf(sidebar.selectedIndex);
  if (currentVisibleIndex === -1) {
    focusConversationAt(sidebar, delta >= 0 ? visible[0] : visible[visible.length - 1]);
    return;
  }

  const nextVisibleIndex = Math.max(0, Math.min(currentVisibleIndex + delta, visible.length - 1));
  focusConversationAt(sidebar, visible[nextVisibleIndex]);
}

/** Jump to the next (delta=1) or previous (delta=-1) conversation with a streaming indicator, wrapping around. */
function moveToStreaming(sidebar: SidebarState, delta: 1 | -1): void {
  const len = sidebar.conversations.length;
  if (len === 0) return;
  for (let step = 1; step < len; step++) {
    const idx = ((sidebar.selectedIndex + delta * step) % len + len) % len;
    const conv = sidebar.conversations[idx];
    if (conv.streaming || conv.unread) {
      focusConversationAt(sidebar, idx);
      return;
    }
  }
}

/** Jump to the next (delta=1) or previous (delta=-1) boolean-marked conversation, wrapping around. */
function moveToMarked(sidebar: SidebarState, delta: 1 | -1): void {
  const len = sidebar.conversations.length;
  if (len === 0) return;
  for (let step = 1; step < len; step++) {
    const idx = ((sidebar.selectedIndex + delta * step) % len + len) % len;
    if (sidebar.conversations[idx]?.marked) {
      focusConversationAt(sidebar, idx);
      return;
    }
  }
}

// ── Emoji marks ────────────────────────────────────────────────────

/**
 * Toggle an emoji mark on the selected conversation.
 * key 1-9 sets (or toggles off) the corresponding mark.
 * key 0 clears any mark.
 */
export function handleSidebarMark(sidebar: SidebarState, key: number): SidebarKeyResult {
  const conv = getSelectedVisibleConversation(sidebar);
  if (!conv) return { type: "handled" };

  const newTitle = toggleMark(conv.title, key);
  if (newTitle === conv.title) return { type: "handled" };

  // Optimistic update
  conv.title = newTitle;
  return { type: "rename_conversation", convId: conv.id, title: newTitle };
}

// ── State updates ───────────────────────────────────────────────────

export function updateConversationList(sidebar: SidebarState, conversations: ConversationSummary[]): void {
  sidebar.conversations = conversations;
  syncSelectedIndex(sidebar);
}

export function updateConversation(sidebar: SidebarState, summary: ConversationSummary): void {
  const idx = sidebar.conversations.findIndex(c => c.id === summary.id);
  if (idx !== -1) {
    sidebar.conversations[idx] = summary;
  } else {
    sidebar.conversations.unshift(summary);
  }
  sortConversations(sidebar.conversations);
  syncSelectedIndex(sidebar);
}

/** Resolve selectedId → selectedIndex after list changes. */
export function syncSelectedIndex(sidebar: SidebarState): void {
  const activeFilterQuery = getActiveSidebarSearchQuery(sidebar);
  const visible = getVisibleConversationIndicesForQuery(sidebar, activeFilterQuery);

  if (sidebar.selectedId) {
    const idx = sidebar.conversations.findIndex(c => c.id === sidebar.selectedId);
    if (idx !== -1 && (!activeFilterQuery || visible.includes(idx) || visible.length === 0)) {
      sidebar.selectedIndex = idx;
      return;
    }
  }

  if (activeFilterQuery && visible.length > 0) {
    focusConversationAt(sidebar, visible[0]);
    return;
  }

  // selectedId not found — default to the first non-pinned conversation
  // so the cursor lands in the active (unpinned) section, not on a pinned item.
  const firstUnpinned = sidebar.conversations.findIndex(c => !c.pinned);
  if (firstUnpinned !== -1) {
    focusConversationAt(sidebar, firstUnpinned);
  } else {
    // All pinned (or empty) — fall back to clamped index
    focusConversationAt(sidebar, sidebar.selectedIndex);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Pad or truncate a string to exactly `width` terminal columns. */
function pad(text: string, width: number): string {
  return padRightToWidth(text, width);
}

// ── Display row layout ─────────────────────────────────────────────

export interface DisplayRow {
  type: "label" | "delimiter" | "entry";
  convIdx?: number;
  text?: string;
}

/**
 * Build the flat list of display rows from the conversation list.
 * Used by both rendering and mouse hit-testing so the layout is
 * defined in one place.
 */
export function buildDisplayRows(sidebar: SidebarState): DisplayRow[] {
  const visibleIndices = getVisibleConversationIndices(sidebar);
  const pinnedIndices = visibleIndices.filter(index => sidebar.conversations[index]?.pinned);
  const unpinnedIndices = visibleIndices.filter(index => !sidebar.conversations[index]?.pinned);
  const rows: DisplayRow[] = [];

  if (pinnedIndices.length > 0) {
    rows.push({ type: "label", text: " Pinned" });
    for (const convIdx of pinnedIndices) {
      rows.push({ type: "entry", convIdx });
    }
    if (unpinnedIndices.length > 0) rows.push({ type: "delimiter" });
  }
  for (const convIdx of unpinnedIndices) {
    rows.push({ type: "entry", convIdx });
  }

  return rows;
}

export function sidebarListRows(totalRows: number, sidebar: SidebarState): number {
  const searchBarRows = sidebar.search?.barOpen ? 1 : 0;
  return Math.max(0, totalRows - 2 - searchBarRows);
}

function findDisplayEntry(
  displayRows: DisplayRow[],
  start: number,
  end: number,
  step: 1 | -1,
): number | null {
  for (let row = start; step > 0 ? row <= end : row >= end; row += step) {
    if (displayRows[row]?.type === "entry") return displayRows[row].convIdx ?? null;
  }
  return null;
}

function selectedDisplayRow(displayRows: DisplayRow[], sidebar: SidebarState): number {
  const row = displayRows.findIndex((dr) => dr.type === "entry" && dr.convIdx === sidebar.selectedIndex);
  if (row !== -1) return row;
  const firstEntry = displayRows.findIndex((dr) => dr.type === "entry");
  return firstEntry === -1 ? 0 : firstEntry;
}

function nearestDisplayEntry(
  displayRows: DisplayRow[],
  targetRow: number,
  preferredStep: -1 | 0 | 1,
): number | null {
  const clampedTarget = Math.max(0, Math.min(targetRow, Math.max(0, displayRows.length - 1)));
  if (displayRows[clampedTarget]?.type === "entry") return displayRows[clampedTarget].convIdx ?? null;

  const scan = (step: 1 | -1): number | null => {
    for (let row = clampedTarget + step; row >= 0 && row < displayRows.length; row += step) {
      if (displayRows[row]?.type === "entry") return displayRows[row].convIdx ?? null;
    }
    return null;
  };

  if (preferredStep < 0) return scan(-1) ?? scan(1);
  if (preferredStep > 0) return scan(1) ?? scan(-1);
  return scan(1) ?? scan(-1);
}

function applySidebarCursorViewport(
  sidebar: SidebarState,
  totalRows: number,
  cursorRow: number,
  viewStart: number,
  previousCursorRow: number,
): void {
  const displayRows = buildDisplayRows(sidebar);
  const listRows = sidebarListRows(totalRows, sidebar);
  if (displayRows.length === 0 || listRows <= 0) return;

  const preferredStep = cursorRow < previousCursorRow ? -1 : cursorRow > previousCursorRow ? 1 : 0;
  const target = nearestDisplayEntry(displayRows, cursorRow, preferredStep);
  if (target == null) return;

  focusConversationAt(sidebar, target);

  // Keep the shared scroll result, then re-run the shared visibility clamp using
  // the actual entry row we landed on (labels/delimiters are skipped by selection).
  const actualCursorRow = selectedDisplayRow(displayRows, sidebar);
  const visible = ensureCursorRowVisibleInViewport({
    totalLines: displayRows.length,
    viewportHeight: listRows,
    viewStart,
    cursorRow: actualCursorRow,
  });
  sidebar.scrollOffset = visible.viewStart;
  sidebar.pendingDeleteId = null;
}

/**
 * Apply the same cursor-aware Ctrl+E/Y/D/U/F/B scrolling used by chat history to
 * the conversations sidebar. The sidebar adapts its selected conversation to the
 * shared "cursor row" abstraction, skipping over section labels/delimiters.
 */
export function handleSidebarScrollAction(action: Action, sidebar: SidebarState, totalRows: number): boolean {
  const displayRows = buildDisplayRows(sidebar);
  const listRows = sidebarListRows(totalRows, sidebar);
  if (displayRows.length === 0 || listRows <= 0) return true;

  const currentCursorRow = selectedDisplayRow(displayRows, sidebar);
  const currentViewStart = clampViewStart(displayRows.length, listRows, sidebar.scrollOffset);
  let next: { viewStart: number; cursorRow: number } | null = null;

  switch (action) {
    case "scroll_line_up":
      next = scrollLineWithStickyCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, 1);
      break;
    case "scroll_line_down":
      next = scrollLineWithStickyCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, -1);
      break;
    case "scroll_half_up":
      next = scrollWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, 1, Math.floor(listRows / 2));
      break;
    case "scroll_half_down":
      next = scrollWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, -1, Math.floor(listRows / 2));
      break;
    case "scroll_page_up":
      next = scrollWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, 1, listRows);
      break;
    case "scroll_page_down":
      next = scrollWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, -1, listRows);
      break;
    case "scroll_top":
      next = { viewStart: 0, cursorRow: 0 };
      break;
    case "scroll_bottom":
      next = { viewStart: Math.max(0, displayRows.length - listRows), cursorRow: displayRows.length - 1 };
      break;
    default:
      return false;
  }

  applySidebarCursorViewport(sidebar, totalRows, next.cursorRow, next.viewStart, currentCursorRow);
  return true;
}

/** Vim-like H/L for the sidebar — jump to the top/bottom visible conversation. */
export function jumpSidebarSelectionToVisibleEdge(
  sidebar: SidebarState,
  totalRows: number,
  edge: "top" | "bottom",
): void {
  const displayRows = buildDisplayRows(sidebar);
  const listRows = sidebarListRows(totalRows, sidebar);
  if (displayRows.length === 0 || listRows <= 0) return;

  const maxScroll = Math.max(0, displayRows.length - listRows);
  if (sidebar.scrollOffset > maxScroll) sidebar.scrollOffset = maxScroll;

  const viewStart = sidebar.scrollOffset;
  const viewEnd = Math.min(viewStart + listRows - 1, displayRows.length - 1);

  if (edge === "top") {
    let target = findDisplayEntry(displayRows, viewStart, viewEnd, 1);
    if (target == null) return;

    if (sidebar.selectedIndex === target) {
      const halfPage = Math.floor(listRows / 2);
      sidebar.scrollOffset = Math.max(0, sidebar.scrollOffset - halfPage);
      const nextEnd = Math.min(sidebar.scrollOffset + listRows - 1, displayRows.length - 1);
      target = findDisplayEntry(displayRows, sidebar.scrollOffset, nextEnd, 1);
      if (target == null) return;
    }

    focusConversationAt(sidebar, target);
  } else {
    let target = findDisplayEntry(displayRows, viewEnd, viewStart, -1);
    if (target == null) return;

    if (sidebar.selectedIndex === target) {
      const halfPage = Math.floor(listRows / 2);
      sidebar.scrollOffset = Math.min(maxScroll, sidebar.scrollOffset + halfPage);
      const nextEnd = Math.min(sidebar.scrollOffset + listRows - 1, displayRows.length - 1);
      target = findDisplayEntry(displayRows, nextEnd, sidebar.scrollOffset, -1);
      if (target == null) return;
    }

    focusConversationAt(sidebar, target);
  }

  sidebar.pendingDeleteId = null;
}

/** Vim-like M for the sidebar — jump to the middle visible conversation. */
export function jumpSidebarSelectionToVisibleMiddle(sidebar: SidebarState, totalRows: number): void {
  const displayRows = buildDisplayRows(sidebar);
  const listRows = sidebarListRows(totalRows, sidebar);
  if (displayRows.length === 0 || listRows <= 0) return;

  const maxScroll = Math.max(0, displayRows.length - listRows);
  if (sidebar.scrollOffset > maxScroll) sidebar.scrollOffset = maxScroll;

  const viewStart = sidebar.scrollOffset;
  const viewEnd = Math.min(viewStart + listRows - 1, displayRows.length - 1);
  const midRow = Math.floor((viewStart + viewEnd) / 2);

  let target = findDisplayEntry(displayRows, midRow, viewEnd, 1);
  if (target == null) {
    target = findDisplayEntry(displayRows, midRow - 1, viewStart, -1);
  }
  if (target == null) return;

  focusConversationAt(sidebar, target);
  sidebar.pendingDeleteId = null;
}

// ── Mouse support ──────────────────────────────────────────────────

/**
 * Hit-test a screen row click to find which conversation index was clicked.
 * Returns the convs[] index, or null if the click was on a non-entry row
 * (header, separator, label, delimiter, or out of bounds).
 *
 * @param screenRow 1-based screen row
 * @param sidebar current sidebar state
 */
export function sidebarHitTest(screenRow: number, totalRows: number, sidebar: SidebarState): number | null {
  // Rows 1-2 are header and separator — not clickable
  if (screenRow <= 2) return null;
  // Bottom row is reserved for the search/command bar while open.
  if (sidebar.search?.barOpen && screenRow === totalRows) return null;

  const displayRows = buildDisplayRows(sidebar);

  // Screen row 3 = display row at scrollOffset
  const displayIdx = (screenRow - 3) + sidebar.scrollOffset;
  if (displayIdx < 0 || displayIdx >= displayRows.length) return null;

  const dr = displayRows[displayIdx];
  if (dr.type !== "entry") return null;
  return dr.convIdx!;
}

/** Scroll the sidebar list by a number of entries (positive = down, negative = up). */
export function scrollSidebar(sidebar: SidebarState, delta: number): void {
  const maxOffset = Math.max(0, buildDisplayRows(sidebar).length - 1);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset + delta, maxOffset));
}

// ── Rendering ───────────────────────────────────────────────────────

export function renderSidebar(
  sidebar: SidebarState,
  totalRows: number,
  focused: boolean,
  currentConvId: string | null,
): string[] {
  const rows: string[] = [];
  const innerWidth = SIDEBAR_WIDTH - 1; // -1 for right border │
  const borderFg = focused ? theme.borderFocused : theme.borderUnfocused;
  const borderBg = theme.appBg ?? '';

  // Row 1: header
  const header = " Conversations";
  rows.push(
    theme.sidebarBg + theme.text + theme.bold + pad(header, innerWidth)
    + theme.reset + borderBg + borderFg + "│" + theme.reset,
  );

  // Row 2: separator with ┤ junction
  rows.push(
    theme.sidebarBg + borderFg +
    "─".repeat(innerWidth) + borderBg + "┤" + theme.reset,
  );

  // Build display rows: section labels + delimiter + conversation entries
  const convs = sidebar.conversations;
  const displayRows = buildDisplayRows(sidebar);

  // Map selectedIndex (into convs[]) to display row index for scroll tracking
  let selectedDisplayIdx = 0;
  for (let di = 0; di < displayRows.length; di++) {
    if (displayRows[di].type === "entry" && displayRows[di].convIdx === sidebar.selectedIndex) {
      selectedDisplayIdx = di;
      break;
    }
  }

  const listRows = sidebarListRows(totalRows, sidebar);
  let scrollOffset = sidebar.scrollOffset;
  if (selectedDisplayIdx < scrollOffset) {
    scrollOffset = selectedDisplayIdx;
  } else if (selectedDisplayIdx >= scrollOffset + listRows) {
    scrollOffset = selectedDisplayIdx - listRows + 1;
  }
  scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, displayRows.length - listRows)));
  sidebar.scrollOffset = scrollOffset;

  for (let i = 0; i < listRows; i++) {
    const di = scrollOffset + i;

    if (di >= displayRows.length) {
      // Empty row
      rows.push(
        theme.sidebarBg +
        " ".repeat(innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    const dr = displayRows[di];

    if (dr.type === "label") {
      rows.push(
        theme.sidebarBg + theme.text + theme.bold +
        pad(dr.text!, innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    if (dr.type === "delimiter") {
      rows.push(
        theme.sidebarBg + theme.muted +
        pad(" " + "─".repeat(innerWidth - 2) + " ", innerWidth) +
        theme.reset + borderBg + borderFg + "│" + theme.reset,
      );
      continue;
    }

    // Entry row
    const ci = dr.convIdx!;
    const conv = convs[ci];
    const isSelected = ci === sidebar.selectedIndex;
    const isCurrent = conv.id === currentConvId;
    const isPendingDelete = conv.id === sidebar.pendingDeleteId;

    // Streaming/unread indicator
    const streamIcon = conv.streaming ? "◉ " : conv.unread ? "◉ " : "";
    const streamIconColor = conv.streaming ? theme.accent : conv.unread ? theme.success : "";

    const prefix = isSelected ? "▸ " : "  ";

    // Star (★) from the boolean `marked` flag — independent of emoji marks
    const starIcon = conv.marked ? "★ " : "";

    // Emoji mark: extracted from title prefix (e.g. "🕐 my convo" → "🕐")
    const mark = getMarkFromTitle(conv.title);
    const emojiIcon = mark ? mark.emoji + " " : "";

    const iconsWidth = termWidth(starIcon) + termWidth(emojiIcon);
    const prefixWidth = termWidth(prefix) + termWidth(streamIcon) + iconsWidth;
    const maxTitle = Math.max(0, innerWidth - prefixWidth);
    const searchableTitle = getSearchableConversationTitle(conv);
    const title = truncateSidebarTitle(searchableTitle || "(empty)", maxTitle);

    const bg = isSelected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = isPendingDelete ? theme.error : (isSelected || isCurrent) ? theme.text : theme.muted;
    const paddedTitle = padRightToWidth(title, maxTitle);
    const titleText = isCurrent && !isPendingDelete ? theme.bold + paddedTitle + theme.boldOff : paddedTitle;
    const streamIconColored = streamIcon ? streamIconColor + streamIcon + fg : "";
    const starIconColored = starIcon ? theme.warning + starIcon + fg : "";
    const emojiIconColored = emojiIcon ? theme.warning + emojiIcon + fg : "";

    rows.push(
      theme.reset + bg + fg +
      prefix + streamIconColored + starIconColored + emojiIconColored + titleText +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  if (sidebar.search?.barOpen) {
    const { line } = getSidebarSearchBarViewport(sidebar.search, innerWidth);
    rows.push(
      line +
      theme.reset + borderBg + borderFg + "│" + theme.reset,
    );
  }

  return rows;
}
