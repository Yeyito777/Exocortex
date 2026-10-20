/**
 * State, keyboard handling, and rendering for the sidebar actions menu.
 *
 * `;` or a right click opens it beside the selected conversation or folder,
 * in the same style as Record's server/item action menu.
 */

import type { KeyEvent, MouseEvent } from "../input";
import type { SidebarItemRef } from "../messages";
import { moveTo } from "../frame";
import { theme } from "../theme";
import type { ScreenRect } from "../historyimages";
import { padRightToWidth, termWidth, truncateToWidth } from "../textwidth";
import { summarizeInstructions } from "../instructions/state";
import { getSelectedSidebarItem } from "./selection";
import { buildDisplayRows } from "./rows";
import type { SidebarState } from "./state";

export type ConversationAction = "copy_id" | "toggle_star" | "toggle_pin" | "delete";
export type FolderAction = "edit_instructions" | "rename" | "toggle_pin" | "toggle_mute" | "unwrap" | "delete";
export type SidebarAction = ConversationAction | FolderAction;

export interface SidebarActionMenuState {
  item: SidebarItemRef;
  actions: readonly SidebarAction[];
  marked: boolean;
  pinned: boolean;
  muted: boolean;
  /** The folder's own instructions when the menu opened; null for conversations. */
  instructions: string | null;
  selection: SidebarAction;
  deleteConfirmation: boolean;
}

export type SidebarActionMenuKeyResult =
  | { type: "handled" }
  | { type: "close" }
  | { type: "action"; action: SidebarAction };

const CONVERSATION_ACTIONS: readonly ConversationAction[] = ["copy_id", "toggle_star", "toggle_pin", "delete"];
const FOLDER_ACTIONS: readonly FolderAction[] = ["edit_instructions", "rename", "toggle_pin", "toggle_mute", "unwrap", "delete"];

/** Widest instructions preview beside "Edit instructions", so the menu stays narrow. */
const INSTRUCTIONS_PREVIEW_WIDTH = 24;

interface SidebarActionMenuLayout {
  topRow: number;
  leftCol: number;
  innerWidth: number;
  boxHeight: number;
}

export type SidebarActionMenuHit = SidebarAction | "chrome" | null;

export function createConversationActionMenu(
  convId: string,
  marked: boolean,
  pinned: boolean,
): SidebarActionMenuState {
  return {
    item: { type: "conversation", id: convId },
    actions: CONVERSATION_ACTIONS,
    marked,
    pinned,
    muted: false,
    instructions: null,
    selection: "copy_id",
    deleteConfirmation: false,
  };
}

export function createFolderActionMenu(
  folderId: string,
  pinned: boolean,
  muted: boolean,
  instructions: string,
): SidebarActionMenuState {
  return {
    item: { type: "folder", id: folderId },
    actions: FOLDER_ACTIONS,
    marked: false,
    pinned,
    muted,
    instructions,
    selection: "edit_instructions",
    deleteConfirmation: false,
  };
}

const INSTRUCTIONS_HEADER = "# Context from AGENTS.md:\n";

/**
 * A folder's own instructions, read from the inherited text every folder row
 * already carries: the daemon joins the non-empty instructions of the folder
 * and its ancestors, so whatever follows the parent's text is the folder's own.
 */
export function folderOwnInstructions(sidebar: Pick<SidebarState, "folders">, folderId: string): string {
  const folder = sidebar.folders.find(candidate => candidate.id === folderId);
  if (!folder) return "";
  const effective = folder.effectiveInstructions ?? "";
  const parent = folder.parentId ? sidebar.folders.find(candidate => candidate.id === folder.parentId) : undefined;
  const inherited = parent?.effectiveInstructions ?? "";
  if (inherited && !effective.startsWith(inherited)) return "";
  const own = effective.slice(inherited.length).replace(/^\n\n/, "");
  return own.startsWith(INSTRUCTIONS_HEADER) ? own.slice(INSTRUCTIONS_HEADER.length) : own;
}

