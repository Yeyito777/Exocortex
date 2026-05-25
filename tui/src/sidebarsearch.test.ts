import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import type { ConversationSummary, FolderSummary } from "./messages";
import { createInitialState } from "./state";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { termWidth } from "./textwidth";

function conversation(id: string, title: string, sortOrder: number, folderId: string | null = null): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: sortOrder,
    updatedAt: sortOrder,
    messageCount: 0,
    title,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder,
    folderId,
  };
}

function folder(id: string, name: string, sortOrder: number, parentId: string | null = null): FolderSummary {
  return { id, name, parentId, createdAt: sortOrder, updatedAt: sortOrder, pinned: false, sortOrder };
}

function setupSidebarState() {
  const state = createInitialState();
  state.sidebar.open = true;
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
  state.sidebar.conversations = [
    conversation("conv-1", "Alpha plans", 1),
    conversation("conv-2", "beta release", 2),
    conversation("conv-3", "Gamma notes", 3),
    conversation("conv-4", "Beta retro", 4),
  ];
  state.sidebar.selectedIndex = 0;
  state.sidebar.selectedId = "conv-1";
  return state;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("sidebar conversation search", () => {
  test("/ opens search, live-matches titles case-insensitively, and Escape restores selection", () => {
    const state = setupSidebarState();

    expect(handleFocusedKey({ type: "char", char: "/" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.search?.barOpen).toBe(true);
    expect(state.sidebar.search?.direction).toBe("forward");

    for (const ch of "beta") {
      expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    }

    expect(state.sidebar.selectedId).toBe("conv-2");

    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.search?.barOpen).toBe(false);
    expect(state.sidebar.selectedId).toBe("conv-1");
  });

  test("confirmed sidebar searches persist query and n/N navigate matches", () => {
    const state = setupSidebarState();

    handleFocusedKey({ type: "char", char: "/" }, state);
    for (const ch of "beta") handleFocusedKey({ type: "char", char: ch }, state);
    handleFocusedKey({ type: "enter" }, state);

    expect(state.sidebar.search?.query).toBe("beta");
    expect(state.sidebar.search?.highlightsVisible).toBe(true);
    expect(state.sidebar.selectedId).toBe("conv-2");

    expect(handleFocusedKey({ type: "char", char: "n" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-4");

    expect(handleFocusedKey({ type: "char", char: "N" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedId).toBe("conv-2");
  });

  test("? searches backward through titles", () => {
    const state = setupSidebarState();
    state.sidebar.selectedIndex = 3;
    state.sidebar.selectedId = "conv-4";

    handleFocusedKey({ type: "char", char: "?" }, state);
    for (const ch of "beta") handleFocusedKey({ type: "char", char: ch }, state);
    handleFocusedKey({ type: "enter" }, state);

    expect(state.sidebar.search?.query).toBe("beta");
    expect(state.sidebar.search?.direction).toBe("backward");
    expect(state.sidebar.selectedId).toBe("conv-2");
  });

  test("? searches backward from the current row even when that row is not a match", () => {
    const state = setupSidebarState();
    state.sidebar.selectedItem = { type: "conversation", id: "conv-3" };
    state.sidebar.selectedIndex = 2;
    state.sidebar.selectedId = "conv-3";

    handleFocusedKey({ type: "char", char: "?" }, state);
    for (const ch of "beta") handleFocusedKey({ type: "char", char: ch }, state);

    expect(state.sidebar.selectedId).toBe("conv-2");
  });

  test(":noh hides sidebar search highlights without clearing the last query", () => {
    const state = setupSidebarState();

    handleFocusedKey({ type: "char", char: "/" }, state);
    for (const ch of "beta") handleFocusedKey({ type: "char", char: ch }, state);
    handleFocusedKey({ type: "enter" }, state);

    expect(state.sidebar.search?.query).toBe("beta");
    expect(state.sidebar.search?.highlightsVisible).toBe(true);
    expect(state.sidebar.selectedId).toBe("conv-2");

    let rendered = renderSidebar(state.sidebar, 8, true, null).map(stripAnsi).join("\n");
    expect(rendered).not.toContain("Alpha plans");
    expect(rendered).not.toContain("Gamma notes");

    expect(handleFocusedKey({ type: "char", char: ":" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.search?.barOpen).toBe(true);
    expect(state.sidebar.search?.barMode).toBe("command");

    for (const ch of "noh") handleFocusedKey({ type: "char", char: ch }, state);
    handleFocusedKey({ type: "enter" }, state);

    expect(state.sidebar.search?.barOpen).toBe(false);
    expect(state.sidebar.search?.query).toBe("beta");
    expect(state.sidebar.search?.highlightsVisible).toBe(false);

    rendered = renderSidebar(state.sidebar, 8, true, null).map(stripAnsi).join("\n");
    expect(rendered).toContain("Alpha plans");
    expect(rendered).toContain("Gamma notes");

    expect(handleFocusedKey({ type: "char", char: "n" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.search?.highlightsVisible).toBe(true);
    expect(state.sidebar.selectedId).toBe("conv-4");
  });

  test("sidebar search finds conversations inside nested folders from the root", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      { id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 1 },
      { id: "folder-clients", name: "Clients", parentId: "folder-work", createdAt: 2, updatedAt: 2, pinned: false, sortOrder: 2 },
    ];
    state.sidebar.conversations = [
      conversation("conv-root", "Root notes", 1),
      conversation("conv-nested", "Needle project", 2, "folder-clients"),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-root" };
    state.sidebar.selectedId = "conv-root";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "/" }, state)).toEqual({ type: "handled" });
    for (const ch of "needle") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });

    expect(state.sidebar.selectedId).toBe("conv-nested");
    const rendered = renderSidebar(state.sidebar, 8, true, null).map(stripAnsi).join("\n");
    expect(rendered).toContain("Needle");
    expect(rendered).not.toContain("Work/Clients");
    expect(rendered).not.toContain("Root notes");

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "load_conversation", convId: "conv-nested" });
  });

  test("sidebar search directly matches folders and opens matched folders unfiltered", () => {
    const state = createInitialState();
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [folder("folder-work", "Work", 1)];
    state.sidebar.conversations = [
      conversation("conv-root", "Root notes", 1),
      conversation("conv-child", "Zebra child", 2, "folder-work"),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-root" };
    state.sidebar.selectedId = "conv-root";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "/" }, state)).toEqual({ type: "handled" });
    for (const ch of "work") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedItem as unknown).toEqual({ type: "folder", id: "folder-work" });

    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.currentFolderId).toBe("folder-work");
    expect(state.sidebar.search?.highlightsVisible).toBe(false);

    const rendered = renderSidebar(state.sidebar, 8, true, null).map(stripAnsi).join("\n");
    expect(rendered).toContain("Zebra child");
  });

  test(":noh reveals the focused search result instead of the active conversation", () => {
    const state = createInitialState();
    state.convId = "conv-active";
    state.sidebar.open = true;
    state.panelFocus = "sidebar";
    state.vim.mode = "normal";
    state.sidebar.folders = [
      folder("folder-work", "Work", 1),
      folder("folder-clients", "Clients", 2, "folder-work"),
    ];
    state.sidebar.conversations = [
      conversation("conv-active", "Active root chat", 1),
      conversation("conv-nested", "Needle project", 2, "folder-clients"),
    ];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-active" };
    state.sidebar.selectedId = "conv-active";
    state.sidebar.selectedIndex = 0;

    expect(handleFocusedKey({ type: "char", char: "/" }, state)).toEqual({ type: "handled" });
    for (const ch of "needle") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "conv-nested" });
    expect(state.convId).toBe("conv-active");

    expect(handleFocusedKey({ type: "char", char: ":" }, state)).toEqual({ type: "handled" });
    for (const ch of "noh") expect(handleFocusedKey({ type: "char", char: ch }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "enter" }, state)).toEqual({ type: "handled" });

    expect(state.convId).toBe("conv-active");
    expect(state.sidebar.currentFolderId).toBe("folder-clients");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "conv-nested" });
    expect(state.sidebar.search?.highlightsVisible).toBe(false);
  });

  test("renderSidebar keeps the search bar at the bottom and filters out non-matches", () => {
    const state = setupSidebarState();

    handleFocusedKey({ type: "char", char: "/" }, state);
    handleFocusedKey({ type: "char", char: "b" }, state);
    handleFocusedKey({ type: "char", char: "e" }, state);

    const rows = renderSidebar(state.sidebar, 8, true, null);
    const rendered = rows.map(stripAnsi).join("\n");

    expect(stripAnsi(rows[0])).toContain("Conversations");
    expect(stripAnsi(rows.at(-1)!)).toContain("/ be");
    expect(rendered).toContain("beta release");
    expect(rendered).toContain("Beta retro");
    expect(rendered).not.toContain("Alpha plans");
    expect(rendered).not.toContain("Gamma notes");
  });

  test("renderSidebar keeps wide conversation titles inside the border", () => {
    const state = setupSidebarState();
    state.sidebar.conversations = [
      conversation("conv-1", "【the🦋chat】", 1),
      conversation("conv-2", "memes＆media", 2),
      conversation("conv-3", "catpostinge𓃠", 3),
    ];
    state.sidebar.selectedIndex = 0;
    state.sidebar.selectedId = "conv-1";

    const rows = renderSidebar(state.sidebar, 6, true, "conv-1").map(stripAnsi);
    for (const row of rows) {
      expect(termWidth(row)).toBe(SIDEBAR_WIDTH);
      expect(row.endsWith("│") || row.endsWith("┤")).toBe(true);
    }
  });
});
