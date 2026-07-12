/** Folder/path helpers for the conversations sidebar. */

import { SUBAGENTS_FOLDER_NAME, type ConversationSummary, type FolderSummary, type SidebarItemRef } from "../messages";
import type { CompletionItem } from "../commands";

export interface SidebarFolderViewState {
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  currentFolderId: string | null;
}

export interface MovePromptContext extends SidebarFolderViewState {
  items: SidebarItemRef[];
  input: string;
}

export function currentFolder(state: SidebarFolderViewState): FolderSummary | null {
  return state.currentFolderId ? state.folders.find(f => f.id === state.currentFolderId) ?? null : null;
}

export function parentOfCurrentFolder(state: SidebarFolderViewState): string | null {
  return currentFolder(state)?.parentId ?? null;
}

export function folderPath(state: SidebarFolderViewState, folderId: string | null | undefined): string {
  if (!folderId) return "";
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = state.folders.find(f => f.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder = folder.parentId ? state.folders.find(f => f.id === folder?.parentId) : undefined;
  }
  return names.join("/");
}

export function descendantFolderIds(state: SidebarFolderViewState, folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of state.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function folderDescendantConversations(state: SidebarFolderViewState, folderId: string): ConversationSummary[] {
  const ids = descendantFolderIds(state, folderId);
  return state.conversations.filter(c => c.folderId && ids.has(c.folderId));
}

/** Folder ids directly or transitively inside the reserved top-level subagents/ tree. */
export function subagentsFolderIds(folders: readonly FolderSummary[]): Set<string> {
  const result = new Set<string>();
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  for (const folder of folders) {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: FolderSummary | undefined = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current.id);
      if ((current.parentId ?? null) === null) {
        if (current.name.trim().toLocaleLowerCase() === SUBAGENTS_FOLDER_NAME) {
          for (const id of path) result.add(id);
        }
        break;
      }
      const parentId: string | null = current.parentId;
      current = parentId ? byId.get(parentId) : undefined;
    }
  }
  return result;
}

export function normalizeMoveDestinationInput(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/$/, "") : trimmed;
}

function movePromptItemParent(state: SidebarFolderViewState, item: SidebarItemRef): string | null | undefined {
  if (item.type === "conversation") return state.conversations.find(c => c.id === item.id)?.folderId ?? null;
  return state.folders.find(f => f.id === item.id)?.parentId ?? null;
}

function movePromptCanTargetFolder(state: SidebarFolderViewState, folderId: string, items: SidebarItemRef[]): boolean {
  if (items.length > 0 && items.every(item => movePromptItemParent(state, item) === folderId)) return false;
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.id === folderId || descendantFolderIds(state, item.id).has(folderId)) return false;
  }
  return true;
}

function currentFolderDescendantDepth(state: SidebarFolderViewState, folderId: string): number | null {
  const currentFolderId = state.currentFolderId;
  if (!currentFolderId) return null;

  const seen = new Set<string>();
  let depth = 0;
  let folder = state.folders.find(f => f.id === folderId);
  while (folder && !seen.has(folder.id)) {
    seen.add(folder.id);
    const parentId = folder.parentId ?? null;
    if (!parentId) return null;
    depth++;
    if (parentId === currentFolderId) return depth;
    folder = state.folders.find(f => f.id === parentId);
  }
  return null;
}

export function movePromptMatches(ctx: MovePromptContext): CompletionItem[] {
  const normalized = normalizeMoveDestinationInput(ctx.input).toLowerCase();
  const matchesPrefix = (value: string) => value.toLowerCase().startsWith(normalized);
  const special: CompletionItem[] = [
    { name: "/", desc: "root folder" },
    ...(ctx.currentFolderId ? [{ name: "..", desc: "parent folder" }] : []),
  ].filter(item => matchesPrefix(item.name));

  const folders = ctx.folders
    .filter(folder => movePromptCanTargetFolder(ctx, folder.id, ctx.items))
    .map(folder => {
      const path = folderPath(ctx, folder.id);
      return { folder, path, name: path || folder.name, localDepth: currentFolderDescendantDepth(ctx, folder.id) };
    })
    .filter(({ folder, path, name }) => {
      if (!normalized) return true;
      return matchesPrefix(name) || matchesPrefix(folder.name) || path.toLowerCase().includes(`/${normalized}`);
    })
    .sort((a, b) => {
      if (a.localDepth !== null || b.localDepth !== null) {
        if (a.localDepth === null) return 1;
        if (b.localDepth === null) return -1;
        if (a.localDepth !== b.localDepth) return a.localDepth - b.localDepth;
      }
      return a.name.localeCompare(b.name);
    });

  const localFolders = folders.filter(({ localDepth }) => localDepth !== null);
  const otherFolders = folders.filter(({ localDepth }) => localDepth === null);
  const toCompletion = ({ folder, name }: (typeof folders)[number]): CompletionItem => ({
    name,
    desc: (folder.parentId ? `in ${folderPath(ctx, folder.parentId) || "/"}` : "top-level"),
  });

  return [...special, ...localFolders.map(toCompletion), ...otherFolders.map(toCompletion)];
}

export function findFolderDestination(state: SidebarFolderViewState, input: string): FolderSummary | null | undefined {
  const raw = input.trim();
  if (!raw || raw === "/") return null;
  if (raw === "..") {
    const parentId = parentOfCurrentFolder(state);
    return parentId ? state.folders.find(f => f.id === parentId) : null;
  }
  const normalized = normalizeMoveDestinationInput(raw).toLowerCase();
  const byPath = state.folders.find(f => folderPath(state, f.id).toLowerCase() === normalized);
  if (byPath) return byPath;
  const local = state.folders.find(f => (f.parentId ?? null) === state.currentFolderId && f.name.toLowerCase() === normalized);
  if (local) return local;
  return state.folders.find(f => f.name.toLowerCase() === normalized);
}
