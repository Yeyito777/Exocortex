/** Folder/path helpers for the conversations sidebar. */

import type { ConversationSummary, FolderSummary, SidebarItemRef } from "../messages";
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

export function normalizeMoveDestinationInput(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/$/, "") : trimmed;
}

function movePromptCanTargetFolder(state: SidebarFolderViewState, folderId: string, items: SidebarItemRef[]): boolean {
  for (const item of items) {
    if (item.type !== "folder") continue;
    if (item.id === folderId || descendantFolderIds(state, item.id).has(folderId)) return false;
  }
  return true;
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
      return { folder, path, name: path || folder.name };
    })
    .filter(({ folder, path, name }) => {
      if (!normalized) return true;
      return matchesPrefix(name) || matchesPrefix(folder.name) || path.toLowerCase().includes(`/${normalized}`);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ folder, name }): CompletionItem => ({
      name,
      desc: (folder.parentId ? `in ${folderPath(ctx, folder.parentId) || "/"}` : "top-level"),
    }));

  return [...special, ...folders];
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
