import { describe, expect, test } from "bun:test";
import type { ConversationSummary, FolderSummary } from "./messages";
import { createSidebarState, handleSidebarKey } from "./sidebar";

function conversation(id: string, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 0,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    ...overrides,
  };
}

function folder(id: string, overrides: Partial<FolderSummary> = {}): FolderSummary {
  return {
    id,
    name: id,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    sortOrder: 0,
    ...overrides,
  };
}

describe("sidebar muting", () => {
  test("Shift+M optimistically toggles an individual conversation", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [conversation("selected", { unread: true })];
    sidebar.selectedItem = { type: "conversation", id: "selected" };
    sidebar.selectedId = "selected";

    expect(handleSidebarKey({ type: "char", char: "M" }, sidebar)).toEqual({
      type: "mute_conversation",
      convId: "selected",
      muted: true,
    });
    expect(sidebar.conversations[0]).toMatchObject({ muted: true, notificationsMuted: true, unread: false });

    expect(handleSidebarKey({ type: "char", char: "M" }, sidebar)).toEqual({
      type: "mute_conversation",
      convId: "selected",
      muted: false,
    });
    expect(sidebar.conversations[0]).toMatchObject({ muted: false, notificationsMuted: false, unread: false });
  });

  test("Shift+M on a folder recomputes inherited mute state for all descendants", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("parent"), folder("child", { parentId: "parent" })];
    sidebar.conversations = [
      conversation("direct", { folderId: "parent", unread: true }),
      conversation("nested", { folderId: "child", unread: true }),
      conversation("root", { unread: true }),
    ];
    sidebar.selectedItem = { type: "folder", id: "parent" };
    sidebar.selectedId = null;

    expect(handleSidebarKey({ type: "char", char: "M" }, sidebar)).toEqual({
      type: "mute_folder",
      folderId: "parent",
      muted: true,
    });
    expect(sidebar.folders[0]?.muted).toBe(true);
    expect(sidebar.conversations.find(conv => conv.id === "direct")).toMatchObject({ notificationsMuted: true, unread: false });
    expect(sidebar.conversations.find(conv => conv.id === "nested")).toMatchObject({ notificationsMuted: true, unread: false });
    expect(sidebar.conversations.find(conv => conv.id === "root")).toMatchObject({ notificationsMuted: false, unread: true });
  });
});
