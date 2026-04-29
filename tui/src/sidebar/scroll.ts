import type { Action } from "../keybinds";
import type { SidebarItemRef } from "../messages";
import {
  clampViewStart,
  ensureCursorRowVisibleInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
  scrollWithCursorInViewport,
} from "../viewportscroll";
import { sameSidebarItem as sameItem } from "./items";
import {
  buildDisplayRows,
  findDisplayEntry,
  nearestDisplayEntry,
  sidebarListRows,
  snapSidebarViewStartToEntry,
} from "./rows";
import { focusSidebarItem, selectedDisplayRow } from "./selection";
import type { SidebarState } from "./state";

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

function sidebarScrollDirection(action: Action): -1 | 0 | 1 {
  switch (action) {
    case "scroll_line_down":
    case "scroll_half_down":
    case "scroll_page_down":
    case "scroll_bottom":
      return 1;
    case "scroll_line_up":
    case "scroll_half_up":
    case "scroll_page_up":
    case "scroll_top":
      return -1;
    default:
      return 0;
  }
}

function applySidebarCursorViewport(
  sidebar: SidebarState,
  totalRows: number,
  cursorRow: number,
  viewStart: number,
  previousCursorRow: number,
  direction: -1 | 0 | 1,
  edgePlacement: "top" | "bottom" | null = null,
): void {
  const displayRows = buildDisplayRows(sidebar);
  const listRows = sidebarListRows(totalRows, sidebar);
  if (displayRows.length === 0 || listRows <= 0) return;

  const snappedViewStart = snapSidebarViewStartToEntry(displayRows, listRows, viewStart, direction);
  const edgeCursorRow = edgePlacement === "top"
    ? snappedViewStart
    : edgePlacement === "bottom"
      ? snappedViewStart + listRows - 1
      : cursorRow;
  const preferredStep = edgeCursorRow < previousCursorRow ? -1 : edgeCursorRow > previousCursorRow ? 1 : 0;
  const target = nearestDisplayEntry(displayRows, edgeCursorRow, preferredStep);
  if (target == null) return;

  focusSidebarItem(sidebar, target);

  // Keep the shared scroll result, then re-run the shared visibility clamp using
  // the actual entry row we landed on (labels/delimiters are skipped by selection).
  const actualCursorRow = selectedDisplayRow(displayRows, sidebar);
  const visible = ensureCursorRowVisibleInViewport({
    totalLines: displayRows.length,
    viewportHeight: listRows,
    viewStart: snappedViewStart,
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
      next = scrollPageWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, 1);
      break;
    case "scroll_page_down":
      next = scrollPageWithCursorInViewport({
        totalLines: displayRows.length,
        viewportHeight: listRows,
        viewStart: currentViewStart,
        cursorRow: currentCursorRow,
      }, -1);
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

  applySidebarCursorViewport(
    sidebar,
    totalRows,
    next.cursorRow,
    next.viewStart,
    currentCursorRow,
    sidebarScrollDirection(action),
    action === "scroll_page_down" ? "top" : action === "scroll_page_up" ? "bottom" : null,
  );
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
    let target: SidebarItemRef | { type: "up" } | null = findDisplayEntry(displayRows, viewStart, viewEnd, 1);
    if (target == null) return;

    if (sameItem(sidebar.selectedItem, target)) {
      const halfPage = Math.floor(listRows / 2);
      sidebar.scrollOffset = Math.max(0, sidebar.scrollOffset - halfPage);
      const nextEnd = Math.min(sidebar.scrollOffset + listRows - 1, displayRows.length - 1);
      target = findDisplayEntry(displayRows, sidebar.scrollOffset, nextEnd, 1);
      if (target == null) return;
    }

    focusSidebarItem(sidebar, target);
  } else {
    let target: SidebarItemRef | { type: "up" } | null = findDisplayEntry(displayRows, viewEnd, viewStart, -1);
    if (target == null) return;

    if (sameItem(sidebar.selectedItem, target)) {
      const halfPage = Math.floor(listRows / 2);
      sidebar.scrollOffset = Math.min(maxScroll, sidebar.scrollOffset + halfPage);
      const nextEnd = Math.min(sidebar.scrollOffset + listRows - 1, displayRows.length - 1);
      target = findDisplayEntry(displayRows, nextEnd, sidebar.scrollOffset, -1);
      if (target == null) return;
    }

    focusSidebarItem(sidebar, target);
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

  focusSidebarItem(sidebar, target);
  sidebar.pendingDeleteId = null;
}

/** Scroll the sidebar list by a number of entries (positive = down, negative = up). */
export function scrollSidebar(sidebar: SidebarState, delta: number): void {
  const maxOffset = Math.max(0, buildDisplayRows(sidebar).length - 1);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset + delta, maxOffset));
}
