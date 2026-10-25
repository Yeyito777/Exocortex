import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { storageDir } from "@exocortex/shared/paths";
import type { ConversationSummary } from "./messages";
import type { SidebarSelectableItem } from "./sidebar/items";
import type { RenderState } from "./state";
import {
  applyConversationScrollPositions,
  captureConversationScrollPositions,
  parseConversationScrollPositions,
  type SerializedConversationScrollPositions,
} from "./conversationscroll/persistence";

const TUI_STARTING_STATE_VERSION = 2;

interface ClosedSidebarStartingState {
  open: false;
  /** Folders expanded in the tree folder view. */
  expandedFolderIds?: string[];
}

interface OpenSidebarStartingState {
  open: true;
  currentFolderId: string | null;
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
  expandedFolderIds?: string[];
}

interface SidebarCursorStartingState {
  currentFolderId: string | null;
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
}

/** One daemon route's view. Its conversation and folder ids mean nothing on another daemon. */
export interface RouteViewState {
  focusedConversationId: string | null;
  /** Null when the sidebar was closed: its cursor is not kept current then. */
  sidebarCursor: SidebarCursorStartingState | null;
  expandedFolderIds: string[];
  conversationScrollPositions: SerializedConversationScrollPositions;
}

export interface TuiStartingState {
  version: typeof TUI_STARTING_STATE_VERSION;
  /** The top-level view is the route that was open at quit; older TUIs read only this. */
  focusedConversationId: string | null;
  sidebar: ClosedSidebarStartingState | OpenSidebarStartingState;
  conversationScrollPositions: SerializedConversationScrollPositions;
  /**
   * Each daemon route's view (see daemonRouteKey). A TUI starts on its local
   * socket and a route switch clears the view, so one shared view could never
   * restore an /ssh session. Absent in older files.
   */
  routes?: Record<string, RouteViewState>;
  /** Written briefly before `routes`: only each route's tree expansion. Read, never written. */
  expandedFolderIdsByRoute?: Record<string, string[]>;
}

/** The daemon a TUI is talking to: its local socket, or a remote one through an SSH alias. */
export function daemonRouteKey(sshAlias: string | null): string {
  return sshAlias ? `ssh:${sshAlias}` : "local";
}

function copyRouteViewState(view: RouteViewState): RouteViewState {
  return {
    focusedConversationId: view.focusedConversationId,
    sidebarCursor: view.sidebarCursor
      ? { ...view.sidebarCursor, selectedItem: copySidebarItem(view.sidebarCursor.selectedItem) }
      : null,
    expandedFolderIds: [...view.expandedFolderIds],
    conversationScrollPositions: { ...view.conversationScrollPositions },
  };
}

const EMPTY_ROUTE_VIEW: RouteViewState = {
  focusedConversationId: null,
  sidebarCursor: null,
  expandedFolderIds: [],
  conversationScrollPositions: {},
};

/**
 * Files from before per-route views kept one view, of whichever route was used
 * last; it seeds every route. Ids from another daemon are harmless: a missing
 * conversation is dropped quietly and the route's lists prune the rest.
 */
function legacyRouteView(startingState: TuiStartingState, routeKey: string): RouteViewState {
  const sidebar = startingState.sidebar;
  return {
    focusedConversationId: startingState.focusedConversationId,
    sidebarCursor: sidebar.open
      ? { currentFolderId: sidebar.currentFolderId, selectedItem: sidebar.selectedItem, scrollOffset: sidebar.scrollOffset }
      : null,
    expandedFolderIds: startingState.expandedFolderIdsByRoute?.[routeKey] ?? sidebar.expandedFolderIds ?? [],
    conversationScrollPositions: startingState.conversationScrollPositions,
  };
}

/** Each route's view across a session, including routes not currently selected. */
export class RouteViewStates {
  private readonly byRoute = new Map<string, RouteViewState>();
  private readonly legacy: TuiStartingState | null;

  constructor(startingState: TuiStartingState | null) {
    for (const [routeKey, view] of Object.entries(startingState?.routes ?? {})) {
      this.byRoute.set(routeKey, copyRouteViewState(view));
    }
    this.legacy = startingState && !startingState.routes ? startingState : null;
  }

  /** The view to restore on reaching a route; a route never seen starts empty. */
  forRoute(routeKey: string): RouteViewState {
    const view = this.byRoute.get(routeKey) ?? (this.legacy ? legacyRouteView(this.legacy, routeKey) : EMPTY_ROUTE_VIEW);
    return copyRouteViewState(view);
  }

  remember(routeKey: string, view: RouteViewState): void {
    this.byRoute.set(routeKey, copyRouteViewState(view));
  }

