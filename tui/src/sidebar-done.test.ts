import { describe, expect, test } from "bun:test";
import type { ConversationSummary, FolderSummary, SidebarItemRef } from "./messages";
import type { KeyEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { handleSidebarKey, updateConversationList, type SidebarState, type SidebarKeyResult } from "./sidebar";
import { doneDestination } from "./sidebar/doneaction";
import { focusSidebarItem } from "./sidebar/selection";
import { createSidebarState } from "./sidebar/state";
import { createInitialState } from "./state";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    messageCount: 0,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder,
    ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder, ...overrides };
}

type Ref = SidebarItemRef;
const conv = (id: string): Ref => ({ type: "conversation", id });
const dir = (id: string): Ref => ({ type: "folder", id });
const dot: KeyEvent = { type: "char", char: "." };

/**
 * Root, top to bottom: done/ (root-done), proj/, misc/, a, b, c.
 * proj/ holds its own done/ (proj-done) and p-a, p-b; misc/ has no done/ and holds m-a;
 * done/ holds old/ (old-a) and arch/ (arch-a), and arch/ has its own done/ (arch-done).
 */
function sidebarWith(view: "navigate" | "tree", options: { rootDone?: boolean } = {}): SidebarState {
  const rootDone = options.rootDone ?? true;
  const sidebar = createSidebarState(view);
  updateConversationList(sidebar, [
    conversation("a", 10),
    conversation("b", 11),
    conversation("c", 12),
    conversation("p-a", 1, { folderId: "proj" }),
    conversation("p-b", 2, { folderId: "proj" }),
    conversation("m-a", 1, { folderId: "misc" }),
    ...rootDone ? [
      conversation("in-done", 3, { folderId: "root-done" }),
      conversation("old-a", 1, { folderId: "old" }),
      conversation("arch-a", 1, { folderId: "arch" }),
    ] : [],
  ], [
    ...rootDone ? [
      folder("root-done", 0, { name: "done" }),
      folder("old", 1, { parentId: "root-done" }),
      folder("arch", 2, { parentId: "root-done" }),
      folder("arch-done", 0, { parentId: "arch", name: "done" }),
    ] : [],
    folder("proj", 1),
    folder("proj-done", 0, { parentId: "proj", name: "done" }),
    folder("misc", 2),
  ]);
  return sidebar;
}

function select(sidebar: SidebarState, cursor: Ref, anchor?: Ref): void {
  focusSidebarItem(sidebar, cursor);
  sidebar.visualAnchor = anchor ?? null;
}

function pressDot(sidebar: SidebarState): Extract<SidebarKeyResult, { type: "move_to_done" }> {
  const result = handleSidebarKey(dot, sidebar);
  if (result.type !== "move_to_done") throw new Error(`expected move_to_done, got ${result.type}`);
  return result;
}

function folderOf(sidebar: SidebarState, id: string): string | null {
  return sidebar.conversations.find(c => c.id === id)?.folderId ?? null;
}

describe("`.` destination", () => {
  test("a folder with its own done/ uses it; otherwise the top-level done/", () => {
    const sidebar = sidebarWith("navigate");
    expect(doneDestination(sidebar, "a")).toEqual({ type: "folder", folderId: "root-done" });
    expect(doneDestination(sidebar, "p-a")).toEqual({ type: "folder", folderId: "proj-done" });
    expect(doneDestination(sidebar, "m-a")).toEqual({ type: "folder", folderId: "root-done" });
  });

  test("no top-level done/: create it", () => {
    const sidebar = sidebarWith("navigate", { rootDone: false });
    expect(doneDestination(sidebar, "a")).toEqual({ type: "create_top_level" });
    expect(doneDestination(sidebar, "m-a")).toEqual({ type: "create_top_level" });
    expect(doneDestination(sidebar, "p-a")).toEqual({ type: "folder", folderId: "proj-done" });
  });

  test("already under a done folder: stays, unless its folder keeps its own done/", () => {
    const sidebar = sidebarWith("navigate");
    expect(doneDestination(sidebar, "in-done")).toEqual({ type: "already_done" });
    expect(doneDestination(sidebar, "old-a")).toEqual({ type: "already_done" });
    expect(doneDestination(sidebar, "arch-a")).toEqual({ type: "folder", folderId: "arch-done" });
  });

  test("the name must be exactly `done`", () => {
    const sidebar = sidebarWith("navigate", { rootDone: false });
    sidebar.folders.push(folder("caps", 5, { name: "Done" }), folder("slash", 6, { name: "done/" }));
    expect(doneDestination(sidebar, "a")).toEqual({ type: "create_top_level" });
  });

  test("a folder named done inside another folder is not the top-level one", () => {
    const sidebar = sidebarWith("navigate", { rootDone: false });
    expect(doneDestination(sidebar, "m-a")).toEqual({ type: "create_top_level" });
  });
});

