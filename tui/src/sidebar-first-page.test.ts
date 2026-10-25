import { describe, expect, test } from "bun:test";
import { sidebarFirstPageConversationIds, sidebarFolderConversationCounts, type SidebarViewHint } from "@exocortex/shared/sidebar-first-page";
import { buildDisplayRows, type DisplayRow } from "./sidebar/rows";
import type { ConversationSummary, FolderSummary } from "./messages";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

function world(seed: number) {
  const random = rng(seed);
  const folders: FolderSummary[] = [];
  for (let i = 0; i < 12; i++) {
    folders.push({
      id: `f${i}`, name: `f${i}`, parentId: i > 2 && random() < 0.6 ? `f${Math.floor(random() * i)}` : null,
      createdAt: 1, updatedAt: 1, pinned: random() < 0.15, sortOrder: random() * 1000,
    });
  }
  const conversations = Array.from({ length: 400 }, (_, i) => ({
    id: `c${i}`, provider: "openai", model: "m", effort: "high", fastMode: false, createdAt: 1, updatedAt: 1,
    messageCount: 1, title: `c${i}`, marked: false, pinned: random() < 0.05, streaming: false, unread: false,
    sortOrder: random() * 1000, folderId: random() < 0.3 ? null : `f${Math.floor(random() * 12)}`,
  })) as ConversationSummary[];
  return { folders, conversations, random };
}

const keyOf = (row: DisplayRow) => row.type !== "entry" ? `${row.type}@${row.depth ?? 0}` : row.item?.type === "up" ? "up" : `${row.item!.type}:${(row.item as { id: string }).id}@${row.depth ?? 0}`;

function rowsFor(conversations: ConversationSummary[], folders: FolderSummary[], view: SidebarViewHint): string[] {
  return buildDisplayRows({
    conversations, folders, search: null,
    currentFolderId: view.folderView === "navigate" ? view.currentFolderId : null,
    folderView: view.folderView, expandedFolderIds: new Set(view.expandedFolderIds),
  }).map(keyOf);
}

describe("incremental sidebar first page", () => {
  test("the rows on screen (and a margin) are exactly the full list's, in every view", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { folders, conversations, random } = world(seed);
      const view: SidebarViewHint = {
        folderView: random() < 0.5 ? "tree" : "navigate",
        currentFolderId: random() < 0.5 ? `f${Math.floor(random() * 12)}` : null,
        expandedFolderIds: folders.filter(() => random() < 0.5).map(folder => folder.id),
        scrollOffset: Math.floor(random() * 60),
        rows: 20 + Math.floor(random() * 40),
        conversationIds: [],
      };
      const page = new Set(sidebarFirstPageConversationIds(conversations, folders, view));
      const full = rowsFor(conversations, folders, view);
      const partial = rowsFor(conversations.filter(conversation => page.has(conversation.id)), folders, view);
      const shown = Math.min(full.length, view.scrollOffset + view.rows * 2);
      expect({ seed, rows: partial.slice(0, shown) }).toEqual({ seed, rows: full.slice(0, shown) });
      // And it is a page, not the whole list.
      expect(page.size).toBeLessThan(conversations.length);
    }
  });

  test("folder counts match what the full list shows, subfolders included", () => {
    const { folders, conversations } = world(7);
    const counts = sidebarFolderConversationCounts(conversations, folders);
    for (const folder of folders) {
      const inSubtree = (folderId: string | null | undefined): boolean => {
        for (let id = folderId ?? null, hops = 0; id && hops < 20; hops++) {
          if (id === folder.id) return true;
          id = folders.find(candidate => candidate.id === id)?.parentId ?? null;
        }
        return false;
      };
      expect(counts[folder.id]).toBe(conversations.filter(conversation => inSubtree(conversation.folderId)).length);
    }
  });
});
