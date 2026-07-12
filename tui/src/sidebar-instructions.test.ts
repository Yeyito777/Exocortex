import { describe, expect, test } from "bun:test";
import { buildDisplayRows, handleSidebarAction, renderSidebar, updateConversationList } from "./sidebar";
import { createSidebarState } from "./sidebar/state";
import { createInitialState, draftFolderEffectiveInstructions, openFolderInstructionsDocument, resetDraftConversationState, setFolderInstructionsDocumentText } from "./state";
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

describe("folder AGENTS.md sidebar entry", () => {
  test("appears at the top of folder contents after the parent row", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "folder-a";
    sidebar.folders = [folder("folder-a", "Project")];

    const rows = buildDisplayRows(sidebar);

    expect(rows[0]).toEqual({ type: "entry", item: { type: "up" }, text: ".." });
    expect(rows[1]).toEqual({ type: "entry", item: { type: "folder_instructions", folderId: "folder-a" } });
    expect(renderSidebar(sidebar, 10, true, null).join("\n")).toContain("AGENTS.md");
  });

  test("selecting AGENTS.md opens the folder instructions document", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "folder-a";
    sidebar.folders = [folder("folder-a", "Project")];
    sidebar.selectedItem = { type: "folder_instructions", folderId: "folder-a" };

    expect(handleSidebarAction("submit", sidebar)).toEqual({ type: "open_folder_instructions", folderId: "folder-a" });
  });

  test("keeps AGENTS.md selected across sidebar refreshes", () => {
    const sidebar = createSidebarState();
    sidebar.currentFolderId = "folder-a";
    sidebar.folders = [folder("folder-a", "Project")];
    sidebar.selectedItem = { type: "folder_instructions", folderId: "folder-a" };

    updateConversationList(sidebar, [], [folder("folder-a", "Project")]);

    expect(sidebar.selectedItem).toEqual({ type: "folder_instructions", folderId: "folder-a" });
  });

  test("opening AGENTS.md preserves the current panel focus and prompt", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.chatFocus = "history";
    state.inputBuffer = "draft message";
    state.cursorPos = 5;

    openFolderInstructionsDocument(state, "folder-a");

    expect(state.panelFocus).toBe("sidebar");
    expect(state.chatFocus).toBe("history");
    expect(state.inputBuffer).toBe("draft message");
    expect(state.cursorPos).toBe(5);
  });

  test("loading AGENTS.md renders without prefilling or clearing the prompt", () => {
    const state = createInitialState();
    state.inputBuffer = "draft message";
    state.cursorPos = 5;
    openFolderInstructionsDocument(state, "folder-a");

    setFolderInstructionsDocumentText(state, "folder-a", "Remember dinosaurs.");

    expect(state.inputBuffer).toBe("draft message");
    expect(state.cursorPos).toBe(5);
    expect(state.folderInstructionsDoc?.savedText).toBe("Remember dinosaurs.");
    expect(state.messages[0]).toMatchObject({ role: "system_instructions", text: "Remember dinosaurs." });
  });

  test("blank new chats in a folder render effective AGENTS.md instructions synchronously", () => {
    const state = createInitialState();
    state.sidebar.currentFolderId = "folder-a";
    state.sidebar.folders = [folder("folder-a", "Project", null, "# Context from AGENTS.md:\nRemember dinosaurs.")];
    state.inputBuffer = "draft message";
    state.cursorPos = 5;

    resetDraftConversationState(state);

    expect(state.inputBuffer).toBe("draft message");
    expect(state.cursorPos).toBe(5);
    expect(state.messages[0]).toMatchObject({
      role: "system_instructions",
      text: "# Context from AGENTS.md:\nRemember dinosaurs.",
    });
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
    expect(draftFolderEffectiveInstructions(state)).toBe("Stay in this project.");
  });
});
