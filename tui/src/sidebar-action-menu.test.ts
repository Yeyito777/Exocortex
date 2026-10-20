import { describe, expect, test } from "bun:test";

import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { MouseEvent } from "./input";
import { SIDEBAR_WIDTH, updateConversationList } from "./sidebar";
import { createInitialState, type RenderState } from "./state";
import { openFolderInstructionsEditor, type InstructionsDaemon } from "./instructions/controller";

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

function sidebarState() {
  const state = createInitialState();
  state.rows = 20;
  state.cols = 80;
  state.sidebar.open = true;
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
  state.sidebar.conversations = [conversation("conv-a", 0), conversation("conv-b", 1)];
  state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
  state.sidebar.selectedId = "conv-a";
  state.sidebar.selectedIndex = 0;
  return state;
}

function mouseEvent(
  col: number,
  row: number,
  button: number,
  action: MouseEvent["action"],
): MouseEvent {
  return { type: "mouse", col, row, button, action, shift: false, meta: false, ctrl: false };
}

describe("sidebar conversation actions", () => {
  test("semicolon opens a menu for the selected conversation", () => {
    const state = sidebarState();

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu).toMatchObject({
      item: { type: "conversation", id: "conv-a" },
      selection: "copy_id",
      marked: false,
      pinned: false,
    });
  });

  test("star and pin menu actions reuse normal optimistic sidebar mutations", () => {
    const state = sidebarState();
    handleFocusedKey({ type: "char", char: ";" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "mark_conversation",
      convId: "conv-a",
      marked: true,
    });
    expect(state.sidebar.conversations[0]?.marked).toBe(true);
    expect(state.sidebar.actionMenu).toBeNull();

    handleFocusedKey({ type: "char", char: ";" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "pin_conversation",
      convId: "conv-a",
      pinned: true,
    });
    expect(state.sidebar.conversations.find(conv => conv.id === "conv-a")?.pinned).toBe(true);
  });

  test("delete asks for confirmation, then emits the ordinary delete result", () => {
    const state = sidebarState();
    handleFocusedKey({ type: "char", char: ";" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);
    handleFocusedKey({ type: "char", char: "j" }, state);

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu?.deleteConfirmation).toBe(true);
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({
      type: "delete_conversation",
      convId: "conv-a",
    });
    expect(state.sidebar.conversations.map(conv => conv.id)).toEqual(["conv-b"]);
  });

  test("escape closes the menu without changing the conversation", () => {
    const state = sidebarState();
    handleFocusedKey({ type: "char", char: ";" }, state);

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu).toBeNull();
    expect(state.sidebar.conversations).toHaveLength(2);
  });

  test("mouse hover selects the conversation targeted by semicolon", () => {
    const state = sidebarState();
    state.panelFocus = "chat";
    state.mouseCursor = "hand";

    handleMouseEvent({
      type: "mouse",
      button: 3,
      col: 5,
      row: 4,
      action: "motion",
      shift: false,
      meta: false,
      ctrl: false,
    }, state);

    expect(state.panelFocus as "chat" | "sidebar").toBe("sidebar");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "conv-b" });
    handleFocusedKey({ type: "char", char: ";" }, state);
    expect(state.sidebar.actionMenu?.item).toEqual({ type: "conversation", id: "conv-b" });
  });

  test("right click opens the menu for the conversation under the pointer", () => {
    const state = sidebarState();
    state.panelFocus = "chat";
    state.mouseCursor = "hand";

    expect(handleMouseEvent({
      type: "mouse",
      button: 2,
      col: 5,
      row: 4,
      action: "press",
      shift: false,
      meta: false,
      ctrl: false,
    }, state)).toEqual({ type: "handled" });

    expect(state.panelFocus as "chat" | "sidebar").toBe("sidebar");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "conv-b" });
    expect(state.sidebar.actionMenu).toMatchObject({
      item: { type: "conversation", id: "conv-b" },
      selection: "copy_id",
      marked: false,
      pinned: false,
    });
  });

  test("hover highlights a menu item and left click runs its action", () => {
    const state = sidebarState();
    state.mouseCursor = "hand";
    handleFocusedKey({ type: "char", char: ";" }, state);

    expect(handleMouseEvent(
      mouseEvent(SIDEBAR_WIDTH + 3, 5, 3, "motion"),
      state,
    )).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu?.selection).toBe("toggle_star");

    expect(handleMouseEvent(
      mouseEvent(SIDEBAR_WIDTH + 3, 5, 0, "press"),
      state,
    )).toEqual({
      type: "mark_conversation",
      convId: "conv-a",
      marked: true,
    });
    expect(state.sidebar.actionMenu).toBeNull();
    expect(state.sidebar.conversations[0]?.marked).toBe(true);
  });

  test("clicking Delete confirms once and deletes on the second click", () => {
    const state = sidebarState();
    state.mouseCursor = "hand";
    handleFocusedKey({ type: "char", char: ";" }, state);
    const clickDelete = () => handleMouseEvent(
      mouseEvent(SIDEBAR_WIDTH + 3, 7, 0, "press"),
      state,
    );

    expect(clickDelete()).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu).toMatchObject({
      selection: "delete",
      deleteConfirmation: true,
    });
    expect(clickDelete()).toEqual({ type: "delete_conversation", convId: "conv-a" });
    expect(state.sidebar.actionMenu).toBeNull();
    expect(state.sidebar.conversations.map(conv => conv.id)).toEqual(["conv-b"]);
  });

  test("left click outside the menu closes it", () => {
    const state = sidebarState();
    state.mouseCursor = "pointer";
    handleFocusedKey({ type: "char", char: ";" }, state);

    expect(handleMouseEvent(mouseEvent(60, 10, 0, "press"), state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu).toBeNull();
  });
});

