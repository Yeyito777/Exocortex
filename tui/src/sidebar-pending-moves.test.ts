import { describe, expect, test } from "bun:test";
import { handleEvent } from "./events";
import { handleFocusedKey } from "./focus";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { Event } from "./protocol";
import { buildDisplayRows } from "./sidebar";
import { createSidebarState } from "./sidebar";
import { overlayPendingSidebarMoves } from "./sidebar/pendingmoves";
import type { SidebarFolderView } from "./sidebar/tree";
import { createInitialState, type RenderState } from "./state";
import { stripAnsi } from "./historycursor";

const daemon = { unsubscribe() {}, subscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false, createdAt: sortOrder, updatedAt: sortOrder,
    messageCount: 0, title: id, marked: false, pinned: false, streaming: false, unread: false, sortOrder, ...overrides,
  };
}

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder, ...overrides };
}

/**
 * alpha / beta (with b-child) / gamma / delta / c1, in that order. In the tree
 * view beta is expanded, so its child is listed under it.
 */
function setup(view: SidebarFolderView): RenderState {
  const state = createInitialState();
  state.sidebar = createSidebarState(view);
  state.sidebar.open = true;
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
  state.sidebar.folders = [folder("alpha", 0), folder("beta", 1), folder("gamma", 2), folder("delta", 3)];
  state.sidebar.conversations = [conversation("b-child", 0, { folderId: "beta" }), conversation("c1", 4)];
  if (view === "tree") state.sidebar.expandedFolderIds.add("beta");
  state.sidebar.selectedItem = { type: "folder", id: "delta" };
  return state;
}

function rows(state: RenderState): string[] {
  return buildDisplayRows(state.sidebar)
    .filter(row => row.type === "entry" && row.item && "id" in row.item)
    .map(row => (row.item as { id: string }).id);
}

function press(state: RenderState, char: string) {
  return handleFocusedKey({ type: "char", char }, state);
}

function reordered(...updates: [string, "folder" | "conversation", number][]): Event {
  return { type: "sidebar_items_reordered", updates: updates.map(([id, type, sortOrder]) => ({ item: { type, id }, sortOrder })) };
}

function selected(state: RenderState): string | undefined {
  return (state.sidebar.selectedItem as { id?: string } | null)?.id;
}

const TOP_AFTER_THREE_PRESSES = (view: SidebarFolderView) =>
  view === "tree" ? ["delta", "alpha", "beta", "b-child", "gamma", "c1"] : ["delta", "alpha", "beta", "gamma", "c1"];

// What the daemon sends back for three `e` presses on delta (3 → 2 → 1 → 0).
const ECHOES = [
  reordered(["delta", "folder", 2], ["gamma", "folder", 3]),
  reordered(["delta", "folder", 1], ["beta", "folder", 2]),
  reordered(["delta", "folder", 0], ["alpha", "folder", 1]),
];

