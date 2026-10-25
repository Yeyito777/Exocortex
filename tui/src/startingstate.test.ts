import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInitialState } from "./state";
import { syncSelectedIndex, updateConversationList } from "./sidebar";
import type { ConversationSummary, FolderSummary } from "./messages";
import { handleConversationsList } from "./events/conversations";
import {
  applyTuiStartingState,
  availableStartingConversationId,
  captureTuiStartingState,
  daemonRouteKey,
  applyRouteViewState,
  captureRouteViewState,
  loadTuiStartingState,
  RouteViewStates,
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
      routes: {
        local: {
          focusedConversationId: "focused-conversation",
          sidebarCursor: {
            currentFolderId: "work",
            selectedItem: { type: "conversation", id: "cursor-conversation" },
            scrollOffset: 7,
          },
          expandedFolderIds: [],
          conversationScrollPositions: {},
        },
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
      version: 2,
      focusedConversationId: null,
      sidebar: { open: false, expandedFolderIds: [] },
      conversationScrollPositions: {},
      routes: {
        local: { focusedConversationId: null, sidebarCursor: null, expandedFolderIds: [], conversationScrollPositions: {} },
      },
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

  test("keeps the saved cursor when the restored conversation loads before the list", () => {
    const state = createInitialState();
    applyTuiStartingState(state, {
      version: 2,
      focusedConversationId: "second",
      sidebar: { open: true, currentFolderId: null, selectedItem: { type: "conversation", id: "second" }, scrollOffset: 0 },
      conversationScrollPositions: {},
    });
    // What a same-conversation conversation_loaded does before any list arrived.
    syncSelectedIndex(state.sidebar);
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "second" });

    updateConversationList(state.sidebar, [conversation("first"), conversation("second")], []);
    expect(state.sidebar.selectedItem).toEqual({ type: "conversation", id: "second" });
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

  test("keeps each daemon route's view, so an /ssh session reopens as it was left", () => {
    const remoteKey = daemonRouteKey("whale");
    const routes = new RouteViewStates(null);
    const state = createInitialState();
    state.sidebar.open = true;
    state.convId = "local-conversation";
    state.sidebar.expandedFolderIds = new Set(["local-folder"]);
    state.conversationScroll.positions.set("local-conversation", 0.25);
    // Switching to /ssh keeps the local view aside; the remote one is then used.
    routes.remember(daemonRouteKey(null), captureRouteViewState(state));
    applyRouteViewState(state, routes.forRoute(remoteKey));
    expect(state.convId).toBeNull();
    expect(state.sidebar.expandedFolderIds).toEqual(new Set());
    state.convId = "remote-conversation";
    state.sidebar.selectedItem = { type: "conversation", id: "remote-conversation" };
    state.sidebar.scrollOffset = 3;
    state.sidebar.expandedFolderIds = new Set(["remote-a", "remote-b"]);
    state.conversationScroll.positions = new Map([["remote-conversation", 0.75]]);

    saveTuiStartingState(captureTuiStartingState(state, routes, remoteKey));
    const loaded = loadTuiStartingState()!;
    expect(loaded.focusedConversationId).toBe("remote-conversation");
    expect(loaded.routes?.local).toEqual({
      focusedConversationId: "local-conversation",
      sidebarCursor: { currentFolderId: null, selectedItem: null, scrollOffset: 0 },
      expandedFolderIds: ["local-folder"],
      conversationScrollPositions: { "local-conversation": 0.25 },
    });

    // A TUI starts on its local socket, then reaches the /ssh route.
    const reopenedRoutes = new RouteViewStates(loaded);
    const reopened = createInitialState();
    applyTuiStartingState(reopened, loaded, reopenedRoutes);
    expect(reopened.convId).toBe("local-conversation");
    expect(reopened.sidebar.expandedFolderIds).toEqual(new Set(["local-folder"]));
    applyRouteViewState(reopened, reopenedRoutes.forRoute(remoteKey));
    expect(reopened.convId).toBe("remote-conversation");
    expect(reopened.sidebar.selectedItem).toEqual({ type: "conversation", id: "remote-conversation" });
    expect(reopened.sidebar.scrollOffset).toBe(3);
    expect(reopened.sidebar.expandedFolderIds).toEqual(new Set(["remote-a", "remote-b"]));
    expect(reopened.conversationScroll.positions).toEqual(new Map([["remote-conversation", 0.75]]));
    expect(reopenedRoutes.forRoute(daemonRouteKey("other-host")).focusedConversationId).toBeNull();
  });

  test("older files without per-route views seed every route with their single view", () => {
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: "conversation",
      sidebar: { open: true, currentFolderId: "work", selectedItem: { type: "folder", id: "work" }, scrollOffset: 2, expandedFolderIds: ["work"] },
      conversationScrollPositions: { conversation: 0.5 },
    }));
    const routes = new RouteViewStates(loadTuiStartingState());
    for (const routeKey of [daemonRouteKey(null), daemonRouteKey("whale")]) {
      expect(routes.forRoute(routeKey)).toEqual({
        focusedConversationId: "conversation",
        sidebarCursor: { currentFolderId: "work", selectedItem: { type: "folder", id: "work" }, scrollOffset: 2 },
        expandedFolderIds: ["work"],
        conversationScrollPositions: { conversation: 0.5 },
      });
    }
  });

  test("files with only per-route expansion keep it under the seeded view", () => {
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: "remote-conversation",
      sidebar: { open: false, expandedFolderIds: ["remote"] },
      conversationScrollPositions: {},
      expandedFolderIdsByRoute: { local: ["local"], "ssh:whale": ["remote"] },
    }));
    const routes = new RouteViewStates(loadTuiStartingState());
    expect(routes.forRoute(daemonRouteKey(null)).expandedFolderIds).toEqual(["local"]);
    expect(routes.forRoute(daemonRouteKey("whale"))).toEqual({
      focusedConversationId: "remote-conversation",
      sidebarCursor: null,
      expandedFolderIds: ["remote"],
      conversationScrollPositions: {},
    });
  });

  test("a malformed route loses only that route's view", () => {
    writeFileSync(statePath, JSON.stringify({
      version: 2,
      focusedConversationId: null,
      sidebar: { open: false },
      conversationScrollPositions: {},
      routes: {
        local: { focusedConversationId: "kept", sidebarCursor: null, expandedFolderIds: [], conversationScrollPositions: {} },
        "ssh:whale": { focusedConversationId: 7 },
      },
    }));
    const routes = new RouteViewStates(loadTuiStartingState());
    expect(routes.forRoute(daemonRouteKey(null)).focusedConversationId).toBe("kept");
    expect(routes.forRoute(daemonRouteKey("whale")).focusedConversationId).toBeNull();
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