function folder(id: string, sortOrder: number, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return { id, name: id, parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder, effectiveInstructions: "", ...overrides };
}

/** Folder "work" (row 3) above conversations "conv-a" (row 4) and "conv-b" (row 5). */
function folderSidebarState() {
  const state = sidebarState();
  state.sidebar.folders = [folder("work", -1, { effectiveInstructions: "# Context from AGENTS.md:\nShip it." })];
  state.sidebar.selectedItem = { type: "folder", id: "work" };
  state.sidebar.selectedId = null;
  return state;
}

function fakeDaemon(): InstructionsDaemon & { loads: Array<[string | null, string | null]> } {
  const loads: Array<[string | null, string | null]> = [];
  return {
    loads,
    loadInstructions: (convId, folderId) => { loads.push([convId, folderId]); return `load-${loads.length}`; },
    setSystemInstructions: () => "save",
    setFolderInstructions: () => "save",
    setGlobalInstructions: () => "save",
  };
}

/** What main.ts does with the result: open the instructions editor. */
function openEditorFor(state: RenderState, result: ReturnType<typeof handleFocusedKey>, daemon: InstructionsDaemon): void {
  if (result.type === "open_folder_instructions") openFolderInstructionsEditor(state, daemon, result.folderId);
}

describe("sidebar folder actions", () => {
  test("semicolon on a folder opens its menu on Edit instructions with a preview", () => {
    const state = folderSidebarState();

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu).toMatchObject({
      item: { type: "folder", id: "work" },
      selection: "edit_instructions",
      instructions: "Ship it.",
    });
  });

  test("Edit instructions opens the centred editor on that folder's scope", () => {
    const state = folderSidebarState();
    const daemon = fakeDaemon();
    handleFocusedKey({ type: "char", char: ";" }, state);

    const result = handleFocusedKey({ type: "enter" }, state);
    expect(result).toEqual({ type: "open_folder_instructions", folderId: "work" });
    expect(state.sidebar.actionMenu).toBeNull();

    openEditorFor(state, result, daemon);
    expect(state.instructionsModal?.picker).toBeNull();
    expect(state.instructionsModal?.editor).toMatchObject({ scope: "folder", target: { folderId: "work", folderName: "work", convId: null } });
    expect(daemon.loads).toEqual([[null, "work"]]);
  });

  test("right click on a folder opens its menu without entering it", () => {
    const state = folderSidebarState();
    state.panelFocus = "chat";
    state.sidebar.selectedItem = { type: "conversation", id: "conv-b" };
    state.mouseCursor = "hand";

    expect(handleMouseEvent(mouseEvent(5, 3, 2, "press"), state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "work" });
    expect(state.sidebar.currentFolderId).toBeNull();
    expect(state.sidebar.actionMenu?.item).toEqual({ type: "folder", id: "work" });
  });

  test("right click then a left click on Edit instructions opens the folder editor", () => {
    const state = folderSidebarState();
    state.mouseCursor = "hand";
    handleMouseEvent(mouseEvent(5, 3, 2, "press"), state);

    const result = handleMouseEvent(mouseEvent(SIDEBAR_WIDTH + 3, 4, 0, "press"), state);
    expect(result).toEqual({ type: "open_folder_instructions", folderId: "work" });
    expect(state.sidebar.actionMenu).toBeNull();
  });

  test("left click on a folder still enters it and opens no menu", () => {
    const state = folderSidebarState();
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };

    expect(handleMouseEvent(mouseEvent(5, 3, 0, "press"), state)).toEqual({ type: "handled" });
    expect(state.sidebar.currentFolderId).toBe("work");
    expect(state.sidebar.actionMenu).toBeNull();
  });

  test("left click on a conversation still loads it and opens no menu", () => {
    const state = sidebarState();

    expect(handleMouseEvent(mouseEvent(5, 4, 0, "press"), state)).toEqual({ type: "load_conversation", convId: "conv-b" });
    expect(state.sidebar.actionMenu).toBeNull();
  });

  test("pin, mute, rename, unwrap and delete reuse the ordinary folder paths", () => {
    const pick = (state: RenderState, steps: number) => {
      handleFocusedKey({ type: "char", char: ";" }, state);
      for (let i = 0; i < steps; i++) handleFocusedKey({ type: "char", char: "j" }, state);
      return handleFocusedKey({ type: "enter" }, state);
    };

    const state = folderSidebarState();
    expect(pick(state, 2)).toEqual({ type: "pin_folder", folderId: "work", pinned: true });
    expect(pick(state, 3)).toEqual({ type: "mute_folder", folderId: "work", muted: true });
    expect(state.sidebar.folders[0]?.muted).toBe(true);

    expect(pick(state, 1)).toEqual({ type: "handled" });
    expect(state.sidebar.prompt).toMatchObject({ purpose: "rename_folder", folderId: "work" });
    state.sidebar.prompt = null;

    expect(pick(state, 4)).toEqual({ type: "delete_folder", folderId: "work", mode: "unwrap" });

    handleFocusedKey({ type: "char", char: ";" }, state);
    for (let i = 0; i < 5; i++) handleFocusedKey({ type: "char", char: "j" }, state);
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.actionMenu?.deleteConfirmation).toBe(true);
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "delete_folder", folderId: "work", mode: "recursive" });
  });

  test("Rename from a right-click menu hands keys to the sidebar's rename bar", () => {
    const state = folderSidebarState();
    state.mouseCursor = "hand";
    handleMouseEvent(mouseEvent(5, 3, 2, "press"), state);
    state.panelFocus = "chat";

    handleMouseEvent(mouseEvent(SIDEBAR_WIDTH + 3, 5, 0, "press"), state);
    expect(state.sidebar.prompt).toMatchObject({ purpose: "rename_folder", folderId: "work" });
    expect(state.panelFocus as "chat" | "sidebar").toBe("sidebar");
  });

  test("semicolon and right click on the .. row open nothing", () => {
    const state = folderSidebarState();
    state.sidebar.currentFolderId = "work";
    state.sidebar.conversations = [conversation("inside", 0, { folderId: "work" })];
    state.sidebar.selectedItem = { type: "up" };

    handleFocusedKey({ type: "char", char: ";" }, state);
    expect(state.sidebar.actionMenu).toBeNull();
    handleMouseEvent(mouseEvent(5, 3, 2, "press"), state);
    expect(state.sidebar.actionMenu).toBeNull();
  });

  test("the menu closes when its folder disappears from the sidebar", () => {
    const state = folderSidebarState();
    handleFocusedKey({ type: "char", char: ";" }, state);
    expect(state.sidebar.actionMenu).not.toBeNull();

    updateConversationList(state.sidebar, state.sidebar.conversations, []);
    expect(state.sidebar.actionMenu).toBeNull();
  });
});
