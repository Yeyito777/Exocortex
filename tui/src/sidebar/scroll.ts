import type { Action } from "../keybinds";
import {
  clampViewStart,
  ensureCursorRowVisibleInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
  scrollWithCursorInViewport,
} from "../viewportscroll";
import {
  buildDisplayRows,
  nearestDisplayEntry,
  sidebarListRows,
  snapSidebarViewStartToEntry,
} from "./rows";
import { focusSidebarItem, selectedDisplayRow } from "./selection";
import type { SidebarState } from "./state";

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
  previousViewStart: number,
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
  let finalViewStart = snappedViewStart;

  // If the old viewport began with a section label (e.g. "Pinned"), the selected
  // item's terminal row is one lower than its row among selectable entries. When
  // scrolling down out of that labeled section, preserve the selectable-entry slot
  // instead of the raw terminal row: the first pinned conversation should become
  // the first visible conversation, not remain one row below the top after the
  // label scrolls away.
  if (direction > 0
      && displayRows[previousViewStart]?.type === "label"
      && previousCursorRow > previousViewStart
      && previousCursorRow < previousViewStart + listRows) {
    const previousSelectableSlot = previousCursorRow - previousViewStart - 1;
    finalViewStart = clampViewStart(displayRows.length, listRows, actualCursorRow - previousSelectableSlot);
  }

  const visible = ensureCursorRowVisibleInViewport({
    totalLines: displayRows.length,
    viewportHeight: listRows,
    viewStart: finalViewStart,
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
    currentViewStart,
    currentCursorRow,
    sidebarScrollDirection(action),
    action === "scroll_page_down" ? "top" : action === "scroll_page_up" ? "bottom" : null,
  );
  return true;
}

/** Scroll the sidebar list by a number of entries (positive = down, negative = up). */
export function scrollSidebar(sidebar: SidebarState, delta: number): void {
  const maxOffset = Math.max(0, buildDisplayRows(sidebar).length - 1);
  sidebar.scrollOffset = Math.max(0, Math.min(sidebar.scrollOffset + delta, maxOffset));
}
