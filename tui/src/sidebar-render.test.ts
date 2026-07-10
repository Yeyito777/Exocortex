import { describe, expect, test } from "bun:test";
import { createSidebarState, renderSidebar } from "./sidebar";
import type { ConversationSummary } from "./messages";
import { SIDEBAR_WIDTH } from "./sidebar/layout";
import { theme } from "./theme";
import { visibleLength } from "./textwidth";

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

describe("sidebar rendering", () => {
  test("keeps visual selection marker muted on the current conversation", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("current", 0, { title: "Current conversation" }),
      conversation("selected", 1, { title: "Selected conversation" }),
    ];
    sidebar.selectedItem = { type: "conversation", id: "selected" };
    sidebar.selectedId = "selected";
    sidebar.selectedIndex = 1;
    sidebar.visualAnchor = { type: "conversation", id: "current" };

    const rows = renderSidebar(sidebar, 8, true, "current");
    const currentRow = rows.find(row => row.includes("Current conversation"));

    expect(currentRow).toBeDefined();
    expect(currentRow).toContain(`${theme.muted}│ ${theme.text}${theme.bold}Current conversation`);
  });

  test("renders conversations with global-idle queued messages using a yellow streaming indicator", () => {
    const sidebar = createSidebarState();
    sidebar.conversations = [
      conversation("queued", 0, { title: "Queued conversation" }),
      conversation("plain", 1, { title: "Plain conversation" }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null, new Set(["queued"]));
    const queuedRow = rows.find(row => row.includes("Queued conversation"));
    const plainRow = rows.find(row => row.includes("Plain conversation"));

    expect(queuedRow).toContain(`${theme.warning}◉ `);
    expect(plainRow).not.toContain("◉ ");
  });

  test("propagates global-idle indicators to containing folders", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [{ id: "folder", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 }];
    sidebar.conversations = [
      conversation("queued", 0, { title: "Queued conversation", folderId: "folder" }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null, new Set(["queued"]));
    const folderRow = rows.find(row => row.includes("Work"));

    expect(folderRow).toContain(`${theme.warning}◉ `);
  });

  test("renders a right-aligned badge counting unread conversations in a folder tree", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "work", name: "Work", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "nested", name: "Nested", parentId: "work", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("read", 0, { folderId: "work" }),
      conversation("unread-direct", 1, { folderId: "work", unread: true }),
      conversation("unread-nested", 2, { folderId: "nested", unread: true }),
      conversation("unread-root", 3, { unread: true }),
    ];

    const rows = renderSidebar(sidebar, 8, true, null);
    const folderRow = rows.find(row => row.includes("Work"));

    expect(folderRow).toBeDefined();
    expect(folderRow).toContain(`${theme.notificationBg}${theme.notificationFg} 2 ${theme.reset}`);
    expect(visibleLength(folderRow!)).toBe(SIDEBAR_WIDTH);
  });

  test("does not render unread-count badges anywhere under top-level subagents", () => {
    const sidebar = createSidebarState();
    sidebar.folders = [
      { id: "subagents", name: " SubAgents ", parentId: null, createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
      { id: "batch", name: "Batch", parentId: "subagents", createdAt: 0, updatedAt: 0, pinned: false, sortOrder: 0 },
    ];
    sidebar.conversations = [
      conversation("direct-agent", 0, { folderId: "subagents", unread: true }),
      conversation("nested-agent", 1, { folderId: "batch", unread: true }),
    ];

    let rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("SubAgents"))).not.toContain(theme.notificationBg);

    sidebar.currentFolderId = "subagents";
    rows = renderSidebar(sidebar, 8, true, null);
    expect(rows.find(row => row.includes("Batch"))).not.toContain(theme.notificationBg);
  });
});
