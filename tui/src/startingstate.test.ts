import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInitialState } from "./state";
import { updateConversationList } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";
import { handleConversationsList } from "./events/conversations";
import {
  applyTuiStartingState,
  availableStartingConversationId,
  captureTuiStartingState,
  daemonRouteKey,
  loadTuiStartingState,
  RouteExpandedFolders,
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
      version: 2,
      focusedConversationId: "focused-conversation",
      sidebar: {
        open: true,
        currentFolderId: "work",
        selectedItem: { type: "conversation", id: "cursor-conversation" },
        scrollOffset: 7,
        expandedFolderIds: [],
      },
      conversationScrollPositions: {},
      expandedFolderIdsByRoute: { local: [] },
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
      version: 2,
      focusedConversationId: null,
      sidebar: { open: false, expandedFolderIds: [] },
      conversationScrollPositions: {},
      expandedFolderIdsByRoute: { local: [] },
    });
  });

  test("seeds state and preserves the saved sidebar cursor when lists arrive", () => {
    const startingState: TuiStartingState = {
      version: 2,
      focusedConversationId: "focused-conversation",
      sidebar: {
        open: true,
        currentFolderId: "work",
        selectedItem: { type: "conversation", id: "cursor-conversation" },
        scrollOffset: 4,
      },
      conversationScrollPositions: { "focused-conversation": 0.4 },
    };
    const state = createInitialState();
    state.sidebar.folderView = "navigate";

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
    expect(state.conversationScroll.positions.get("focused-conversation")).toBe(0.4);
    expect(availableStartingConversationId(startingState, state.sidebar.conversations)).toBe("focused-conversation");
  });

  test("does not try to load a saved conversation that no longer exists", () => {
    const startingState: TuiStartingState = {
      version: 2,
      focusedConversationId: "deleted-conversation",
      sidebar: { open: false },
      conversationScrollPositions: {},
    };

    expect(availableStartingConversationId(startingState, [conversation("still-here")])).toBeNull();
  });

  test("captures the focused conversation's viewport percentage", () => {
    const state = createInitialState();
    state.convId = "focused";
    state.layout.totalLines = 100;
    state.layout.messageAreaHeight = 20;
    state.scrollOffset = 40;

    expect(captureTuiStartingState(state).conversationScrollPositions).toEqual({ focused: 0.5 });
  });

  test("atomically replaces the previous close's state", () => {
    const first: TuiStartingState = {
      version: 2,
      focusedConversationId: "first",
      sidebar: { open: false, expandedFolderIds: [] },
      conversationScrollPositions: { first: 0.25 },
    };
    const second: TuiStartingState = {
      version: 2,
      focusedConversationId: "second",
      sidebar: {
        open: true,
        currentFolderId: null,
        selectedItem: { type: "folder", id: "projects" },
        scrollOffset: 2,
        expandedFolderIds: ["projects"],
      },
      conversationScrollPositions: { second: 0.75 },
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

    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: "conversation",
      sidebar: { open: false },
      conversationScrollPositions: { conversation: 2 },
    }));
    expect(loadTuiStartingState()).toBeNull();
  });

  test("migrates version-one state without conversation positions", () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      focusedConversationId: "conversation",
      sidebar: { open: false },
    }));

    expect(loadTuiStartingState()).toEqual({
      version: 2,
      focusedConversationId: "conversation",
      sidebar: { open: false, expandedFolderIds: [] },
      conversationScrollPositions: {},
    });
  });

  test("a saved selection on the old folder AGENTS.md row comes back as that folder", () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: null,
      sidebar: {
        open: true,
        currentFolderId: null,
        selectedItem: { type: "folder_instructions", folderId: "work" },
        scrollOffset: 0,
        expandedFolderIds: ["work"],
      },
      conversationScrollPositions: {},
    }));

    const loaded = loadTuiStartingState();
    expect(loaded?.sidebar.open && loaded.sidebar.selectedItem).toEqual({ type: "folder", id: "work" });
  });

  test("restores tree-view folder expansion whether or not the sidebar was open", () => {
    const state = createInitialState();
    state.sidebar.open = false;
    state.sidebar.expandedFolderIds = new Set(["work", "work-nested"]);

    const captured = captureTuiStartingState(state);
    const restored = createInitialState();
    applyTuiStartingState(restored, captured);

    expect(restored.sidebar.expandedFolderIds).toEqual(new Set(["work", "work-nested"]));
  });

  test("keeps each daemon route's expansion, so an /ssh tree reopens as it was left", () => {
    const remoteKey = daemonRouteKey("whale");
    const local = createInitialState();
    local.sidebar.expandedFolderIds = new Set(["local-folder"]);
    const routes = new RouteExpandedFolders(null);
    // Switching to /ssh stashes the local route's tree; the remote one is then edited.
    routes.remember(daemonRouteKey(null), local.sidebar.expandedFolderIds);
    local.sidebar.expandedFolderIds = routes.forRoute(remoteKey);
    local.sidebar.expandedFolderIds.add("remote-a");
    local.sidebar.expandedFolderIds.add("remote-b");

    saveTuiStartingState(captureTuiStartingState(local, routes, remoteKey));
    const loaded = loadTuiStartingState();
    expect(loaded?.expandedFolderIdsByRoute).toEqual({
      local: ["local-folder"],
      "ssh:whale": ["remote-a", "remote-b"],
    });

    const reopened = createInitialState();
    applyTuiStartingState(reopened, loaded!);
    expect(reopened.sidebar.expandedFolderIds).toEqual(new Set(["local-folder"]));
    const reopenedRoutes = new RouteExpandedFolders(loaded);
    expect(reopenedRoutes.forRoute(remoteKey)).toEqual(new Set(["remote-a", "remote-b"]));
    expect(reopenedRoutes.forRoute(daemonRouteKey("other-host"))).toEqual(new Set());
  });

  test("older files without per-route expansion seed every route with their single list", () => {
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: null,
      sidebar: { open: false, expandedFolderIds: ["work"] },
      conversationScrollPositions: {},
    }));
    const routes = new RouteExpandedFolders(loadTuiStartingState());
    expect(routes.forRoute(daemonRouteKey(null))).toEqual(new Set(["work"]));
    expect(routes.forRoute(daemonRouteKey("whale"))).toEqual(new Set(["work"]));
  });

  test("an authoritative list forgets expanded folders that were deleted; renames keep their id", () => {
    const state = createInitialState();
    state.sidebar.expandedFolderIds = new Set(["kept", "deleted"]);
    handleConversationsList({ type: "conversations_list", conversations: [], folders: [{ ...folder("kept"), name: "Renamed" }] }, state);
    expect(state.sidebar.expandedFolderIds).toEqual(new Set(["kept"]));

    // A list without folders says nothing about them.
    handleConversationsList({ type: "conversations_list", conversations: [] }, state);
    expect(state.sidebar.expandedFolderIds).toEqual(new Set(["kept"]));
  });
});
