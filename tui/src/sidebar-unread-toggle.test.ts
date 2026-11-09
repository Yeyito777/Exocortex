import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import { handleConversationUpdated, handleConversationsList } from "./events/conversations";
import type { ConversationSummary } from "./messages";
import { createInitialState, noteConversationOpenRequest } from "./state";

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

function sidebarState(selected: string) {
  const state = createInitialState();
  state.sidebar.open = true;
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
  state.sidebar.conversations = [
    conversation("open", 1),
    conversation("starred", 2, { marked: true }),
    conversation("muted", 3, { muted: true }),
  ];
  state.convId = "open";
  noteConversationOpenRequest(state, "open", "open-req");
  state.sidebar.selectedItem = { type: "conversation", id: selected };
  return state;
}

const summaryOf = (state: ReturnType<typeof sidebarState>, id: string) => state.sidebar.conversations.find(conv => conv.id === id)!;

describe("m in the sidebar", () => {
  test("marks the conversation unread through the daemon, leaves its star, and t then finds it", () => {
    const state = sidebarState("starred");

    expect(handleFocusedKey({ type: "char", char: "m" }, state)).toEqual({ type: "set_conversation_unread", convId: "starred", unread: true });
    expect(summaryOf(state, "starred")).toMatchObject({ unread: true, marked: true });

    expect(handleFocusedKey({ type: "char", char: "t" }, state)).toEqual({ type: "load_conversation", convId: "starred" });

    // Already unread: m marks it read.
    state.sidebar.selectedItem = { type: "conversation", id: "starred" };
    expect(handleFocusedKey({ type: "char", char: "m" }, state)).toEqual({ type: "set_conversation_unread", convId: "starred", unread: false });
    expect(summaryOf(state, "starred")).toMatchObject({ unread: false, marked: true });
  });

  test("does nothing on a muted conversation, which cannot show unread", () => {
    const state = sidebarState("muted");

    expect(handleFocusedKey({ type: "char", char: "m" }, state)).toEqual({ type: "handled" });
    expect(summaryOf(state, "muted").unread).toBe(false);
  });

  test("the open conversation keeps an unread mark the user gave it, until it is opened again", () => {
    const state = sidebarState("open");

    expect(handleFocusedKey({ type: "char", char: "m" }, state)).toEqual({ type: "set_conversation_unread", convId: "open", unread: true });
    handleConversationUpdated({ type: "conversation_updated", summary: conversation("open", 1, { unread: true }) }, state);
    expect(summaryOf(state, "open").unread).toBe(true);
    handleConversationsList({ type: "conversations_list", conversations: [conversation("open", 1, { unread: true })] }, state);
    expect(summaryOf(state, "open").unread).toBe(true);

    // Opening it again reads it, and a summary sent before that open landed stays hidden.
    noteConversationOpenRequest(state, "open", "reopen-req");
    expect(summaryOf(state, "open").unread).toBe(false);
    handleConversationUpdated({ type: "conversation_updated", summary: conversation("open", 1, { unread: true }) }, state);
    expect(summaryOf(state, "open").unread).toBe(false);
  });
});
