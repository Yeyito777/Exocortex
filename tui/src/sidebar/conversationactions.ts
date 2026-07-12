/**
 * State, keyboard handling, and rendering for the conversation-actions menu.
 *
 * The menu is anchored beside the selected conversation in the sidebar, in
 * the same style as Record's server/item action menu.
 */

import type { KeyEvent } from "../input";
import { moveTo } from "../frame";
import { theme } from "../theme";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";

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
    menu.selection = ACTIONS[nextIndex] ?? "copy_id";
    menu.deleteConfirmation = false;
    return { type: "handled" };
  }

  if (key.type !== "enter") return { type: "handled" };
  if (menu.selection !== "delete") return { type: "action", action: menu.selection };
  if (!menu.deleteConfirmation) {
    menu.deleteConfirmation = true;
    return { type: "handled" };
  }
  return { type: "action", action: "delete" };
}

function actionLabel(menu: ConversationActionMenuState, action: ConversationAction): string {
  switch (action) {
    case "copy_id": return "Copy id";
    case "toggle_star": return menu.marked ? "Unstar" : "Star";
    case "toggle_pin": return menu.pinned ? "Unpin" : "Pin";
    case "delete": return menu.deleteConfirmation ? "You sure?" : "Delete";
  }
}

/** Render the menu immediately to the right of the fixed-width sidebar. */
export function renderConversationActionMenu(
  menu: ConversationActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): string {
  const availableWidth = totalCols - leftCol + 1;
  if (availableWidth < 6 || totalRows < 4) return "";

  const labels = ACTIONS.map(action => actionLabel(menu, action));
  const rawLines = labels.map(label => `  ${label} `);
  const innerWidth = Math.max(1, Math.min(
    Math.max(...rawLines.map(termWidth)),
    availableWidth - 2,
  ));
  const boxHeight = rawLines.length + 2;
  const topRow = Math.max(1, Math.min(anchorRow, totalRows - boxHeight + 1));
  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(topRow, leftCol) + border + `┌${"─".repeat(innerWidth)}┐` + theme.reset,
  ];

  for (let index = 0; index < ACTIONS.length; index++) {
    const action = ACTIONS[index]!;
    const selected = menu.selection === action;
    const marker = selected ? "▸ " : "  ";
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = action === "delete" ? theme.error : theme.text;
    const content = truncateToWidth(`${marker}${labels[index]} `, innerWidth);
    out.push(
      moveTo(topRow + index + 1, leftCol)
      + border + "│"
      + bg + fg + padRightToWidth(content, innerWidth)
      + theme.reset + border + "│" + theme.reset,
    );
  }

  out.push(
    moveTo(topRow + boxHeight - 1, leftCol)
    + border + `└${"─".repeat(innerWidth)}┘` + theme.reset,
  );
  return out.join("");
}
