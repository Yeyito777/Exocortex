import { describe, expect, test } from "bun:test";
import type { ConversationSummary, FolderSummary } from "./messages";
import { handleSidebarAction, updateConversationList } from "./sidebar";
import { handleConversationDeleted } from "./events/conversations";
import { requestFocusAfterMovingItemsOutOfView } from "./sidebar/folderactions";
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

    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "above" });
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
