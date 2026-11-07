import { describe, expect, test } from "bun:test";
import { handleConversationDeleted } from "./events/conversations";
import type { ConversationSummary } from "./messages";
import { addOptimisticConversation, removeOptimisticConversation } from "./sidebar/optimisticconversations";
import { conversationById } from "./sidebar/state";
import { updateConversation, updateConversationList } from "./sidebar/updates";
import { clearUnreadLocally, createInitialState, focusedConversation, markStoppedLocally } from "./state";

function summary(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, title: id, provider: "anthropic", model: "claude-opus-5-5", effort: "high", fastMode: "off",
    createdAt: 1, updatedAt: 1, messageCount: 1, marked: false, pinned: false, streaming: false,
    unread: false, sortOrder: 0, ...extra,
  } as ConversationSummary;
}

/** The index must always give the summary the list holds now. */
function expectIndexMatchesList(state: ReturnType<typeof createInitialState>, gone: string[] = []): void {
  for (const conversation of state.sidebar.conversations) expect(conversationById(state.sidebar, conversation.id)).toBe(conversation);
  for (const id of gone) expect(conversationById(state.sidebar, id)).toBeUndefined();
}

describe("the sidebar's conversation index", () => {
  test("follows the list replaced, patched, extended, reordered and shrunk", () => {
    const state = createInitialState();
    updateConversationList(state.sidebar, ["a", "b", "c"].map(id => summary(id)));
    state.convId = "b";
    expect(focusedConversation(state)?.title).toBe("b");
    // Replaced wholesale.
    updateConversationList(state.sidebar, ["b", "d"].map(id => summary(id, { title: `${id}2` })));
    expect(focusedConversation(state)?.title).toBe("b2");
    expectIndexMatchesList(state, ["a", "c"]);
    // A summary patched, and a new one added.
    updateConversation(state.sidebar, summary("b", { title: "b3", streaming: true }));
    updateConversation(state.sidebar, summary("e", { sortOrder: -1 }));
    expect(focusedConversation(state)?.title).toBe("b3");
    expectIndexMatchesList(state);
    // Reordered (sorted in place): same summaries, other places.
    state.sidebar.conversations.reverse();
    expectIndexMatchesList(state);
    // Deleted by another client.
    handleConversationDeleted({ type: "conversation_deleted", convId: "b" }, state);
    expect(focusedConversation(state)).toBeUndefined();
    expectIndexMatchesList(state, ["b"]);
  });

  test("optimistic rows, local unread and local stops replace summaries through it", () => {
    const state = createInitialState();
    updateConversationList(state.sidebar, [summary("a", { unread: true, streaming: true })]);
    state.convId = "a";
    expect(focusedConversation(state)?.unread).toBe(true);
    clearUnreadLocally(state, "a");
    expect(focusedConversation(state)?.unread).toBe(false);
    markStoppedLocally(state, "a", null);
    expect(focusedConversation(state)?.streaming).toBe(false);
    expectIndexMatchesList(state);
    addOptimisticConversation(state.sidebar, { convId: "new", title: "New", folderId: null } as never);
    expect(conversationById(state.sidebar, "new")?.title).toBe("New");
    removeOptimisticConversation(state.sidebar, "new");
    expectIndexMatchesList(state, ["new"]);
  });

  test("a list grown in place some other way is found on a miss", () => {
    const state = createInitialState();
    state.sidebar.conversations = [summary("a")];
    expect(conversationById(state.sidebar, "a")?.id).toBe("a");
    state.sidebar.conversations.push(summary("late"));
    expect(conversationById(state.sidebar, "late")?.id).toBe("late");
  });
});
