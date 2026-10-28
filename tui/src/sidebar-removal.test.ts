import { describe, expect, test } from "bun:test";
import type { ConversationSummary, FolderSummary, SidebarItemRef } from "./messages";
import type { KeyEvent } from "./input";
import { buildDisplayRows, handleSidebarAction, handleSidebarKey, handleSidebarPromptKey, updateConversationList, type SidebarState } from "./sidebar";
import { handleConversationDeleted } from "./events/conversations";
import { requestFocusAfterMovingItemsOutOfView } from "./sidebar/folderactions";
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
  return {
    id,
    name: id,
    parentId: null,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    pinned: false,
    sortOrder,
    ...overrides,
  };
}

describe("sidebar focus after removing items", () => {
  test("deleting the first unpinned root conversation stays in the unpinned section", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("target", 1),
      conversation("below", 2),
    ];
    sidebar.selectedItem = { type: "conversation", id: "target" };
    sidebar.selectedId = "target";
    sidebar.selectedIndex = 1;

    expect(handleSidebarAction("delete", sidebar)).toEqual({ type: "handled" });
    expect(handleSidebarAction("delete", sidebar)).toEqual({ type: "delete_conversation", convId: "target" });

    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "below" });
  });

  test("deleting an unpinned visual block stays in the unpinned section", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("target-a", 1),
      conversation("target-b", 2),
      conversation("below", 3),
    ];
    sidebar.visualAnchor = { type: "conversation", id: "target-a" };
    sidebar.selectedItem = { type: "conversation", id: "target-b" };
    sidebar.selectedId = "target-b";
    sidebar.selectedIndex = 2;

    expect(handleSidebarAction("delete", sidebar)).toEqual({ type: "handled" });
    expect(handleSidebarAction("delete", sidebar)).toEqual({
      type: "delete_conversations",
      convIds: ["target-a", "target-b"],
    });

    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "below" });
  });

  test("deletion uses visible order rather than indices skewed by folder contents", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("folder", 10)];
    sidebar.conversations = [
      conversation("above", 0),
      conversation("hidden", 1, { folderId: "folder" }),
      conversation("target", 2),
      conversation("below", 3),
    ];
    sidebar.selectedItem = { type: "conversation", id: "target" };
    sidebar.selectedId = "target";
    sidebar.selectedIndex = 2;

    handleSidebarAction("delete", sidebar);
    expect(handleSidebarAction("delete", sidebar)).toEqual({ type: "delete_conversation", convId: "target" });

    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "below" });
  });

  test("moving the first unpinned conversation away requests focus below it", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("target", 1),
      conversation("below", 2),
    ];

    requestFocusAfterMovingItemsOutOfView(sidebar, [{ type: "conversation", id: "target" }]);

    expect(sidebar.pendingFocusItem).toEqual({ type: "conversation", id: "below" });
  });

  test("authoritative move updates use the same pinned-section-aware fallback", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("destination", 3)];
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("target", 1),
      conversation("below", 2),
    ];
    sidebar.selectedItem = { type: "conversation", id: "target" };
    sidebar.selectedId = "target";
    sidebar.selectedIndex = 1;

    updateConversationList(sidebar, [
      conversation("pinned", 0, { pinned: true }),
      conversation("target", 1, { folderId: "destination" }),
      conversation("below", 2),
    ], sidebar.folders);

    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "below" });
  });

  test("delete events do not jump from the unpinned section into pinned conversations", () => {
    const state = createInitialState();
    state.sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("target", 1),
      conversation("below", 2),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "target" };
    state.sidebar.selectedId = "target";
    state.sidebar.selectedIndex = 1;

    handleConversationDeleted({ type: "conversation_deleted", convId: "target" }, state);

    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "below" });
  });
});

type Ref = SidebarItemRef;
const conv = (id: string): Ref => ({ type: "conversation", id });
const dir = (id: string): Ref => ({ type: "folder", id });

/**
 * Root view, top to bottom: dest, a, box, b, c, d. `dest` is the move
 * destination; `box` is a folder holding `in-box`.
 */
function rootSidebar(view: "navigate" | "tree" = "navigate"): SidebarState {
  const sidebar = createSidebarState(view);
  updateConversationList(sidebar, [
    conversation("a", 1),
    conversation("b", 3),
    conversation("c", 4),
    conversation("d", 5),
    conversation("in-box", 1, { folderId: "box" }),
  ], [folder("dest", 0), folder("box", 2)]);
  return sidebar;
}

