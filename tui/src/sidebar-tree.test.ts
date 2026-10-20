import { describe, expect, test } from "bun:test";
import {
  buildDisplayRows,
  createSidebarState,
  focusConversationById,
  handleSidebarAction,
  handleSidebarKey,
  handleSidebarPromptKey,
  renderSidebar,
  updateConversationList,
} from "./sidebar";
import type { KeyEvent } from "./input";
import type { ConversationSummary, FolderSummary } from "./messages";
import { stripAnsi } from "./historycursor";
import { setSidebarFolderView } from "./sidebar/folderview";
import type { SidebarState } from "./sidebar/state";
import { newConversationFolderId } from "./sidebar/tree";
import { handleSidebarSearchBarKey, openSidebarCommandBar, openSidebarSearchBar } from "./sidebarsearch";

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

/**
 * work/
 *   nested/
 *     deep
 *   inside-a
 *   inside-b
 * root-a
 * root-b
 */
function treeSidebar(): SidebarState {
  const sidebar = createSidebarState("tree");
  updateConversationList(sidebar, [
    conversation("root-a", 2),
    conversation("root-b", 3),
    conversation("inside-a", 2, { folderId: "work" }),
    conversation("inside-b", 3, { folderId: "work" }),
    conversation("deep", 1, { folderId: "nested" }),
  ], [
    folder("work", 1),
    folder("nested", 1, { parentId: "work" }),
  ]);
  return sidebar;
}

function rowKeys(sidebar: SidebarState): string[] {
  return buildDisplayRows(sidebar).map(row => {
    const indent = "  ".repeat(row.depth ?? 0);
    if (row.type !== "entry") return `${indent}${row.type}`;
    const item = row.item!;
    return `${indent}${item.type === "up" ? ".." : item.id}`;
  });
}

function key(char: string): KeyEvent {
  return { type: "char", char } as KeyEvent;
}

function focus(sidebar: SidebarState, item: SidebarState["selectedItem"]): void {
  handleSidebarAction("noop", sidebar);
  sidebar.selectedItem = item;
  sidebar.selectedId = item?.type === "conversation" ? item.id : null;
}

