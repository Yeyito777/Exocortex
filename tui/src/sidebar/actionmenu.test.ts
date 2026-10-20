import { describe, expect, test } from "bun:test";

import {
  sidebarActionMenuHitTest,
  createConversationActionMenu,
  createFolderActionMenu,
  folderOwnInstructions,
  handleSidebarActionMenuKey,
  handleSidebarActionMenuMouse,
  renderSidebarActionMenu,
} from "./actionmenu";
import type { MouseEvent } from "../input";
import type { FolderSummary } from "../messages";
import { theme } from "../theme";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[\d+;\d+H/g, "\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

function mouseEvent(
  col: number,
  row: number,
  button: number,
  action: MouseEvent["action"],
): MouseEvent {
  return { type: "mouse", col, row, button, action, shift: false, meta: false, ctrl: false };
}

describe("conversation action menu", () => {
  test("navigates with j/k and closes with escape", () => {
    const menu = createConversationActionMenu("conv-1", false, false);

    expect(menu.selection).toBe("copy_id");
    handleSidebarActionMenuKey(menu, { type: "char", char: "k" });
    expect(menu.selection).toBe("copy_id");
    handleSidebarActionMenuKey(menu, { type: "char", char: "j" });
    expect(menu.selection).toBe("toggle_star");
    handleSidebarActionMenuKey(menu, { type: "down" });
    expect(menu.selection).toBe("toggle_pin");
    handleSidebarActionMenuKey(menu, { type: "char", char: "j" });
    expect(menu.selection).toBe("delete");
    handleSidebarActionMenuKey(menu, { type: "up" });
    expect(menu.selection).toBe("toggle_pin");
    expect(handleSidebarActionMenuKey(menu, { type: "escape" })).toEqual({ type: "close" });
  });

  test("emits ordinary actions immediately and confirms delete", () => {
    const menu = createConversationActionMenu("conv-1", false, false);
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({
      type: "action",
      action: "copy_id",
    });

    menu.selection = "delete";
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({ type: "handled" });
    expect(menu.deleteConfirmation).toBe(true);
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({
      type: "action",
      action: "delete",
    });
  });

  test("hit-tests, highlights, and activates menu rows with the mouse", () => {
    const menu = createConversationActionMenu("conv-1", false, false);

    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 31, 5)).toBe("toggle_star");
    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 29, 5)).toBe("chrome");
    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 50, 5)).toBeNull();

    expect(handleSidebarActionMenuMouse(
      menu,
      mouseEvent(31, 5, 3, "motion"),
      3,
      29,
      20,
      80,
    )).toEqual({ type: "handled" });
    expect(menu.selection).toBe("toggle_star");

    expect(handleSidebarActionMenuMouse(
      menu,
      mouseEvent(31, 5, 0, "press"),
      3,
      29,
      20,
      80,
    )).toEqual({ type: "action", action: "toggle_star" });
  });

  test("mouse clicks preserve delete confirmation and close the menu when outside", () => {
    const menu = createConversationActionMenu("conv-1", false, false);

    expect(handleSidebarActionMenuMouse(
      menu,
      mouseEvent(31, 7, 0, "press"),
      3,
      29,
      20,
      80,
    )).toEqual({ type: "handled" });
    expect(menu.selection).toBe("delete");
    expect(menu.deleteConfirmation).toBe(true);
    expect(handleSidebarActionMenuMouse(
      menu,
      mouseEvent(31, 7, 0, "press"),
      3,
      29,
      20,
      80,
    )).toEqual({ type: "action", action: "delete" });

    expect(handleSidebarActionMenuMouse(
      menu,
      mouseEvent(50, 10, 0, "press"),
      3,
      29,
      20,
      80,
    )).toEqual({ type: "close" });
  });

  test("renders beside the sidebar with all options and destructive text in red", () => {
    const menu = createConversationActionMenu("conv-1", false, false);
    const { payload: rendered, rect } = renderSidebarActionMenu(menu, 3, 29, 20, 80);
    const plain = stripAnsi(rendered);

    expect(plain).toContain("Copy id");
    expect(plain).toContain("Star");
    expect(plain).toContain("Pin");
    expect(plain).toContain("Delete");
    expect(rendered).toContain(theme.error);
    expect(rendered).toContain("\x1b[3;29H");
    expect(rect).toEqual({ top: 3, bottom: 8, left: 29, right: 40 });
  });

  test("shows inverse labels for an already starred and pinned conversation", () => {
    const menu = createConversationActionMenu("conv-1", true, true);
    const rendered = stripAnsi(renderSidebarActionMenu(menu, 3, 29, 20, 80).payload);

    expect(rendered).toContain("Unstar");
    expect(rendered).toContain("Unpin");
  });
});