/** Select `cursor`, with a visual block reaching back to `anchor` when given. */
function select(sidebar: SidebarState, cursor: Ref, anchor?: Ref): void {
  focusSidebarItem(sidebar, cursor);
  sidebar.visualAnchor = anchor ?? null;
}

function typeKeys(sidebar: SidebarState, text: string): void {
  for (const char of text) handleSidebarPromptKey(sidebar, { type: "char", char } as KeyEvent);
}

/** Where the cursor rests once the daemon has confirmed the change. */
function settledFocus(sidebar: SidebarState): SidebarState["selectedItem"] {
  if (sidebar.pendingFocusItem) {
    // A folder delete waits for the daemon's list; apply the one it will send.
    const target = sidebar.pendingFocusItem;
    const pendingFolderDelete = sidebar.folders.find(f => sameRef(sidebar.selectedItem, dir(f.id)));
    if (pendingFolderDelete) {
      const gone = new Set([pendingFolderDelete.id]);
      updateConversationList(
        sidebar,
        sidebar.conversations.filter(c => !gone.has(c.folderId ?? "")),
        sidebar.folders.filter(f => !gone.has(f.id)),
      );
    }
    expect(sidebar.selectedItem).toEqual(target);
  }
  return sidebar.selectedItem;
}

function sameRef(a: SidebarState["selectedItem"], b: Ref): boolean {
  return !!a && a.type === b.type && "id" in a && "id" in b && a.id === b.id;
}

/** Each way to make the selected rows leave the view. */
const removals: Record<string, (sidebar: SidebarState) => void> = {
  "dd": sidebar => {
    handleSidebarAction("delete", sidebar);
    const result = handleSidebarAction("delete", sidebar);
    expect(result.type).toMatch(/^delete_/);
  },
  "F into a folder": sidebar => {
    handleSidebarKey({ type: "char", char: "F" } as KeyEvent, sidebar);
    typeKeys(sidebar, "dest");
    expect(handleSidebarPromptKey(sidebar, { type: "enter" } as KeyEvent).type).toBe("move_sidebar_items");
  },
};

