import { describe, expect, test } from "bun:test";
import { buildDisplayRows, handleSidebarAction, renderSidebar } from "./sidebar";
import { createSidebarState } from "./sidebar/state";
import { createInitialState, resetDraftConversationState } from "./state";
import type { FolderSummary } from "./messages";
import { leaveFolder } from "./sidebar/folderactions";

function folder(id: string, name: string, parentId: string | null = null, effectiveInstructions = ""): FolderSummary {
  return {
    id,
    name,
    parentId,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    sortOrder: 0,
    effectiveInstructions,
  };
}

describe("folder instructions in the sidebar", () => {
  test("an open folder lists no AGENTS.md row in the navigate view", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "folder-a";
    sidebar.folders = [folder("folder-a", "Project", null, "# Context from AGENTS.md:\nRules.")];

    const rows = buildDisplayRows(sidebar);

    expect(rows).toEqual([{ type: "entry", item: { type: "up" }, text: ".." }]);
    expect(renderSidebar(sidebar, 10, true, null).join("\n")).not.toContain("AGENTS.md");
  });

  test("an expanded folder lists no AGENTS.md row in the tree view", () => {
    const sidebar = createSidebarState("tree");
    sidebar.folders = [folder("folder-a", "Project", null, "# Context from AGENTS.md:\nRules.")];
    sidebar.expandedFolderIds.add("folder-a");

    expect(buildDisplayRows(sidebar).map(row => row.item)).toEqual([{ type: "folder", id: "folder-a" }]);
    expect(renderSidebar(sidebar, 10, true, null).join("\n")).not.toContain("AGENTS.md");
  });

  test("Enter inside an empty folder opens nothing", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "folder-a";
    sidebar.folders = [folder("folder-a", "Project")];
    sidebar.selectedItem = { type: "up" };

    expect(handleSidebarAction("submit", sidebar)).toEqual({ type: "handled" });
    expect(sidebar.currentFolderId).toBeNull();
  });

  test("blank new chats in a folder do not render its AGENTS.md instructions", () => {
    const state = createInitialState();
    state.sidebar.currentFolderId = "folder-a";
    state.sidebar.folders = [folder("folder-a", "Project", null, "# Context from AGENTS.md:\nRemember dinosaurs.")];
    state.inputBuffer = "draft message";
    state.cursorPos = 5;

    resetDraftConversationState(state);

    expect(state.inputBuffer).toBe("draft message");
    expect(state.cursorPos).toBe(5);
    expect(state.messages).toEqual([]);
  });

  test("blank new chats outside folders do not render folder instructions", () => {
    const state = createInitialState();
    state.sidebar.folders = [folder("folder-a", "Project", null, "# Context from AGENTS.md:\nRemember dinosaurs.")];

    resetDraftConversationState(state);

    expect(state.messages).toEqual([]);
  });

  test("a folder draft keeps its destination after the sidebar leaves that folder", () => {
    const state = createInitialState();
    state.sidebar.currentFolderId = "folder-a";
    state.sidebar.folders = [folder("folder-a", "Project", null, "Stay in this project.")];

    // This is the state transition performed by Ctrl+P.
    resetDraftConversationState(state);
    leaveFolder(state.sidebar);

    expect(state.sidebar.currentFolderId).toBeNull();
    expect(state.draftFolderId).toBe("folder-a");
  });
});