for (const view of ["navigate", "tree"] as const) {
  describe(`optimistic folder move (${view} view)`, () => {
    test("e swaps the folder with the one above before any daemon answer", () => {
      const state = setup(view);
      const before = rows(state);
      const result = press(state, "e");

      expect(result).toMatchObject({ type: "move_sidebar_item", item: { type: "folder", id: "delta" }, direction: "up", reqId: expect.any(String) });
      const expected = [...before];
      expected.splice(expected.indexOf("gamma"), 2, "delta", "gamma");
      expect(rows(state)).toEqual(expected);
      expect(selected(state)).toBe("delta");
      expect(state.sidebar.folders.find(f => f.id === "delta")?.sortOrder).toBe(2);
      expect(state.sidebar.folders.find(f => f.id === "gamma")?.sortOrder).toBe(3);
    });

    test("Shift+E moves it down and the cursor follows", () => {
      const state = setup(view);
      state.sidebar.selectedItem = { type: "folder", id: "beta" };
      press(state, "E");
      expect(rows(state).slice(0, view === "tree" ? 4 : 3)).toEqual(view === "tree" ? ["alpha", "gamma", "beta", "b-child"] : ["alpha", "gamma", "beta"]);
      expect(selected(state)).toBe("beta");
    });

    test("an expanded folder stays expanded and keeps its contents when it moves", () => {
      const state = setup(view);
      state.sidebar.selectedItem = { type: "folder", id: "beta" };
      press(state, "e");
      expect(state.sidebar.expandedFolderIds.has("beta")).toBe(view === "tree");
      expect(rows(state)[0]).toBe("beta");
      if (view === "tree") expect(rows(state).slice(0, 3)).toEqual(["beta", "b-child", "alpha"]);
    });

    test("nothing is sent or changed where the daemon would refuse the swap", () => {
      const state = setup(view);
      state.sidebar.selectedItem = { type: "folder", id: "alpha" };
      const before = rows(state);
      expect(press(state, "e")).toEqual({ type: "handled" });
      expect(rows(state)).toEqual(before);
      // Pinned and unpinned rows never swap.
      state.sidebar.folders.find(f => f.id === "alpha")!.pinned = true;
      state.sidebar.selectedItem = { type: "folder", id: "beta" };
      expect(press(state, "e")).toEqual({ type: "handled" });
    });

    test("several presses before the first echo settle without jitter, whatever order the echoes arrive in", () => {
      for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1]]) {
        const state = setup(view);
        for (let i = 0; i < 3; i++) press(state, "e");
        const settled = TOP_AFTER_THREE_PRESSES(view);
        expect(rows(state)).toEqual(settled);
        expect(selected(state)).toBe("delta");

        for (const index of order) {
          handleEvent(ECHOES[index]!, state, daemon);
          expect(rows(state)).toEqual(settled);
          expect(selected(state)).toBe("delta");
        }
        expect(state.sidebar.pendingMoves).toHaveLength(0);
        expect(state.sidebar.folders.map(f => [f.id, f.sortOrder]).sort()).toEqual(
          [["alpha", 1], ["beta", 2], ["delta", 0], ["gamma", 3]]);
      }
    });

    test("opposite presses before the echoes do not double-apply", () => {
      const state = setup(view);
      press(state, "e");
      press(state, "E");
      const settled = rows(state);
      handleEvent(reordered(["delta", "folder", 2], ["gamma", "folder", 3]), state, daemon);
      expect(rows(state)).toEqual(settled);
      handleEvent(reordered(["delta", "folder", 3], ["gamma", "folder", 2]), state, daemon);
      expect(rows(state)).toEqual(settled);
      expect(state.sidebar.pendingMoves).toHaveLength(0);
    });

    test("the daemon's own orders win when they differ from the projection", () => {
      const state = setup(view);
      press(state, "e");
      handleEvent(reordered(["delta", "folder", 1.5], ["gamma", "folder", 3]), state, daemon);
      expect(state.sidebar.folders.find(f => f.id === "delta")?.sortOrder).toBe(1.5);
      expect(rows(state).indexOf("delta")).toBeLessThan(rows(state).indexOf("gamma"));
      expect(state.sidebar.pendingMoves).toHaveLength(0);
    });

    test("an unrelated authoritative update does not flicker pending presses back", () => {
      const state = setup(view);
      press(state, "e");
      press(state, "e");
      const settled = rows(state);
      // A full list and a single-summary update that predate both presses.
      handleEvent({
        type: "conversations_list",
        conversations: [conversation("b-child", 0, { folderId: "beta" }), conversation("c1", 4)],
        folders: [folder("alpha", 0), folder("beta", 1), folder("gamma", 2), folder("delta", 3)],
      }, state, daemon);
      expect(rows(state)).toEqual(settled);
      handleEvent({ type: "conversation_updated", summary: conversation("c1", 4, { title: "renamed" }) }, state, daemon);
      expect(rows(state)).toEqual(settled);
      expect(selected(state)).toBe("delta");
    });

    test("a refused move rolls back with a visible notice", () => {
      const state = setup(view);
      const before = rows(state);
      const result = press(state, "e");
      press(state, "e");
      expect(rows(state)).not.toEqual(before);

      // The daemon refuses with the authoritative list (nothing moved).
      handleEvent({
        type: "conversations_list",
        reqId: result.type === "move_sidebar_item" ? result.reqId : undefined,
        conversations: [conversation("b-child", 0, { folderId: "beta" }), conversation("c1", 4)],
        folders: [folder("alpha", 0), folder("beta", 1), folder("gamma", 2), folder("delta", 3)],
      }, state, daemon);

      expect(rows(state)).toEqual(before);
      expect(selected(state)).toBe("delta");
      expect(state.sidebar.pendingMoves).toHaveLength(0);
      expect(stripAnsi(state.messages.map(message => "text" in message ? message.text : "").join("\n"))).toContain("Could not move delta");
      // Late echoes of the dropped presses apply as plain authoritative state.
      handleEvent(reordered(["delta", "folder", 2], ["gamma", "folder", 3]), state, daemon);
      expect(rows(state).indexOf("delta")).toBeLessThan(rows(state).indexOf("gamma"));
    });

    test("an unanswered move stops masking authoritative state after it expires", () => {
      const state = setup(view);
      press(state, "e");
      state.sidebar.pendingMoves[0]!.expiresAt = Date.now() - 1;
      handleEvent({
        type: "conversations_list",
        conversations: [conversation("b-child", 0, { folderId: "beta" }), conversation("c1", 4)],
        folders: [folder("alpha", 0), folder("beta", 1), folder("gamma", 2), folder("delta", 3)],
      }, state, daemon);
      expect(state.sidebar.pendingMoves).toHaveLength(0);
      expect(rows(state).indexOf("gamma")).toBeLessThan(rows(state).indexOf("delta"));
    });

    test("a visual block with a folder moves at once and its patch echoes are not replayed", () => {
      const state = setup(view);
      state.sidebar.selectedItem = { type: "folder", id: "gamma" };
      press(state, "v");
      press(state, "j"); // extends to delta
      const snapshot = () => state.sidebar.folders.map(f => ({ ...f }));
      const first = press(state, "e");
      expect(first).toMatchObject({ type: "move_sidebar_items", parentId: null, reqId: expect.any(String) });
      expect(rows(state).slice(0, view === "tree" ? 5 : 4)).toEqual(view === "tree" ? ["alpha", "gamma", "delta", "beta", "b-child"] : ["alpha", "gamma", "delta", "beta"]);
      const afterFirst = snapshot();
      const second = press(state, "e");
      expect(second).toMatchObject({ type: "move_sidebar_items" });
      const settled = rows(state);
      expect(settled.slice(0, 2)).toEqual(["gamma", "delta"]);
      const afterSecond = snapshot();

      // The daemon's patches for the two presses arrive in reverse order.
      handleEvent({ type: "sidebar_state_patched", folders: afterSecond.filter(f => f.id === "gamma" || f.id === "delta") }, state, daemon);
      expect(rows(state)).toEqual(settled);
      handleEvent({ type: "sidebar_state_patched", folders: afterFirst.filter(f => f.id === "gamma" || f.id === "delta") }, state, daemon);
      expect(rows(state)).toEqual(settled);
      expect(state.sidebar.pendingMoves).toHaveLength(0);
    });
  });
}

