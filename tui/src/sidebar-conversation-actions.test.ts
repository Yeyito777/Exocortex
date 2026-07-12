import { describe, expect, test } from "bun:test";

import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import type { ConversationSummary } from "./messages";
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

describe("sidebar conversation actions", () => {
  test("semicolon opens a menu for the selected conversation", () => {
    const state = sidebarState();

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.conversationActionMenu).toMatchObject({
      convId: "conv-a",
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
    expect(state.sidebar.conversationActionMenu).toBeNull();

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
    expect(state.sidebar.conversationActionMenu?.deleteConfirmation).toBe(true);
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
    expect(state.sidebar.conversationActionMenu).toBeNull();
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
    expect(state.sidebar.conversationActionMenu?.convId).toBe("conv-b");
  });
});
