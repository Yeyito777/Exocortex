import { describe, expect, test } from "bun:test";
import { buildDisplayRows, createSidebarState, handleSidebarAction } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";
import type { SidebarState } from "./sidebar/state";

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

function entryIds(sidebar: SidebarState): string[] {
  const ids: string[] = [];
  for (const row of buildDisplayRows(sidebar)) {
    if (row.type !== "entry" || !row.item || row.item.type === "up" || row.item.type === "folder_instructions") continue;
    ids.push(`${row.item.type}:${row.item.id}`);
  }
  return ids;
}

describe("sidebar optimistic pinning", () => {
  test("pinning a conversation places it at the bottom of the pinned section", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned-a", 0, { pinned: true }),
      conversation("pinned-b", 1, { pinned: true }),
      conversation("target", -100),
      conversation("unpinned", 2),
    ];
    sidebar.selectedItem = { type: "conversation", id: "target" };

    expect(handleSidebarAction("pin", sidebar)).toEqual({ type: "pin_conversation", convId: "target", pinned: true });

    expect(sidebar.conversations.find(conv => conv.id === "target")).toMatchObject({ pinned: true, sortOrder: 2 });
    expect(entryIds(sidebar)).toEqual([
      "conversation:pinned-a",
      "conversation:pinned-b",
      "conversation:target",
      "conversation:unpinned",
    ]);
  });

  test("pinning uses the combined folder/conversation sibling order", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [folder("folder-pinned", 10, { pinned: true })];
    sidebar.conversations = [
      conversation("conv-pinned", 5, { pinned: true }),
      conversation("target", -100),
    ];
    sidebar.selectedItem = { type: "conversation", id: "target" };

    expect(handleSidebarAction("pin", sidebar)).toEqual({ type: "pin_conversation", convId: "target", pinned: true });

    expect(sidebar.conversations.find(conv => conv.id === "target")).toMatchObject({ pinned: true, sortOrder: 11 });
    expect(entryIds(sidebar)).toEqual([
      "conversation:conv-pinned",
      "folder:folder-pinned",
      "conversation:target",
    ]);
  });

  test("pinning a visual selection pins all selected conversations", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("conv-a", 1),
      conversation("conv-b", 2),
      conversation("conv-c", 3),
    ];
    sidebar.visualAnchor = { type: "conversation", id: "conv-a" };
    sidebar.selectedItem = { type: "conversation", id: "conv-b" };

    expect(handleSidebarAction("pin", sidebar)).toEqual({
      type: "pin_sidebar_items",
      pins: [
        { item: { type: "conversation", id: "conv-a" }, pinned: true },
        { item: { type: "conversation", id: "conv-b" }, pinned: true },
      ],
    });

    expect(sidebar.visualAnchor).toBeNull();
    expect(sidebar.conversations.find(conv => conv.id === "conv-a")).toMatchObject({ pinned: true, sortOrder: 1 });
    expect(sidebar.conversations.find(conv => conv.id === "conv-b")).toMatchObject({ pinned: true, sortOrder: 2 });
    expect(entryIds(sidebar)).toEqual([
      "conversation:pinned",
      "conversation:conv-a",
      "conversation:conv-b",
      "conversation:conv-c",
    ]);
  });

  test("unpinning a visual selection preserves the selected conversation order at the top of unpinned", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("pinned", 0, { pinned: true }),
      conversation("conv-a", 1, { pinned: true }),
      conversation("conv-b", 2, { pinned: true }),
      conversation("unpinned", 3),
    ];
    sidebar.visualAnchor = { type: "conversation", id: "conv-a" };
    sidebar.selectedItem = { type: "conversation", id: "conv-b" };

    expect(handleSidebarAction("pin", sidebar)).toEqual({
      type: "pin_sidebar_items",
      pins: [
        { item: { type: "conversation", id: "conv-b" }, pinned: false },
        { item: { type: "conversation", id: "conv-a" }, pinned: false },
      ],
    });

    expect(sidebar.visualAnchor).toBeNull();
    expect(sidebar.conversations.find(conv => conv.id === "conv-a")).toMatchObject({ pinned: false, sortOrder: -2 });
    expect(sidebar.conversations.find(conv => conv.id === "conv-b")).toMatchObject({ pinned: false, sortOrder: -1 });
    expect(entryIds(sidebar)).toEqual([
      "conversation:pinned",
      "conversation:conv-a",
      "conversation:conv-b",
      "conversation:unpinned",
    ]);
  });
});