function folder(id: string, parentId: string | null, effectiveInstructions: string): FolderSummary {
  return { id, name: id, parentId, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 0, effectiveInstructions };
}

describe("folder action menu", () => {
  test("starts on Edit instructions and walks the folder actions with j/k", () => {
    const menu = createFolderActionMenu("folder-1", false, false, "");

    expect(menu.item).toEqual({ type: "folder", id: "folder-1" });
    expect(menu.selection).toBe("edit_instructions");
    const visited = [menu.selection];
    for (let i = 0; i < 6; i++) {
      handleSidebarActionMenuKey(menu, { type: "char", char: "j" });
      visited.push(menu.selection);
    }
    expect(visited).toEqual(["edit_instructions", "rename", "toggle_pin", "toggle_mute", "unwrap", "delete", "delete"]);
    handleSidebarActionMenuKey(menu, { type: "char", char: "k" });
    expect(menu.selection).toBe("unwrap");
  });

  test("Edit instructions activates at once and delete needs a second Enter", () => {
    const menu = createFolderActionMenu("folder-1", false, false, "");
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({ type: "action", action: "edit_instructions" });

    menu.selection = "delete";
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({ type: "handled" });
    expect(handleSidebarActionMenuKey(menu, { type: "enter" })).toEqual({ type: "action", action: "delete" });
  });

  test("shows empty instructions, or the first line cut short, beside Edit instructions", () => {
    const empty = stripAnsi(renderSidebarActionMenu(createFolderActionMenu("f", false, false, "  \n"), 3, 29, 20, 80).payload);
    expect(empty).toContain("Edit instructions empty");

    const long = createFolderActionMenu("f", true, true, "\nAlways answer in Spanish, even when asked in English.\nSecond line.");
    const rendered = stripAnsi(renderSidebarActionMenu(long, 3, 29, 20, 80).payload);
    expect(rendered).toContain("Edit instructions Always answer in Spanis…");
    expect(rendered).not.toContain("Second line");
    expect(rendered).toContain("Unpin");
    expect(rendered).toContain("Unmute");
    expect(rendered).toContain("Rename");
    expect(rendered).toContain("Unwrap");
  });

  test("hit-tests the six folder rows", () => {
    const menu = createFolderActionMenu("f", false, false, "");
    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 31, 4)).toBe("edit_instructions");
    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 31, 9)).toBe("delete");
    expect(sidebarActionMenuHitTest(menu, 3, 29, 20, 80, 31, 10)).toBe("chrome");
  });

  test("reads a folder's own instructions out of the inherited text", () => {
    const header = "# Context from AGENTS.md:\n";
    const sidebar = {
      folders: [
        folder("parent", null, `${header}Parent rules.`),
        folder("child", "parent", `${header}Parent rules.\n\n${header}Child rules.\nMore.`),
        folder("bare-child", "parent", `${header}Parent rules.`),
        folder("orphan", null, ""),
      ],
    };

    expect(folderOwnInstructions(sidebar, "parent")).toBe("Parent rules.");
    expect(folderOwnInstructions(sidebar, "child")).toBe("Child rules.\nMore.");
    expect(folderOwnInstructions(sidebar, "bare-child")).toBe("");
    expect(folderOwnInstructions(sidebar, "orphan")).toBe("");
    expect(folderOwnInstructions(sidebar, "missing")).toBe("");
  });
});
