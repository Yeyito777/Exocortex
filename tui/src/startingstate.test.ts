import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInitialState } from "./state";
import { updateConversationList } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";
import {
  applyTuiStartingState,
  availableStartingConversationId,
  captureTuiStartingState,
  loadTuiStartingState,
  saveTuiStartingState,
  tuiStartingStatePath,
  type TuiStartingState,
} from "./startingstate";

const statePath = tuiStartingStatePath();

function removeStartingStateFiles(): void {
  rmSync(statePath, { force: true });
  const directory = dirname(statePath);
  try {
    for (const name of readdirSync(directory)) {
      if (name.startsWith(`.${basename(statePath)}.`) && name.endsWith(".tmp")) {
        rmSync(`${directory}/${name}`, { force: true });
      }
    }
  } catch {
    // The storage directory need not exist before a test writes state.
  }
}

afterEach(removeStartingStateFiles);

function conversation(id: string, folderId: string | null = null): ConversationSummary {
  return {
    id,
    provider: "openai",
    model: "gpt-5.4",
    effort: "high",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    folderId,
  };
}

function folder(id: string): FolderSummary {
  return {
    id,
    name: id,
    parentId: null,
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    sortOrder: 1,
  };
}

describe("TUI starting state", () => {
  test("captures the focused conversation and an open sidebar cursor", () => {
    const state = createInitialState();
    state.convId = "focused-conversation";
    state.sidebar.open = true;
    state.sidebar.currentFolderId = "work";
    state.sidebar.selectedItem = { type: "conversation", id: "cursor-conversation" };
    state.sidebar.scrollOffset = 7;

    expect(captureTuiStartingState(state)).toEqual({
      version: 1,
      focusedConversationId: "focused-conversation",
      sidebar: {
        open: true,
        currentFolderId: "work",
        selectedItem: { type: "conversation", id: "cursor-conversation" },
        scrollOffset: 7,
      },
    });
  });

  test("does not persist stale cursor details when the sidebar is closed", () => {
    const state = createInitialState();
    state.convId = null;
    state.sidebar.open = false;
    state.sidebar.currentFolderId = "work";
    state.sidebar.selectedItem = { type: "folder", id: "nested" };
    state.sidebar.scrollOffset = 12;

    expect(captureTuiStartingState(state)).toEqual({
      version: 1,
      focusedConversationId: null,
      sidebar: { open: false },
    });
  });

  test("seeds state and preserves the saved sidebar cursor when lists arrive", () => {
    const startingState: TuiStartingState = {
      version: 1,
      focusedConversationId: "focused-conversation",
      sidebar: {
        open: true,
        currentFolderId: "work",
        selectedItem: { type: "conversation", id: "cursor-conversation" },
        scrollOffset: 4,
      },
    };
    const state = createInitialState();

    applyTuiStartingState(state, startingState);
    updateConversationList(state.sidebar, [
      conversation("focused-conversation"),
      conversation("cursor-conversation", "work"),
    ], [folder("work")]);

    expect(state.convId).toBe("focused-conversation");
    expect(state.sidebar.open).toBe(true);
    expect(state.sidebar.currentFolderId).toBe("work");
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "cursor-conversation" });
    expect(state.sidebar.selectedId).toBe("cursor-conversation");
    expect(state.sidebar.scrollOffset).toBe(4);
    expect(availableStartingConversationId(startingState, state.sidebar.conversations)).toBe("focused-conversation");
  });

  test("does not try to load a saved conversation that no longer exists", () => {
    const startingState: TuiStartingState = {
      version: 1,
      focusedConversationId: "deleted-conversation",
      sidebar: { open: false },
    };

    expect(availableStartingConversationId(startingState, [conversation("still-here")])).toBeNull();
  });

  test("atomically replaces the previous close's state", () => {
    const first: TuiStartingState = {
      version: 1,
      focusedConversationId: "first",
      sidebar: { open: false },
    };
    const second: TuiStartingState = {
      version: 1,
      focusedConversationId: "second",
      sidebar: {
        open: true,
        currentFolderId: null,
        selectedItem: { type: "folder", id: "projects" },
        scrollOffset: 2,
      },
    };

    saveTuiStartingState(first);
    const firstInode = statSync(statePath).ino;
    saveTuiStartingState(second);
    const secondInode = statSync(statePath).ino;

    // POSIX rename swaps in the already-complete temporary inode. Windows does
    // not expose stable inode values through every supported filesystem.
    if (process.platform !== "win32") expect(secondInode).not.toBe(firstInode);
    expect(loadTuiStartingState()).toEqual(second);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(second);
    expect(readdirSync(dirname(statePath)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("ignores malformed or partially written state", () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, '{"version":1,"focusedConversationId":');
    expect(loadTuiStartingState()).toBeNull();

    writeFileSync(statePath, JSON.stringify({
      version: 1,
      focusedConversationId: "conversation",
      sidebar: { open: true, currentFolderId: null, selectedItem: null, scrollOffset: -1 },
    }));
    expect(loadTuiStartingState()).toBeNull();
  });
});
