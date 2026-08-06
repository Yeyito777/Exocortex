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

const TUI_STARTING_STATE_VERSION = 1;

interface ClosedSidebarStartingState {
  open: false;
}

interface OpenSidebarStartingState {
  open: true;
  currentFolderId: string | null;
  selectedItem: SidebarSelectableItem | null;
  scrollOffset: number;
}

export interface TuiStartingState {
  version: typeof TUI_STARTING_STATE_VERSION;
  focusedConversationId: string | null;
  sidebar: ClosedSidebarStartingState | OpenSidebarStartingState;
}

export function tuiStartingStatePath(): string {
  return join(storageDir(), "tui-state.json");
}

function copySidebarItem(item: SidebarSelectableItem | null): SidebarSelectableItem | null {
  if (!item) return null;
  if (item.type === "up") return { type: "up" };
  if (item.type === "folder_instructions") {
    return { type: "folder_instructions", folderId: item.folderId };
  }
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
  if (value.type === "folder_instructions") {
    const folderId = parseOptionalId(value.folderId);
    return typeof folderId === "string" ? { type: "folder_instructions", folderId } : undefined;
  }
  if (value.type === "folder" || value.type === "conversation") {
    const id = parseOptionalId(value.id);
    return typeof id === "string" ? { type: value.type, id } : undefined;
  }
  return undefined;
}

function parseStartingState(value: unknown): TuiStartingState | null {
  if (!isRecord(value) || value.version !== TUI_STARTING_STATE_VERSION || !isRecord(value.sidebar)) return null;

  const focusedConversationId = parseOptionalId(value.focusedConversationId);
  if (focusedConversationId === undefined || typeof value.sidebar.open !== "boolean") return null;

  if (!value.sidebar.open) {
    return {
      version: TUI_STARTING_STATE_VERSION,
      focusedConversationId,
      sidebar: { open: false },
    };
  }

  const currentFolderId = parseOptionalId(value.sidebar.currentFolderId);
  const selectedItem = parseSidebarItem(value.sidebar.selectedItem);
  const scrollOffset = value.sidebar.scrollOffset;
  if (currentFolderId === undefined
      || selectedItem === undefined
      || typeof scrollOffset !== "number"
      || !Number.isSafeInteger(scrollOffset)
      || scrollOffset < 0) {
    return null;
  }

  return {
    version: TUI_STARTING_STATE_VERSION,
    focusedConversationId,
    sidebar: {
      open: true,
      currentFolderId,
      selectedItem,
      scrollOffset,
    },
  };
}

export function captureTuiStartingState(state: Pick<RenderState, "convId" | "sidebar">): TuiStartingState {
  const sidebar = state.sidebar.open
    ? {
        open: true as const,
        currentFolderId: state.sidebar.currentFolderId,
        selectedItem: copySidebarItem(state.sidebar.selectedItem),
        scrollOffset: Math.max(0, Math.floor(state.sidebar.scrollOffset)),
      }
    : { open: false as const };

  return {
    version: TUI_STARTING_STATE_VERSION,
    focusedConversationId: state.convId,
    sidebar,
  };
}

/** Seed local state before the daemon's first authoritative conversations list arrives. */
export function applyTuiStartingState(state: RenderState, startingState: TuiStartingState): void {
  state.convId = startingState.focusedConversationId;
  state.sidebar.open = startingState.sidebar.open;
  if (!startingState.sidebar.open) return;

  state.sidebar.currentFolderId = startingState.sidebar.currentFolderId;
  state.sidebar.selectedItem = copySidebarItem(startingState.sidebar.selectedItem);
  state.sidebar.selectedId = startingState.sidebar.selectedItem?.type === "conversation"
    ? startingState.sidebar.selectedItem.id
    : null;
  state.sidebar.selectedIndex = 0;
  state.sidebar.scrollOffset = startingState.sidebar.scrollOffset;
}

/** Only load a saved conversation after the daemon confirms it still exists. */
export function availableStartingConversationId(
  startingState: TuiStartingState,
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
