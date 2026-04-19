import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "./focus";
import type { ConversationSummary } from "./messages";
import { createInitialState } from "./state";
import { renderSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { termWidth } from "./textwidth";

function conversation(id: string, title: string, sortOrder: number): ConversationSummary {
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
  };
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