describe("sidebar cursor after the selected rows leave: the row below takes the slot", () => {
  for (const [name, remove] of Object.entries(removals)) for (const view of ["tree", "navigate"] as const) {
    describe(`${name} (${view} view)`, () => {
      test("a middle conversation: the cursor lands on the next row", () => {
        const sidebar = rootSidebar(view);
        select(sidebar, conv("b"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("c"));
      });

      test("the last conversation: the cursor lands on the previous row", () => {
        const sidebar = rootSidebar(view);
        select(sidebar, conv("d"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("c"));
      });

      test("a visual block: the cursor lands on the first row after it", () => {
        const sidebar = rootSidebar(view);
        select(sidebar, conv("c"), conv("b"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("d"));
      });

      test("a visual block at the end: the cursor lands on the row above it", () => {
        const sidebar = rootSidebar(view);
        select(sidebar, conv("d"), conv("c"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("b"));
      });

      test("a folder: the cursor lands on the next row", () => {
        const sidebar = rootSidebar(view);
        select(sidebar, dir("box"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("b"));
      });

      test("a folder at the end: the cursor lands on the previous row", () => {
        const sidebar = rootSidebar();
        sidebar.folders.find(f => f.id === "box")!.sortOrder = 9;
        select(sidebar, dir("box"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("d"));
      });

      if (view === "tree") test("a folder's open contents leave with it", () => {
        const sidebar = rootSidebar(view);
        sidebar.expandedFolderIds.add("box");
        select(sidebar, dir("box"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("b"));
      });

      test("a pinned row moves to the next pinned row, and the last one to the previous", () => {
        const sidebar = rootSidebar(view);
        for (const id of ["a", "b", "c"]) sidebar.conversations.find(c => c.id === id)!.pinned = true;
        select(sidebar, conv("b"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("c"));

        select(sidebar, conv("c"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(conv("a"));
      });

      test("emptying the pinned section moves to the first unpinned row", () => {
        const sidebar = rootSidebar(view);
        for (const id of ["a", "b"]) sidebar.conversations.find(c => c.id === id)!.pinned = true;
        select(sidebar, conv("b"), conv("a"));
        remove(sidebar);
        expect(settledFocus(sidebar)).toEqual(dir("dest"));
      });
    });
  }

  describe("< out of the current folder", () => {
    function insideSidebar(): SidebarState {
      const sidebar = createSidebarState("navigate");
      updateConversationList(sidebar, [
        conversation("p-a", 1, { folderId: "proj" }),
        conversation("p-b", 3, { folderId: "proj" }),
        conversation("p-c", 4, { folderId: "proj" }),
      ], [folder("proj", 0), folder("p-box", 2, { parentId: "proj" })]);
      sidebar.currentFolderId = "proj";
      return sidebar;
    }
    const moveOut = (sidebar: SidebarState) =>
      expect(handleSidebarKey({ type: "char", char: "<" } as KeyEvent, sidebar).type).toBe("move_sidebar_items");

    test("a middle conversation: the next row; the last: the previous row", () => {
      const sidebar = insideSidebar();
      select(sidebar, conv("p-a"));
      moveOut(sidebar);
      expect(sidebar.selectedItem).toEqual(dir("p-box"));
      select(sidebar, conv("p-c"));
      moveOut(sidebar);
      expect(sidebar.selectedItem).toEqual(conv("p-b"));
    });

    test("a folder and a visual block", () => {
      const sidebar = insideSidebar();
      select(sidebar, dir("p-box"));
      moveOut(sidebar);
      expect(sidebar.selectedItem).toEqual(conv("p-b"));

      const block = insideSidebar();
      select(block, dir("p-box"), conv("p-a"));
      moveOut(block);
      expect(block.selectedItem).toEqual(conv("p-b"));
    });
  });

  test("tree view: < keeps the row in view one level up, so the cursor follows it", () => {
    const sidebar = createSidebarState("tree");
    updateConversationList(sidebar, [
      conversation("p-a", 1, { folderId: "proj" }),
      conversation("p-b", 2, { folderId: "proj" }),
    ], [folder("proj", 0)]);
    select(sidebar, conv("p-a"));
    expect(handleSidebarKey({ type: "char", char: "<" } as KeyEvent, sidebar).type).toBe("move_sidebar_items");
    expect(sidebar.selectedItem).toEqual(conv("p-a"));
  });

  test("tree view: F into an expanded folder keeps the row in view, so the cursor follows it", () => {
    const sidebar = rootSidebar("tree");
    sidebar.expandedFolderIds.add("dest");
    select(sidebar, conv("b"));
    removals["F into a folder"]!(sidebar);
    expect(sidebar.selectedItem).toEqual(conv("b"));
  });

  describe("changes from the daemon or another client", () => {
    test("a move elsewhere: the next row; the last row: the previous one", () => {
      const sidebar = rootSidebar();
      select(sidebar, conv("b"));
      updateConversationList(sidebar, sidebar.conversations.map(c => c.id === "b" ? { ...c, folderId: "dest" } : c), sidebar.folders);
      expect(sidebar.selectedItem).toEqual(conv("c"));

      select(sidebar, conv("d"));
      updateConversationList(sidebar, sidebar.conversations.map(c => c.id === "d" ? { ...c, folderId: "dest" } : c), sidebar.folders);
      expect(sidebar.selectedItem).toEqual(conv("c"));
    });

    test("when the row below left too, the row now in the slot", () => {
      const sidebar = rootSidebar();
      select(sidebar, conv("b"));
      updateConversationList(sidebar, sidebar.conversations.filter(c => c.id !== "b" && c.id !== "c"), sidebar.folders);
      expect(sidebar.selectedItem).toEqual(conv("d"));
    });

    test("a delete event: the next row; the last row: the previous one", () => {
      const state = createInitialState();
      Object.assign(state.sidebar, rootSidebar());
      select(state.sidebar, conv("b"));
      handleConversationDeleted({ type: "conversation_deleted", convId: "b" }, state);
      expect(state.sidebar.selectedItem).toEqual(conv("c"));

      select(state.sidebar, conv("d"));
      handleConversationDeleted({ type: "conversation_deleted", convId: "d" }, state);
      expect(state.sidebar.selectedItem).toEqual(conv("c"));
    });
  });

  test("rows that stay put keep the cursor: renaming and marking", () => {
    const sidebar = rootSidebar();
    select(sidebar, conv("b"));
    handleSidebarAction("mark", sidebar);
    expect(sidebar.selectedItem).toEqual(conv("b"));
    select(sidebar, dir("box"));
    handleSidebarKey({ type: "char", char: "r" } as KeyEvent, sidebar);
    typeKeys(sidebar, "renamed");
    handleSidebarPromptKey(sidebar, { type: "enter" } as KeyEvent);
    expect(sidebar.selectedItem).toEqual(dir("box"));
    expect(buildDisplayRows(sidebar).some(row => row.item?.type === "folder" && row.item.id === "box")).toBe(true);
  });
});
