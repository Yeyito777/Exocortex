import { describe, expect, test } from "bun:test";
import { createSidebarState, handleSidebarAction } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";

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

describe("sidebar streaming navigation", () => {
  test("jumps to a folder with a descendant streaming conversation", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("project", 2)];
    sidebar.conversations = [
      conversation("root", 1),
      conversation("inside", 1, { folderId: "project", streaming: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "root" };
    sidebar.selectedId = "root";
    sidebar.selectedIndex = 0;

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });

    expect(sidebar.currentFolderId).toBeNull();
    expect(sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "project" });
  });

  test("uses visible sidebar order and wraps across folder streaming indicators", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("project", 1)];
    sidebar.conversations = [
      conversation("root-stream", 2, { unread: true }),
      conversation("inside", 1, { folderId: "project", streaming: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "root-stream" };
    sidebar.selectedId = "root-stream";
    sidebar.selectedIndex = 0;

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "project" });

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "root-stream" });
  });

  test("jumps to a nested folder with descendant unread conversation", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "work";
    sidebar.folders = [
      folder("work", 1),
      folder("client", 1, { parentId: "work" }),
    ];
    sidebar.conversations = [
      conversation("work-chat", 1, { folderId: "work" }),
      conversation("client-chat", 1, { folderId: "client", unread: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "work-chat" };
    sidebar.selectedId = "work-chat";
    sidebar.selectedIndex = 0;

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });

    expect(sidebar.currentFolderId).toBe("work");
    expect(sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "client" });
  });

  test("skips completed subagents whose unread indicators are hidden", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      folder("subagents", 1, { name: " SubAgents " }),
      folder("batch", 1, { parentId: "subagents" }),
    ];
    sidebar.conversations = [
      conversation("start", 0),
      conversation("direct-agent", 0, { folderId: "subagents", unread: true }),
      conversation("nested-agent", 0, { folderId: "batch", unread: true }),
      conversation("ordinary-complete", 2, { unread: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "start" };
    sidebar.selectedId = "start";
    sidebar.selectedIndex = 0;

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "ordinary-complete" });

    sidebar.currentFolderId = "subagents";
    sidebar.selectedItem = { type: "up" };
    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.selectedItem).toEqual({ type: "up" });
  });

  test("still jumps to subagents while they are actively streaming", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("subagents", 1, { name: "subagents" })];
    sidebar.conversations = [
      conversation("start", 0),
      conversation("agent", 0, { folderId: "subagents", streaming: true, unread: true }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "start" };
    sidebar.selectedId = "start";
    sidebar.selectedIndex = 0;

    expect(handleSidebarAction("nav_next_streaming", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "subagents" });
  });
});