  snapshot(): Record<string, RouteViewState> {
    return Object.fromEntries([...this.byRoute].map(([routeKey, view]) => [routeKey, copyRouteViewState(view)]));
  }
}

export function tuiStartingStatePath(): string {
  return join(storageDir(), "tui-state.json");
}

function copySidebarItem(item: SidebarSelectableItem | null): SidebarSelectableItem | null {
  if (!item) return null;
  if (item.type === "up") return { type: "up" };
  return { type: item.type, id: item.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseOptionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseSidebarItem(value: unknown): SidebarSelectableItem | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  if (value.type === "up") return { type: "up" };
  // Older files may still select the folder AGENTS.md row the sidebar used to list.
  if (value.type === "folder_instructions") {
    const folderId = parseOptionalId(value.folderId);
    return typeof folderId === "string" ? { type: "folder", id: folderId } : undefined;
  }
  if (value.type === "folder" || value.type === "conversation") {
    const id = parseOptionalId(value.id);
    return typeof id === "string" ? { type: value.type, id } : undefined;
  }
  return undefined;
}

/** Older files have no expanded folders; a malformed list only loses expansion. */
function parseExpandedFolderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string" && id.length > 0);
}

function parseExpandedFolderIdsByRoute(value: unknown): Record<string, string[]> | undefined {
  if (!isRecord(value)) return undefined;
  const byRoute: Record<string, string[]> = {};
  for (const [routeKey, ids] of Object.entries(value)) {
    if (routeKey.length > 0) byRoute[routeKey] = parseExpandedFolderIds(ids);
  }
  return byRoute;
}

function parseSidebarCursor(value: unknown): SidebarCursorStartingState | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const currentFolderId = parseOptionalId(value.currentFolderId);
  const selectedItem = parseSidebarItem(value.selectedItem);
  const scrollOffset = value.scrollOffset;
  if (currentFolderId === undefined
      || selectedItem === undefined
      || typeof scrollOffset !== "number"
      || !Number.isSafeInteger(scrollOffset)
      || scrollOffset < 0) {
    return undefined;
  }
  return { currentFolderId, selectedItem, scrollOffset };
}

/** A malformed route only loses that route's view. */
function parseRouteViewState(value: unknown): RouteViewState | null {
  if (!isRecord(value)) return null;
  const focusedConversationId = parseOptionalId(value.focusedConversationId);
  const sidebarCursor = parseSidebarCursor(value.sidebarCursor);
  const conversationScrollPositions = parseConversationScrollPositions(value.conversationScrollPositions);
  if (focusedConversationId === undefined || sidebarCursor === undefined || conversationScrollPositions === null) return null;
  return {
    focusedConversationId,
    sidebarCursor,
    expandedFolderIds: parseExpandedFolderIds(value.expandedFolderIds),
    conversationScrollPositions,
  };
}

function parseRouteViewStates(value: unknown): Record<string, RouteViewState> | undefined {
  if (!isRecord(value)) return undefined;
  const routes: Record<string, RouteViewState> = {};
  for (const [routeKey, view] of Object.entries(value)) {
    const parsed = routeKey.length > 0 ? parseRouteViewState(view) : null;
    if (parsed) routes[routeKey] = parsed;
  }
  return routes;
}

function parseStartingState(value: unknown): TuiStartingState | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== TUI_STARTING_STATE_VERSION) || !isRecord(value.sidebar)) return null;

  const focusedConversationId = parseOptionalId(value.focusedConversationId);
  if (focusedConversationId === undefined || typeof value.sidebar.open !== "boolean") return null;
  const conversationScrollPositions = value.version === 1
    ? {}
    : parseConversationScrollPositions(value.conversationScrollPositions);
  if (conversationScrollPositions === null) return null;

  const expandedFolderIds = parseExpandedFolderIds(value.sidebar.expandedFolderIds);
  const routes = parseRouteViewStates(value.routes);
  const expandedFolderIdsByRoute = parseExpandedFolderIdsByRoute(value.expandedFolderIdsByRoute);
  const perRoute = {
    ...(routes ? { routes } : {}),
    ...(expandedFolderIdsByRoute ? { expandedFolderIdsByRoute } : {}),
  };
  if (!value.sidebar.open) {
    return {
      version: TUI_STARTING_STATE_VERSION,
      focusedConversationId,
      sidebar: { open: false, expandedFolderIds },
      conversationScrollPositions,
      ...perRoute,
    };
  }

  const cursor = parseSidebarCursor(value.sidebar);
  if (!cursor) return null;

  return {
    version: TUI_STARTING_STATE_VERSION,
    focusedConversationId,
    sidebar: { open: true, ...cursor, expandedFolderIds },
    conversationScrollPositions,
    ...perRoute,
  };
}

