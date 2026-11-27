import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readExocortexConfig, updateExocortexConfig } from "@exocortex/shared/config";
import { handleFocusedKey } from "../focus";
import { stripAnsi } from "../historycursor";
import type { ConversationSummary } from "../messages";
import { renderSidebar } from "../sidebar";
import { createInitialState, type RenderState } from "../state";
import { setSidebarIndicatorPlacement, sidebarIndicatorPlacement, type SidebarIndicatorPlacement } from "./indicatorplacement";

function conversation(id: string, sortOrder: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false, createdAt: sortOrder, updatedAt: sortOrder,
    messageCount: 0, title: id, marked: false, pinned: false, streaming: false, unread: false, sortOrder, ...overrides,
  };
}

function sidebarState(): RenderState {
  const state = createInitialState();
  state.sidebar.open = true;
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
  state.sidebar.conversations = [conversation("busy", 0, { streaming: true })];
  state.sidebar.selectedItem = { type: "conversation", id: "busy" };
  return state;
}

const press = (state: RenderState, char: string) => handleFocusedKey({ type: "char", char }, state);
const both = (side: SidebarIndicatorPlacement["folders"]): SidebarIndicatorPlacement => ({ folders: side, conversations: side });
const saved = () => readExocortexConfig().tui?.sidebarIndicators;
/** The busy row as the TUI draws it now: renderSidebar's placement is the live setting. */
const busyRow = (state: RenderState) => stripAnsi(renderSidebar(state.sidebar, 8, true, null).find(row => row.includes("busy"))!);

function setSaved(placement: ReturnType<typeof saved>): void {
  updateExocortexConfig(config => {
    const tui = { ...(config.tui ?? {}) };
    if (placement) tui.sidebarIndicators = placement;
    else delete tui.sidebarIndicators;
    config.tui = tui;
  });
}

describe("< and > in the sidebar step the indicator placement", () => {
  let original: ReturnType<typeof saved>;
  beforeEach(() => {
    original = saved();
    setSaved(undefined);
    setSidebarIndicatorPlacement(null);
  });
  afterEach(() => {
    setSaved(original);
    setSidebarIndicatorPlacement(null);
  });

  test("> steps right and < steps left through before, after, right, stopping at the ends", () => {
    const state = sidebarState();
    setSidebarIndicatorPlacement(both("before"));
    expect(press(state, ">")).toEqual({ type: "handled" });
    expect(sidebarIndicatorPlacement()).toEqual(both("after"));
    press(state, ">");
    expect(sidebarIndicatorPlacement()).toEqual(both("right"));
    press(state, ">");
    expect(sidebarIndicatorPlacement()).toEqual(both("right"));
    press(state, "<");
    expect(sidebarIndicatorPlacement()).toEqual(both("after"));
    press(state, "<");
    press(state, "<");
    expect(sidebarIndicatorPlacement()).toEqual(both("before"));
  });

  test("differing settings step from the conversations' one and both take it", () => {
    const state = sidebarState();
    setSidebarIndicatorPlacement({ folders: "before", conversations: "right" });
    press(state, "<");
    expect(sidebarIndicatorPlacement()).toEqual(both("after"));
    // At an end the first press still lines folders up with conversations.
    setSidebarIndicatorPlacement({ folders: "after", conversations: "right" });
    press(state, ">");
    expect(sidebarIndicatorPlacement()).toEqual(both("right"));
  });

  test("the next frame draws the new placement, with no restart", () => {
    const state = sidebarState();
    setSidebarIndicatorPlacement(both("right"));
    expect(busyRow(state)).toMatch(/^▸ busy +◉ │$/);
    press(state, "<");
    expect(busyRow(state)).toMatch(/^▸ busy ◉ +│$/);
    press(state, "<");
    expect(busyRow(state)).toMatch(/^▸ ◉ busy +│$/);
  });

  test("each step is saved to tui.sidebarIndicators, keeping the other TUI settings", () => {
    updateExocortexConfig(config => { config.tui = { ...(config.tui ?? {}), clock: "24h" }; });
    const state = sidebarState();
    setSidebarIndicatorPlacement(both("right"));
    press(state, "<");
    expect(saved()).toEqual(both("after"));
    expect(readExocortexConfig().tui?.clock).toBe("24h");
    // A fresh read (as the next TUI start does) gets the saved placement.
    setSidebarIndicatorPlacement(null);
    expect(sidebarIndicatorPlacement()).toEqual(both("after"));
    updateExocortexConfig(config => { delete config.tui?.clock; });
  });

  test("a press at an end with both already there writes nothing", () => {
    const state = sidebarState();
    setSidebarIndicatorPlacement(both("right"));
    press(state, ">");
    expect(saved()).toBeUndefined();
  });

  test("outside the sidebar, < and > do nothing to the placement", () => {
    const state = sidebarState();
    setSidebarIndicatorPlacement(both("after"));
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    state.vim.mode = "insert";
    press(state, "<");
    press(state, ">");
    expect(state.inputBuffer).toBe("<>");
    expect(sidebarIndicatorPlacement()).toEqual(both("after"));
    expect(saved()).toBeUndefined();
  });
});

describe("move-out is on o", () => {
  function inFolder(): RenderState {
    const state = sidebarState();
    state.sidebar.folderView = "navigate";
    state.sidebar.currentFolderId = "folder-work";
    state.sidebar.folders = [{ id: "folder-work", name: "Work", parentId: null, createdAt: 1, updatedAt: 1, pinned: false, sortOrder: 2 }];
    state.sidebar.conversations = [conversation("conv-a", 1, { folderId: "folder-work" })];
    state.sidebar.selectedItem = { type: "conversation", id: "conv-a" };
    state.sidebar.selectedId = "conv-a";
    state.sidebar.selectedIndex = 0;
    return state;
  }

  test("o moves the selection out, just above the folder it came from", () => {
    expect(press(inFolder(), "o")).toEqual({
      type: "move_sidebar_items",
      reqId: expect.any(String),
      items: [{ type: "conversation", id: "conv-a" }],
      parentId: null,
      before: { type: "folder", id: "folder-work" },
    });
  });

  test("< no longer moves anything", () => {
    setSidebarIndicatorPlacement(both("right"));
    try {
      const state = inFolder();
      expect(press(state, "<")).toEqual({ type: "handled" });
      expect(state.sidebar.conversations[0].folderId).toBe("folder-work");
    } finally {
      setSidebarIndicatorPlacement(null);
      setSaved(undefined);
    }
  });
});
