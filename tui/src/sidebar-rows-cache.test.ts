import { describe, expect, test } from "bun:test";
import { buildDisplayRows, createSidebarState } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { SidebarState } from "./sidebar/state";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
    createdAt: sortOrder, updatedAt: sortOrder, messageCount: 0, title: id,
    marked: false, pinned: false, streaming: false, unread: false, sortOrder, ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, pinned: false, sortOrder, ...overrides } as FolderSummary;
}

function sidebarWith(view: "tree" | "navigate"): SidebarState {
  const sidebar = createSidebarState(view);
  sidebar.folders = [folder("box", 0)];
  sidebar.conversations = [
    conversation("a", 1),
    conversation("b", 2),
    conversation("c", 3, { folderId: "box" }),
  ];
  return sidebar;
}

const ids = (sidebar: SidebarState) => buildDisplayRows(sidebar).map(row =>
  row.type === "entry" ? `${"  ".repeat(row.depth ?? 0)}${row.item?.type === "up" ? ".." : row.item?.id}` : row.type);

describe("sidebar display rows cache", () => {
  test("unchanged inputs return the same rows without rebuilding them", () => {
    const sidebar = sidebarWith("tree");
    const first = buildDisplayRows(sidebar);
    // A title or activity change does not move any row.
    sidebar.conversations[0]!.title = "renamed";
    sidebar.conversations[1]!.streaming = true;
    expect(buildDisplayRows(sidebar)).toBe(first);
  });

  test("summaries changed in place relayout the rows", () => {
    const sidebar = sidebarWith("tree");
    expect(ids(sidebar)).toEqual(["box", "a", "b"]);
    sidebar.conversations[1]!.pinned = true;
    expect(ids(sidebar)).toEqual(["label", "b", "delimiter", "box", "a"]);
    sidebar.conversations[1]!.pinned = false;
    sidebar.conversations[0]!.sortOrder = 9;
    expect(ids(sidebar)).toEqual(["box", "b", "a"]);
    sidebar.conversations[1]!.folderId = "box";
    expect(ids(sidebar)).toEqual(["box", "a"]);
    sidebar.folders[0]!.pinned = true;
    expect(ids(sidebar)).toEqual(["label", "box", "delimiter", "a"]);
  });

  test("expanding and collapsing a tree folder in place relayouts the rows", () => {
    const sidebar = sidebarWith("tree");
    expect(ids(sidebar)).toEqual(["box", "a", "b"]);
    sidebar.expandedFolderIds.add("box");
    expect(ids(sidebar)).toEqual(["box", "  c", "a", "b"]);
    sidebar.expandedFolderIds.delete("box");
    expect(ids(sidebar)).toEqual(["box", "a", "b"]);
  });

  test("the navigate view follows the current folder and the folder view", () => {
    const sidebar = sidebarWith("navigate");
    expect(ids(sidebar)).toEqual(["box", "a", "b"]);
    sidebar.currentFolderId = "box";
    expect(ids(sidebar)).toEqual(["..", "c"]);
    sidebar.currentFolderId = null;
    sidebar.folderView = "tree";
    sidebar.expandedFolderIds.add("box");
    expect(ids(sidebar)).toEqual(["box", "  c", "a", "b"]);
  });

  test("added, removed and replaced lists relayout the rows", () => {
    const sidebar = sidebarWith("tree");
    buildDisplayRows(sidebar);
    sidebar.conversations.push(conversation("d", -1));
    expect(ids(sidebar)).toEqual(["d", "box", "a", "b"]);
    sidebar.conversations = sidebar.conversations.filter(conv => conv.id !== "a");
    expect(ids(sidebar)).toEqual(["d", "box", "b"]);
    sidebar.folders = [];
    expect(ids(sidebar)).toEqual(["d", "b"]);
  });

  test("a search lists its matches and the cached layout returns after it", () => {
    const sidebar = sidebarWith("tree");
    const unfiltered = buildDisplayRows(sidebar);
    sidebar.search = { barOpen: false, barMode: "search", barInput: "", query: "c", highlightsVisible: true } as SidebarState["search"];
    expect(ids(sidebar)).toEqual(["c"]);
    sidebar.search = null;
    expect(buildDisplayRows(sidebar)).toBe(unfiltered);
  });

  test("each sidebar keeps its own layout", () => {
    const tree = sidebarWith("tree");
    const navigate = sidebarWith("navigate");
    navigate.currentFolderId = "box";
    expect(ids(tree)).toEqual(["box", "a", "b"]);
    expect(ids(navigate)).toEqual(["..", "c"]);
    expect(ids(tree)).toEqual(["box", "a", "b"]);
  });
});