/** Open the actions menu for the conversation or folder currently selected in the sidebar. */
export function openSelectedSidebarActionMenu(sidebar: SidebarState): void {
  const item = getSelectedSidebarItem(sidebar);
  let menu: SidebarActionMenuState | null = null;
  if (item?.type === "conversation") {
    const conv = sidebar.conversations.find(candidate => candidate.id === item.id);
    if (conv) menu = createConversationActionMenu(conv.id, conv.marked, conv.pinned);
  } else if (item?.type === "folder") {
    const folder = sidebar.folders.find(candidate => candidate.id === item.id);
    if (folder) menu = createFolderActionMenu(folder.id, folder.pinned, folder.muted === true, folderOwnInstructions(sidebar, folder.id));
  }
  if (!menu) return;

  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;
  sidebar.actionMenu = menu;
}

/** Screen row used to anchor a menu beside its item's visible sidebar entry. */
export function sidebarActionMenuAnchorRow(sidebar: SidebarState, item: SidebarItemRef): number {
  const displayRow = buildDisplayRows(sidebar).findIndex(row => (
    row.type === "entry"
    && row.item?.type === item.type
    && row.item.id === item.id
  ));
  return displayRow === -1 ? 3 : 3 + displayRow - sidebar.scrollOffset;
}

function selectSidebarAction(menu: SidebarActionMenuState, action: SidebarAction): void {
  if (menu.selection === action) return;
  menu.selection = action;
  menu.deleteConfirmation = false;
}

function activateSelectedSidebarAction(menu: SidebarActionMenuState): SidebarActionMenuKeyResult {
  if (menu.selection !== "delete") return { type: "action", action: menu.selection };
  if (!menu.deleteConfirmation) {
    menu.deleteConfirmation = true;
    return { type: "handled" };
  }
  return { type: "action", action: "delete" };
}

export function handleSidebarActionMenuKey(
  menu: SidebarActionMenuState,
  key: KeyEvent,
): SidebarActionMenuKeyResult {
  if (key.type === "escape") return { type: "close" };

  const direction = key.type === "up" || (key.type === "char" && key.char === "k")
    ? -1
    : key.type === "down" || (key.type === "char" && key.char === "j")
      ? 1
      : 0;
  if (direction !== 0) {
    const currentIndex = menu.actions.indexOf(menu.selection);
    const nextIndex = Math.max(0, Math.min(menu.actions.length - 1, currentIndex + direction));
    selectSidebarAction(menu, menu.actions[nextIndex] ?? menu.actions[0]!);
    menu.deleteConfirmation = false;
    return { type: "handled" };
  }

  if (key.type !== "enter") return { type: "handled" };
  return activateSelectedSidebarAction(menu);
}

function actionLabel(menu: SidebarActionMenuState, action: SidebarAction): string {
  switch (action) {
    case "copy_id": return "Copy id";
    case "toggle_star": return menu.marked ? "Unstar" : "Star";
    case "toggle_pin": return menu.pinned ? "Unpin" : "Pin";
    case "toggle_mute": return menu.muted ? "Unmute" : "Mute";
    case "edit_instructions": return "Edit instructions";
    case "rename": return "Rename";
    case "unwrap": return "Unwrap";
    case "delete": return menu.deleteConfirmation ? "You sure?" : "Delete";
  }
}

/** Muted text after the label: the folder's instructions at a glance. */
function actionHint(menu: SidebarActionMenuState, action: SidebarAction): string {
  if (action !== "edit_instructions") return "";
  const summary = summarizeInstructions(menu.instructions);
  if (!summary?.preview) return "empty";
  return truncateToWidth(summary.preview, INSTRUCTIONS_PREVIEW_WIDTH);
}

function actionLine(menu: SidebarActionMenuState, action: SidebarAction): { label: string; hint: string } {
  const hint = actionHint(menu, action);
  return { label: actionLabel(menu, action), hint: hint ? ` ${hint}` : "" };
}