describe("optimistic sidebar moves", () => {
  test("a conversation still swaps immediately", () => {
    const state = setup("navigate");
    state.sidebar.conversations = [conversation("c1", 0), conversation("c2", 1), conversation("c3", 2)];
    state.sidebar.folders = [];
    state.sidebar.selectedItem = { type: "conversation", id: "c3" };
    state.sidebar.selectedId = "c3";
    expect(press(state, "e")).toMatchObject({ type: "move_sidebar_item", item: { type: "conversation", id: "c3" }, direction: "up" });
    expect(state.sidebar.conversations.map(c => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "c3" });
    expect(state.sidebar.selectedIndex).toBe(1);
  });

  test("a folder moved out with < leaves the view with the cursor on a neighbour", () => {
    const state = setup("navigate");
    state.sidebar.currentFolderId = "beta";
    state.sidebar.folders.push(folder("inner", 5, { parentId: "beta" }));
    state.sidebar.selectedItem = { type: "folder", id: "inner" };
    expect(press(state, "<")).toMatchObject({ type: "move_sidebar_items", parentId: null, reqId: expect.any(String) });
    expect(state.sidebar.folders.find(f => f.id === "inner")?.parentId).toBeNull();
    expect(state.sidebar.selectedItem).not.toEqual({ type: "folder", id: "inner" });
  });

  test("the projection can be re-applied any number of times", () => {
    const state = setup("navigate");
    press(state, "e");
    const once = state.sidebar.folders.map(f => [f.id, f.sortOrder]);
    overlayPendingSidebarMoves(state.sidebar);
    overlayPendingSidebarMoves(state.sidebar);
    expect(state.sidebar.folders.map(f => [f.id, f.sortOrder])).toEqual(once);
  });
});
