import type { SidebarSelectableItem } from "./items";
import { buildDisplayRows, sidebarListRows } from "./rows";
import type { SidebarState } from "./state";

/**
 * Hit-test a screen row click to find which sidebar item was clicked.
 * Returns null for non-entry rows (header, separator, label, delimiter, or out
 * of bounds).
 *
 * @param screenRow 1-based screen row
 * @param sidebar current sidebar state
 */
export function sidebarHitTest(screenRow: number, totalRows: number, sidebar: SidebarState): SidebarSelectableItem | null {
  // Rows 1-2 are header and separator — not clickable
  if (screenRow <= 2) return null;
  // Exclude all footer / editing rows, even when entries overflow the viewport.
  if (screenRow > 2 + sidebarListRows(totalRows, sidebar)) return null;

  const displayRows = buildDisplayRows(sidebar);

  // Screen row 3 = display row at scrollOffset
  const displayIdx = (screenRow - 3) + sidebar.scrollOffset;
  if (displayIdx < 0 || displayIdx >= displayRows.length) return null;

  const dr = displayRows[displayIdx];
  if (dr.type !== "entry") return null;
  return dr.item ?? null;
}