function sidebarActionMenuLayout(
  menu: SidebarActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): SidebarActionMenuLayout | null {
  const availableWidth = totalCols - leftCol + 1;
  if (availableWidth < 6 || totalRows < 4) return null;

  const rawLines = menu.actions.map(action => {
    const { label, hint } = actionLine(menu, action);
    return `  ${label}${hint} `;
  });
  const innerWidth = Math.max(1, Math.min(
    Math.max(...rawLines.map(termWidth)),
    availableWidth - 2,
  ));
  const boxHeight = rawLines.length + 2;
  const topRow = Math.max(1, Math.min(anchorRow, totalRows - boxHeight + 1));
  return { topRow, leftCol, innerWidth, boxHeight };
}

/** Hit-test an action row or non-action menu chrome at 1-based screen coordinates. */
export function sidebarActionMenuHitTest(
  menu: SidebarActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
  col: number,
  row: number,
): SidebarActionMenuHit {
  const layout = sidebarActionMenuLayout(menu, anchorRow, leftCol, totalRows, totalCols);
  if (!layout) return null;

  const rightCol = layout.leftCol + layout.innerWidth + 1;
  const bottomRow = layout.topRow + layout.boxHeight - 1;
  if (col < layout.leftCol || col > rightCol || row < layout.topRow || row > bottomRow) return null;

  const actionIndex = row - layout.topRow - 1;
  const action = menu.actions[actionIndex];
  const insideContent = col > layout.leftCol && col < rightCol;
  return action && insideContent ? action : "chrome";
}

/** Handle hover, click, and outside-click interactions for an open action menu. */
export function handleSidebarActionMenuMouse(
  menu: SidebarActionMenuState,
  ev: MouseEvent,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): SidebarActionMenuKeyResult {
  const hit = sidebarActionMenuHitTest(
    menu,
    anchorRow,
    leftCol,
    totalRows,
    totalCols,
    ev.col,
    ev.row,
  );

  if (ev.action === "motion") {
    if (hit && hit !== "chrome") selectSidebarAction(menu, hit);
    return { type: "handled" };
  }
  if (ev.button !== 0 || ev.action !== "press") return { type: "handled" };
  if (hit === null) return { type: "close" };
  if (hit === "chrome") return { type: "handled" };

  selectSidebarAction(menu, hit);
  return activateSelectedSidebarAction(menu);
}

/** Render the menu immediately to the right of the fixed-width sidebar, with the screen box it draws on (images are cropped around it). */
export function renderSidebarActionMenu(
  menu: SidebarActionMenuState,
  anchorRow: number,
  leftCol: number,
  totalRows: number,
  totalCols: number,
): { payload: string; rect: ScreenRect | null } {
  const layout = sidebarActionMenuLayout(menu, anchorRow, leftCol, totalRows, totalCols);
  if (!layout) return { payload: "", rect: null };

  const border = theme.sidebarBg + theme.accent;
  const out: string[] = [
    moveTo(layout.topRow, layout.leftCol) + border + `┌${"─".repeat(layout.innerWidth)}┐` + theme.reset,
  ];

  for (let index = 0; index < menu.actions.length; index++) {
    const action = menu.actions[index]!;
    const selected = menu.selection === action;
    const marker = selected ? "▸ " : "  ";
    const bg = selected ? theme.sidebarSelBg : theme.sidebarBg;
    const fg = action === "delete" ? theme.error : theme.text;
    const { label, hint } = actionLine(menu, action);
    const head = truncateToWidth(`${marker}${label}`, layout.innerWidth);
    const tail = truncateToWidth(`${hint} `, Math.max(0, layout.innerWidth - termWidth(head)));
    out.push(
      moveTo(layout.topRow + index + 1, layout.leftCol)
      + border + "│"
      + bg + fg + head + theme.muted + padRightToWidth(tail, layout.innerWidth - termWidth(head))
      + theme.reset + border + "│" + theme.reset,
    );
  }

  out.push(
    moveTo(layout.topRow + layout.boxHeight - 1, layout.leftCol)
    + border + `└${"─".repeat(layout.innerWidth)}┘` + theme.reset,
  );
  return {
    payload: out.join(""),
    rect: {
      top: layout.topRow,
      bottom: layout.topRow + layout.boxHeight - 1,
      left: layout.leftCol,
      right: layout.leftCol + layout.innerWidth + 1,
    },
  };
}