describe("sidebar tree folder view", () => {
  test("lists collapsed folders in place and expands their contents below them", () => {
    const sidebar = treeSidebar();
    expect(rowKeys(sidebar)).toEqual(["work", "root-a", "root-b"]);

    sidebar.expandedFolderIds.add("work");
    expect(rowKeys(sidebar)).toEqual([
      "work",
      "  nested",
      "  inside-a",
      "  inside-b",
      "root-a",
      "root-b",
    ]);

    sidebar.expandedFolderIds.add("nested");
    expect(rowKeys(sidebar)).toContain("    deep");
  });

  test("an expanded child of a collapsed folder stays hidden", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("nested");
    expect(rowKeys(sidebar)).toEqual(["work", "root-a", "root-b"]);
  });

  test("l expands a folder in place, then steps into it", () => {
    const sidebar = treeSidebar();
    focus(sidebar, { type: "folder", id: "work" });

    handleSidebarKey(key("l"), sidebar);
    expect(sidebar.expandedFolderIds.has("work")).toBe(true);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "work" });
    expect(sidebar.currentFolderId).toBeNull();

    handleSidebarKey(key("l"), sidebar);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "nested" });
    expect(sidebar.currentFolderId).toBe("work");
  });

  test("Enter and clicks toggle a folder without leaving the list", () => {
    const sidebar = treeSidebar();
    focus(sidebar, { type: "folder", id: "work" });

    handleSidebarAction("nav_select", sidebar);
    expect(sidebar.expandedFolderIds.has("work")).toBe(true);
    handleSidebarAction("nav_select", sidebar);
    expect(sidebar.expandedFolderIds.has("work")).toBe(false);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "work" });
  });

  test("h collapses the folder listing the cursor and lands on it", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "conversation", id: "inside-b" });

    handleSidebarKey(key("h"), sidebar);
    expect(sidebar.expandedFolderIds.has("work")).toBe(false);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "work" });
    expect(sidebar.currentFolderId).toBeNull();
  });

  test("h on an expanded folder collapses that folder", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    sidebar.expandedFolderIds.add("nested");
    focus(sidebar, { type: "folder", id: "nested" });

    handleSidebarKey({ type: "backspace" } as KeyEvent, sidebar);
    expect(sidebar.expandedFolderIds.has("nested")).toBe(false);
    expect(sidebar.expandedFolderIds.has("work")).toBe(true);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "nested" });
  });

  test("j/k walk through expanded contents and the folder context follows the cursor", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "folder", id: "work" });

    handleSidebarAction("nav_down", sidebar);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "nested" });
    expect(sidebar.currentFolderId).toBe("work");

    handleSidebarAction("nav_down", sidebar);
    handleSidebarAction("nav_down", sidebar);
    handleSidebarAction("nav_down", sidebar);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "root-a" });
    expect(sidebar.currentFolderId).toBeNull();
  });

  test("Ctrl+P files into the cursor's folder and Ctrl+Shift+O at the top level", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");

    focus(sidebar, { type: "folder", id: "nested" });
    expect(newConversationFolderId(sidebar, "selected")).toBe("nested");
    expect(newConversationFolderId(sidebar, "top_level")).toBeNull();

    focus(sidebar, { type: "conversation", id: "inside-a" });
    expect(newConversationFolderId(sidebar, "selected")).toBe("work");

    focus(sidebar, { type: "conversation", id: "root-b" });
    expect(newConversationFolderId(sidebar, "selected")).toBeNull();
  });

  test("the navigate view keeps filing both shortcuts in the open folder", () => {
    const sidebar = treeSidebar();
    setSidebarFolderView(sidebar, "navigate");
    sidebar.currentFolderId = "work";
    focus(sidebar, { type: "folder", id: "nested" });
    expect(newConversationFolderId(sidebar, "selected")).toBe("work");
    expect(newConversationFolderId(sidebar, "top_level")).toBe("work");
  });

  test("focusing a nested conversation expands every folder above it", () => {
    const sidebar = treeSidebar();
    expect(focusConversationById(sidebar, "deep")).toBe(true);
    expect(sidebar.expandedFolderIds).toEqual(new Set(["work", "nested"]));
    expect(sidebar.currentFolderId).toBe("nested");
    expect(rowKeys(sidebar)).toContain("    deep");
  });

  test("deleting a nested conversation keeps the cursor inside its folder", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "conversation", id: "inside-a" });

    handleSidebarAction("delete", sidebar);
    expect(handleSidebarAction("delete", sidebar)).toEqual({ type: "delete_conversation", convId: "inside-a" });
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "nested" });

    // The first row of a level falls to its next sibling, not into another folder.
    sidebar.expandedFolderIds.add("nested");
    sidebar.conversations.push(conversation("deep-2", 2, { folderId: "nested" }));
    focus(sidebar, { type: "conversation", id: "deep" });
    handleSidebarAction("delete", sidebar);
    handleSidebarAction("delete", sidebar);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "deep-2" });
  });

  test("moving a visual block that spans a folder and its contents moves only the folder", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "folder", id: "work" });
    handleSidebarKey(key("V"), sidebar);
    for (let i = 0; i < 3; i++) handleSidebarAction("nav_down", sidebar);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "inside-b" });

    handleSidebarKey(key("F"), sidebar);
    expect(sidebar.prompt?.items).toEqual([{ type: "folder", id: "work" }]);
  });

  test("a visual block reorders among its siblings past an expanded folder", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "conversation", id: "root-a" });
    handleSidebarKey(key("V"), sidebar);
    handleSidebarAction("nav_down", sidebar);
    expect(handleSidebarAction("move_up", sidebar)).toEqual({
      type: "move_sidebar_items",
      reqId: expect.any(String),
      items: [{ type: "conversation", id: "root-a" }, { type: "conversation", id: "root-b" }],
      parentId: null,
      before: { type: "folder", id: "work" },
      preservePinned: true,
    });

    // The first move was applied locally; start over from the original order.
    const second = treeSidebar();
    second.expandedFolderIds.add("work");
    focus(second, { type: "folder", id: "work" });
    handleSidebarKey(key("V"), second);
    for (let i = 0; i < 4; i++) handleSidebarAction("nav_down", second);
    expect(second.selectedItem).toEqual({ type: "conversation", id: "root-a" });
    expect(handleSidebarAction("move_down", second)).toEqual({
      type: "move_sidebar_items",
      reqId: expect.any(String),
      items: [{ type: "folder", id: "work" }, { type: "conversation", id: "root-a" }],
      parentId: null,
      before: undefined,
      preservePinned: true,
      placement: "bottom",
    });
  });

  test("moving items into a collapsed folder moves the cursor to a neighbor", () => {
    const sidebar = treeSidebar();
    focus(sidebar, { type: "conversation", id: "root-a" });
    handleSidebarKey(key("F"), sidebar);
    for (const char of "work") handleSidebarPromptKey(sidebar, key(char));

    const result = handleSidebarPromptKey(sidebar, { type: "enter" } as KeyEvent);
    expect(result).toMatchObject({ type: "move_sidebar_items", parentId: "work" });
    expect(sidebar.selectedItem).not.toEqual({ type: "conversation", id: "root-a" });
    expect(rowKeys(sidebar)).not.toContain("root-a");
  });

  test("search results stay flat and :noh reveals the chosen result in the tree", () => {
    const sidebar = treeSidebar();
    openSidebarSearchBar(sidebar, "forward");
    for (const char of "deep") handleSidebarSearchBarKey(sidebar, key(char));
    handleSidebarSearchBarKey(sidebar, { type: "enter" } as KeyEvent);
    expect(rowKeys(sidebar)).toEqual(["deep"]);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "deep" });
    expect(sidebar.expandedFolderIds.size).toBe(0);

    openSidebarCommandBar(sidebar);
    for (const char of "noh") handleSidebarSearchBarKey(sidebar, key(char));
    handleSidebarSearchBarKey(sidebar, { type: "enter" } as KeyEvent);
    expect(sidebar.expandedFolderIds).toEqual(new Set(["work", "nested"]));
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "deep" });
  });

  test("switching from the navigate view opens the folder you were in", () => {
    const sidebar = treeSidebar();
    setSidebarFolderView(sidebar, "navigate");
    sidebar.currentFolderId = "work";
    focus(sidebar, { type: "up" });

    setSidebarFolderView(sidebar, "tree");
    expect(sidebar.expandedFolderIds.has("work")).toBe(true);
    expect(sidebar.selectedItem).toEqual({ type: "folder", id: "work" });
    expect(sidebar.currentFolderId).toBeNull();

    focus(sidebar, { type: "conversation", id: "inside-a" });
    sidebar.currentFolderId = "work";
    setSidebarFolderView(sidebar, "navigate");
    expect(rowKeys(sidebar)).toEqual(["..", "nested", "inside-a", "inside-b"]);
    expect(sidebar.selectedItem).toEqual({ type: "conversation", id: "inside-a" });
  });

  test("renders nested rows indented under an open folder icon", () => {
    const sidebar = treeSidebar();
    sidebar.expandedFolderIds.add("work");
    focus(sidebar, { type: "conversation", id: "inside-a" });

    const lines = renderSidebar(sidebar, 12, true, null).map(line => stripAnsi(line));
    expect(lines[0]).toContain("Conversations");
    expect(lines).toContainEqual(expect.stringContaining("  📂 work/"));
    expect(lines).toContainEqual(expect.stringContaining("    📁 nested/ 1"));
    expect(lines).toContainEqual(expect.stringContaining("▸   inside-a"));
    expect(lines).toContainEqual(expect.stringContaining("  root-a"));
  });

  describe("aggregate badges on folder rows", () => {
    function badgeSidebar(view: "tree" | "navigate", muted = false): SidebarState {
      const sidebar = createSidebarState(view);
      updateConversationList(sidebar, [
        conversation("busy", 2, {
          folderId: "work",
          unread: true,
          subagentCount: 2,
          backgroundTaskCount: 1,
          tasks: [{ id: "c1", kind: "chrono", title: "wake", startedAt: 1, dueAt: 2, chronoMode: "wake" }],
        }),
        conversation("root-a", 3),
      ], [folder("work", 1, { muted })]);
      return sidebar;
    }
    const folderRow = (sidebar: SidebarState, icon: string): string =>
      renderSidebar(sidebar, 12, true, null).map(line => stripAnsi(line)).find(line => line.includes(`${icon} work/`))!;

    test("a collapsed tree folder keeps its aggregate badges and count", () => {
      const row = folderRow(badgeSidebar("tree"), "📁");
      expect(row).toMatch(/◉ ◆2 ◷ \$ 📁 work\/ 1/);
    });

    test("an open tree folder shows only its icon and name, plus its own mute bell", () => {
      const sidebar = badgeSidebar("tree");
      sidebar.expandedFolderIds.add("work");
      const unmuted = folderRow(sidebar, "📂").replace(/[│\s]+$/, "");
      expect(unmuted).toMatch(/📂 work\/$/);
      expect(unmuted).not.toContain("🔕");

      const muted = badgeSidebar("tree", true);
      muted.expandedFolderIds.add("work");
      const row = folderRow(muted, "📂");
      expect(row).toContain("📂 work/ ");
      expect(row).toContain("🔕");
      expect(row).not.toMatch(/[◉◷◆$]|work\/ \d/);
      // The child still carries its own badges.
      const lines = renderSidebar(sidebar, 12, true, null).map(line => stripAnsi(line));
      expect(lines.find(line => line.includes("busy"))).toMatch(/◉ ◆2 ◷ \$ busy/);
    });

    test("the navigate view keeps every folder badge", () => {
      const sidebar = badgeSidebar("navigate");
      const row = folderRow(sidebar, "📁");
      expect(row).toMatch(/◉ ◆2 ◷ \$ 📁 work\/ 1/);
    });
  });
});
