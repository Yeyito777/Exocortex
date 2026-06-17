import { describe, expect, test } from "bun:test";
import { createSidebarState, renderSidebar } from "./sidebar";
import type { ConversationSummary } from "./messages";
import { theme } from "./theme";

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
});