export function captureRouteViewState(state: RenderState): RouteViewState {
  return {
    focusedConversationId: state.convId,
    sidebarCursor: state.sidebar.open
      ? {
          currentFolderId: state.sidebar.currentFolderId,
          selectedItem: copySidebarItem(state.sidebar.selectedItem),
          scrollOffset: Math.max(0, Math.floor(state.sidebar.scrollOffset)),
        }
      : null,
    expandedFolderIds: [...state.sidebar.expandedFolderIds],
    conversationScrollPositions: captureConversationScrollPositions(state),
  };
}

/**
 * Seed a route's view before its daemon's first authoritative conversations
 * list arrives. The list then drops what that daemon no longer has.
 */
export function applyRouteViewState(state: RenderState, view: RouteViewState): void {
  state.convId = view.focusedConversationId;
  applyConversationScrollPositions(state, view.conversationScrollPositions);
  state.sidebar.expandedFolderIds = new Set(view.expandedFolderIds);
  const cursor = view.sidebarCursor;
  if (!state.sidebar.open || !cursor) return;

  state.sidebar.currentFolderId = cursor.currentFolderId;
  state.sidebar.selectedItem = copySidebarItem(cursor.selectedItem);
  state.sidebar.selectedId = cursor.selectedItem?.type === "conversation" ? cursor.selectedItem.id : null;
  state.sidebar.selectedIndex = 0;
  state.sidebar.scrollOffset = cursor.scrollOffset;
}

/**
 * `routes` holds every route's view; the current route's live view replaces
 * its entry and is repeated at the top level for older TUIs reading this file.
 */
export function captureTuiStartingState(
  state: RenderState,
  routes: RouteViewStates = new RouteViewStates(null),
  routeKey = daemonRouteKey(null),
): TuiStartingState {
  const view = captureRouteViewState(state);
  routes.remember(routeKey, view);
  const expandedFolderIds = view.expandedFolderIds;
  const sidebar = view.sidebarCursor
    ? { open: true as const, ...view.sidebarCursor, expandedFolderIds }
    : { open: false as const, expandedFolderIds };

  return {
    version: TUI_STARTING_STATE_VERSION,
    focusedConversationId: view.focusedConversationId,
    sidebar,
    conversationScrollPositions: view.conversationScrollPositions,
    routes: routes.snapshot(),
  };
}

/** A TUI always starts on its local socket; an /ssh route's view is applied when that route is selected. */
export function applyTuiStartingState(
  state: RenderState,
  startingState: TuiStartingState,
  routes = new RouteViewStates(startingState),
): void {
  state.sidebar.open = startingState.sidebar.open;
  applyRouteViewState(state, routes.forRoute(daemonRouteKey(null)));
}

/** Only load a saved conversation after the daemon confirms it still exists. */
export function availableStartingConversationId(
  startingState: Pick<TuiStartingState, "focusedConversationId">,
  conversations: Pick<ConversationSummary, "id">[],
): string | null {
  const convId = startingState.focusedConversationId;
  return convId && conversations.some(conversation => conversation.id === convId) ? convId : null;
}

export function loadTuiStartingState(): TuiStartingState | null {
  try {
    return parseStartingState(JSON.parse(readFileSync(tuiStartingStatePath(), "utf8")));
  } catch {
    return null;
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let directoryFd: number | null = null;
  try {
    directoryFd = openSync(directory, "r");
    fsyncSync(directoryFd);
  } catch {
    // Some platforms do not allow directories to be opened/fsynced. The file
    // replacement is still atomic there; this sync is only for crash durability.
  } finally {
    if (directoryFd !== null) {
      try { closeSync(directoryFd); } catch { /* best effort */ }
    }
  }
}

function atomicWriteFile(path: string, contents: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFd: number | null = null;

  try {
    // The temporary file is created beside its destination so rename is one
    // atomic filesystem operation. fsync makes the complete JSON durable before
    // it can replace the previous close's state.
    tempFd = openSync(tempPath, "wx", 0o600);
    writeFileSync(tempFd, contents, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    renameSync(tempPath, path);
    syncDirectoryBestEffort(directory);
  } catch (error) {
    if (tempFd !== null) {
      try { closeSync(tempFd); } catch { /* best effort */ }
    }
    try { rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function saveTuiStartingState(startingState: TuiStartingState): void {
  atomicWriteFile(tuiStartingStatePath(), `${JSON.stringify(startingState, null, 2)}\n`);
}