describe("`.` key", () => {
  test("moves the conversation with the same command F sends, shown at once", () => {
    const sidebar = sidebarWith("navigate");
    select(sidebar, conv("b"));
    const result = pressDot(sidebar);
    expect(result.create).toEqual([]);
    expect(result.notice).toBeUndefined();
    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({ items: [conv("b")], parentId: "root-done" });
    expect(result.moves[0]!.reqId).toMatch(/^sidebar_move_/);
    expect(folderOf(sidebar, "b")).toBe("root-done");
    expect(sidebar.pendingMoves).toHaveLength(1);
  });

  test("inside a folder with done/: files it there", () => {
    const sidebar = sidebarWith("navigate");
    sidebar.currentFolderId = "proj";
    select(sidebar, conv("p-a"));
    expect(pressDot(sidebar).moves).toMatchObject([{ items: [conv("p-a")], parentId: "proj-done" }]);
    expect(folderOf(sidebar, "p-a")).toBe("proj-done");
  });

  test("no top-level done/: asks the daemon to create it with the conversation inside", () => {
    const sidebar = sidebarWith("navigate", { rootDone: false });
    select(sidebar, conv("b"));
    const result = pressDot(sidebar);
    expect(result.moves).toEqual([]);
    expect(result.create).toEqual([conv("b")]);
    // Nothing moves until the daemon answers; then the row below takes the cursor.
    expect(folderOf(sidebar, "b")).toBeNull();
    expect(sidebar.selectedItem).toEqual(conv("b"));
    expect(sidebar.pendingFocusItem).toEqual(conv("c"));

    updateConversationList(
      sidebar,
      sidebar.conversations.map(c => c.id === "b" ? { ...c, folderId: "new-done" } : c),
      [...sidebar.folders, folder("new-done", 11, { name: "done" })],
    );
    expect(sidebar.selectedItem).toEqual(conv("c"));
  });

  test("already in done/: no move, a short notice", () => {
    const sidebar = sidebarWith("navigate");
    sidebar.currentFolderId = "root-done";
    select(sidebar, conv("in-done"));
    expect(pressDot(sidebar)).toEqual({ type: "move_to_done", moves: [], create: [], notice: "Already in a done folder" });
    expect(folderOf(sidebar, "in-done")).toBe("root-done");
    expect(sidebar.selectedItem).toEqual(conv("in-done"));
  });

  test("a folder row: nothing", () => {
    const sidebar = sidebarWith("navigate");
    select(sidebar, dir("misc"));
    expect(handleSidebarKey(dot, sidebar)).toEqual({ type: "handled" });
    expect(sidebar.folders.find(f => f.id === "misc")?.parentId).toBeNull();
  });

  for (const view of ["navigate", "tree"] as const) {
    test(`cursor (${view} view): a middle row goes to the row below, the last row to the one above`, () => {
      const sidebar = sidebarWith(view);
      select(sidebar, conv("b"));
      pressDot(sidebar);
      expect(sidebar.selectedItem).toEqual(conv("c"));

      pressDot(sidebar);
      expect(sidebar.selectedItem).toEqual(conv("a"));
    });

    test(`visual block (${view} view): each conversation to its own done/, folders skipped, cursor below the block`, () => {
      const sidebar = sidebarWith(view);
      // a, b and the misc folder between them in root order: misc (2) sits above a (10).
      select(sidebar, conv("b"), dir("misc"));
      const result = pressDot(sidebar);
      expect(result.moves).toMatchObject([{ items: [conv("a"), conv("b")], parentId: "root-done" }]);
      expect(sidebar.folders.find(f => f.id === "misc")?.parentId).toBeNull();
      expect(sidebar.visualAnchor).toBeNull();
      expect(sidebar.selectedItem).toEqual(conv("c"));
    });
  }

  test("tree view: a block across folders splits by destination and reports the ones already done", () => {
    const sidebar = sidebarWith("tree");
    sidebar.expandedFolderIds.add("root-done");
    sidebar.expandedFolderIds.add("proj");
    // Tree rows: done/ [old/ arch/ in-done] proj/ [done/ p-a p-b] misc/ a b c
    select(sidebar, conv("a"), conv("in-done"));
    const result = pressDot(sidebar);
    expect(result.moves).toEqual([
      expect.objectContaining({ items: [conv("p-a"), conv("p-b")], parentId: "proj-done" }),
      expect.objectContaining({ items: [conv("a")], parentId: "root-done" }),
    ]);
    expect(result.notice).toBe("1 already in a done folder; left in place");
    expect(folderOf(sidebar, "in-done")).toBe("root-done");
    expect(folderOf(sidebar, "p-b")).toBe("proj-done");
    // root-done is expanded, so `a` stays in view and keeps the cursor.
    expect(sidebar.selectedItem).toEqual(conv("a"));
  });

  test("tree view: into a collapsed done/ the row leaves, so the row below takes the cursor", () => {
    const sidebar = sidebarWith("tree");
    sidebar.expandedFolderIds.add("proj");
    select(sidebar, conv("p-a"));
    pressDot(sidebar);
    expect(folderOf(sidebar, "p-a")).toBe("proj-done");
    expect(sidebar.selectedItem).toEqual(conv("p-b"));
  });

  test("mixed block with a missing top-level done/: moves what it can now, creates done/ for the rest", () => {
    const sidebar = sidebarWith("tree", { rootDone: false });
    sidebar.expandedFolderIds.add("proj");
    select(sidebar, conv("a"), conv("p-b"));
    const result = pressDot(sidebar);
    expect(result.moves).toMatchObject([{ items: [conv("p-b")], parentId: "proj-done" }]);
    expect(result.create).toEqual([conv("a")]);
    // Same rule as F: the block starts as the last row of proj/'s level, so the row above it.
    expect(sidebar.selectedItem).toEqual(conv("p-a"));
    expect(sidebar.pendingFocusItem).toEqual(conv("p-a"));
  });
});

describe("`.` routing", () => {
  test("with the sidebar focused in normal mode, `.` files the conversation", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    Object.assign(state.sidebar, sidebarWith("tree"));
    state.sidebar.open = true;
    select(state.sidebar, conv("b"));
    expect(handleFocusedKey(dot, state)).toMatchObject({ type: "move_to_done", moves: [{ parentId: "root-done" }] });
  });

  test("typing in the prompt still inserts a dot", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    expect(handleFocusedKey(dot, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe(".");
  });
});
