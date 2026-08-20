/**
 * State, keyboard handling, and rendering for the conversation-actions menu.
 *
 * The menu is anchored beside the selected conversation in the sidebar, in
 * the same style as Record's server/item action menu.
 */

import type { KeyEvent, MouseEvent } from "../input";
import { moveTo } from "../frame";
import { theme } from "../theme";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { buildDisplayRows } from "./rows";
import type { SidebarState } from "./state";

export type ConversationAction = "copy_id" | "toggle_star" | "toggle_pin" | "delete";

export interface ConversationActionMenuState {
  convId: string;
  marked: boolean;
  pinned: boolean;
  selection: ConversationAction;
  deleteConfirmation: boolean;
}

export type ConversationActionMenuKeyResult =
  | { type: "handled" }
  | { type: "close" }
  | { type: "action"; action: ConversationAction };

const ACTIONS: readonly ConversationAction[] = ["copy_id", "toggle_star", "toggle_pin", "delete"];

interface ConversationActionMenuLayout {
  topRow: number;
  leftCol: number;
  innerWidth: number;
  boxHeight: number;
}

export type ConversationActionMenuHit = ConversationAction | "chrome" | null;

export function createConversationActionMenu(
  convId: string,
  marked: boolean,
  pinned: boolean,
): ConversationActionMenuState {
  return {
    convId,
    marked,
    pinned,
    selection: "copy_id",
    deleteConfirmation: false,
  };
}

/** Open the actions menu for the conversation currently selected in the sidebar. */
export function openSelectedConversationActionMenu(sidebar: SidebarState): void {
  const item = sidebar.selectedItem;
  if (item?.type !== "conversation") return;
  const conv = sidebar.conversations.find(candidate => candidate.id === item.id);
  if (!conv) return;

  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
  sidebar.conversationActionMenu = createConversationActionMenu(conv.id, conv.marked, conv.pinned);
}

/** Screen row used to anchor a conversation's menu beside its visible sidebar entry. */
export function conversationActionMenuAnchorRow(sidebar: SidebarState, convId: string): number {
  const displayRow = buildDisplayRows(sidebar).findIndex(row => (
    row.type === "entry"
    && row.item?.type === "conversation"
    && row.item.id === convId
  ));
  return displayRow === -1 ? 3 : 3 + displayRow - sidebar.scrollOffset;
}

function selectConversationAction(menu: ConversationActionMenuState, action: ConversationAction): void {
  if (menu.selection === action) return;
  menu.selection = action;
  menu.deleteConfirmation = false;
}

function activateSelectedConversationAction(menu: ConversationActionMenuState): ConversationActionMenuKeyResult {
  if (menu.selection !== "delete") return { type: "action", action: menu.selection };
  if (!menu.deleteConfirmation) {
    menu.deleteConfirmation = true;
    return { type: "handled" };
  }
  return { type: "action", action: "delete" };
}

export function handleConversationActionMenuKey(
  menu: ConversationActionMenuState,
  key: KeyEvent,
): ConversationActionMenuKeyResult {
  if (key.type === "escape") return { type: "close" };

  const direction = key.type === "up" || (key.type === "char" && key.char === "k")
    ? -1
    : key.type === "down" || (key.type === "char" && key.char === "j")
      ? 1
      : 0;
  if (direction !== 0) {
    const currentIndex = ACTIONS.indexOf(menu.selection);
    const nextIndex = Math.max(0, Math.min(ACTIONS.length - 1, currentIndex + direction));
    selectConversationAction(menu, ACTIONS[nextIndex] ?? "copy_id");
    menu.deleteConfirmation = false;
    return { type: "handled" };
  }

  if (key.type !== "enter") return { type: "handled" };
  return activateSelectedConversationAction(menu);
}

function actionLabel(menu: ConversationActionMenuState, action: ConversationAction): string {
  switch (action) {
    case "copy_id": return "Copy id";
    case "toggle_star": return menu.marked ? "Unstar" : "Star";
    case "toggle_pin": return menu.pinned ? "Unpin" : "Pin";
    case "delete": return menu.deleteConfirmation ? "You sure?" : "Delete";
  }
}

function conversationActionMenuLayout(
  menu: ConversationActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): ConversationActionMenuLayout | null {
  const availableWidth = totalCols - leftCol + 1;
  if (availableWidth < 6 || totalRows < 4) return null;

  const rawLines = ACTIONS.map(action => `  ${actionLabel(menu, action)} `);
  const innerWidth = Math.max(1, Math.min(
    Math.max(...rawLines.map(termWidth)),
    availableWidth - 2,
  ));
  const boxHeight = rawLines.length + 2;
  const topRow = Math.max(1, Math.min(anchorRow, totalRows - boxHeight + 1));
  return { topRow, leftCol, innerWidth, boxHeight };
}

/** Hit-test an action row or non-action menu chrome at 1-based screen coordinates. */
export function conversationActionMenuHitTest(
  menu: ConversationActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
  col: number,
  row: number,
): ConversationActionMenuHit {
  const layout = conversationActionMenuLayout(menu, anchorRow, leftCol, totalRows, totalCols);
  if (!layout) return null;

  const rightCol = layout.leftCol + layout.innerWidth + 1;
  const bottomRow = layout.topRow + layout.boxHeight - 1;
  if (col < layout.leftCol || col > rightCol || row < layout.topRow || row > bottomRow) return null;

  const actionIndex = row - layout.topRow - 1;
  const action = ACTIONS[actionIndex];
  const insideContent = col > layout.leftCol && col < rightCol;
  return action && insideContent ? action : "chrome";
}

/** Handle hover, click, and outside-click interactions for an open action menu. */
export function handleConversationActionMenuMouse(
  menu: ConversationActionMenuState,
  ev: MouseEvent,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): ConversationActionMenuKeyResult {
  const hit = conversationActionMenuHitTest(
    menu,
    anchorRow,
    leftCol,
    totalRows,
    totalCols,
    ev.col,
    ev.row,
  );

  if (ev.action === "motion") {
    if (hit && hit !== "chrome") selectConversationAction(menu, hit);
    return { type: "handled" };
  }
  if (ev.button !== 0 || ev.action !== "press") return { type: "handled" };
  if (hit === null) return { type: "close" };
  if (hit === "chrome") return { type: "handled" };

  selectConversationAction(menu, hit);
  return activateSelectedConversationAction(menu);
}

/** Render the menu immediately to the right of the fixed-width sidebar. */
export function renderConversationActionMenu(
  menu: ConversationActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): string {
  const layout = conversationActionMenuLayout(menu, anchorRow, leftCol, totalRows, totalCols);
  if (!layout) return "";

  const labels = ACTIONS.map(action => actionLabel(menu, action));
  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(layout.topRow, layout.leftCol) + border + `┌${"─".repeat(layout.innerWidth)}┐` + theme.reset,
  ];

  for (let index = 0; index < ACTIONS.length; index++) {
    const action = ACTIONS[index]!;
    const selected = menu.selection === action;
    const marker = selected ? "▸ " : "  ";
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = action === "delete" ? theme.error : theme.text;
    const content = truncateToWidth(`${marker}${labels[index]} `, layout.innerWidth);
    out.push(
      moveTo(layout.topRow + index + 1, layout.leftCol)
      + border + "│"
      + bg + fg + padRightToWidth(content, layout.innerWidth)
      + theme.reset + border + "│" + theme.reset,
    );
  }

  out.push(
    moveTo(layout.topRow + layout.boxHeight - 1, layout.leftCol)
    + border + `└${"─".repeat(layout.innerWidth)}┘` + theme.reset,
  );
  return out.join("");
}
