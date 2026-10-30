import type { SidebarItemRef } from "../messages";
import { applyPendingSidebarItemsMove } from "./optimisticmove";
import { focusTargetAfterRemovingSidebarItems } from "./removal";
import { focusSidebarItem, getSelectedSidebarItem, selectedVisualItems } from "./selection";
import type { SidebarState } from "./state";
import { isFolderOpenInTree, isTreeFolderView } from "./tree";
import type { SidebarKeyResult } from "./types";

/** Folder name `.` files conversations into; matched exactly, as the daemon stores it. */
export const DONE_FOLDER_NAME = "done";

export type DoneDestination =
  | { type: "folder"; folderId: string }
  | { type: "create_top_level" }
  | { type: "already_done" };

function doneChild(sidebar: SidebarState, parentId: string | null): string | null {
  // sidebar.folders is kept in sidebar order, so a duplicate name picks the first row.
  return sidebar.folders.find(folder => (folder.parentId ?? null) === parentId && folder.name === DONE_FOLDER_NAME)?.id ?? null;
}

function insideDoneFolder(sidebar: SidebarState, folderId: string | null): boolean {
  const seen = new Set<string>();
  let current = folderId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder = sidebar.folders.find(candidate => candidate.id === current);
    if (!folder) return false;
    if (folder.name === DONE_FOLDER_NAME) return true;
    current = folder.parentId ?? null;
  }
  return false;
}

/**
 * Where `.` files a conversation: its own folder's `done/`, else the top-level
 * `done/` (created when missing). A conversation already filed under a `done`
 * folder stays put, unless its folder keeps its own `done/` (done/x/done).
 */
export function doneDestination(sidebar: SidebarState, convId: string): DoneDestination | null {
  const conversation = sidebar.conversations.find(conv => conv.id === convId);
  if (!conversation) return null;
  const folderId = conversation.folderId ?? null;
  const folder = folderId ? sidebar.folders.find(candidate => candidate.id === folderId) : undefined;
  if (folder?.name === DONE_FOLDER_NAME) return { type: "already_done" };
  const local = doneChild(sidebar, folderId);
  if (local) return { type: "folder", folderId: local };
  if (insideDoneFolder(sidebar, folderId)) return { type: "already_done" };
  const topLevel = doneChild(sidebar, null);
  return topLevel ? { type: "folder", folderId: topLevel } : { type: "create_top_level" };
}

/**
 * Where `.` brings a folder filed directly in a `done` folder: out to that
 * done folder's own parent (done/x -> x at the top level, proj/done/x -> proj/x).
 * Null for a folder that isn't in a done folder.
 */
export function outOfDoneDestination(sidebar: SidebarState, folderId: string): { parentId: string | null } | null {
  const folder = sidebar.folders.find(candidate => candidate.id === folderId);
  const parent = folder?.parentId ? sidebar.folders.find(candidate => candidate.id === folder.parentId) : undefined;
  return parent?.name === DONE_FOLDER_NAME ? { parentId: parent.parentId ?? null } : null;
}

function leavesView(sidebar: SidebarState, destination: string | null): boolean {
  return isTreeFolderView(sidebar)
    ? !isFolderOpenInTree(sidebar, destination)
    : destination !== sidebar.currentFolderId;
}

/**
 * `.`: file the selected conversation, or every conversation in a visual block,
 * into done/; a folder filed in a done folder comes back out of it.
 */
export function moveSelectionToDone(sidebar: SidebarState): SidebarKeyResult {
  const cursor = getSelectedSidebarItem(sidebar);
  const selected = selectedVisualItems(sidebar);
  const conversations = selected
    .filter((item): item is SidebarItemRef & { type: "conversation" } => item.type === "conversation");
  const folders = selected.flatMap(item => {
    const destination = item.type === "folder" ? outOfDoneDestination(sidebar, item.id) : null;
    return destination ? [{ item, parentId: destination.parentId }] : [];
  });
  if (conversations.length === 0 && folders.length === 0) return { type: "handled" };
  sidebar.visualAnchor = null;
  sidebar.pendingDeleteId = null;
  sidebar.pendingDeleteItem = null;

  const byFolder = new Map<string | null, SidebarItemRef[]>();
  for (const { item, parentId } of folders) byFolder.set(parentId, [...byFolder.get(parentId) ?? [], item]);
  const create: SidebarItemRef[] = [];
  let alreadyDone = 0;
  for (const item of conversations) {
    const destination = doneDestination(sidebar, item.id);
    if (!destination) continue;
    if (destination.type === "already_done") alreadyDone++;
    else if (destination.type === "create_top_level") create.push(item);
    else byFolder.set(destination.folderId, [...byFolder.get(destination.folderId) ?? [], item]);
  }

  const leaving = [
    ...create,
    ...[...byFolder].flatMap(([folderId, items]) => leavesView(sidebar, folderId) ? items : []),
  ];
  // As with F: when the cursor's row leaves the view, the row below takes it;
  // a row moved into an expanded tree folder keeps the cursor.
  const cursorLeaves = cursor !== null && leaving.some(item => item.type === cursor.type && item.id === cursor.id);
  const focus = cursorLeaves ? focusTargetAfterRemovingSidebarItems(sidebar, leaving) : null;

  const moves: { items: SidebarItemRef[]; parentId: string | null; reqId?: string }[] = [];
  for (const [folderId, items] of byFolder) {
    const reqId = applyPendingSidebarItemsMove(sidebar, items, folderId, undefined, {});
    if (reqId) moves.push({ items, parentId: folderId, reqId });
  }
  if (focus) {
    if (moves.length > 0) focusSidebarItem(sidebar, focus);
    // The new done/ folder's rows leave only once the daemon answers.
    if (create.length > 0) sidebar.pendingFocusItem = focus;
  }

  const notice = alreadyDone === 0
    ? undefined
    : conversations.length === 1
      ? `Already in a ${DONE_FOLDER_NAME} folder`
      : `${alreadyDone} already in a ${DONE_FOLDER_NAME} folder; left in place`;
  return { type: "move_to_done", moves, create, notice };
}
