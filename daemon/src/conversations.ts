/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map and dirty/flush mechanism for saving
 * to disk. Persistence operations are delegated to persistence.ts.
 * In-flight stream tracking lives in streaming.ts.
 */

import type { Conversation, ProviderId, ModelId, EffortLevel, ConversationSummary, FolderSummary, SidebarItemRef, StoredMessage, Block, MessageMetadata, PersistedConversationSummary, PersistedFolderSummary } from "./messages";
import { DEFAULT_EFFORT, createConversation, createMessageMetadata, createStoredUserMessage, isToolResultMessage, topUnpinnedOrder, bottomPinnedOrder, summarizeConversation } from "./messages";
import type { ImageAttachment } from "@exocortex/shared/messages";
import type { MoveSidebarItemsOptions, TrimMode, ToolOutputInfo } from "./protocol";
import { trimConversationInPlace, type TrimConversationResult } from "./conversation-trim";
import { buildDisplayData, collectToolOutputs, type ConversationDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";
import * as persistence from "./persistence";
import * as streaming from "./streaming";
import { log } from "./log";
import { normalizeEffort } from "./providers/registry";

// Re-export streaming functions so existing `convStore.*` call sites keep working
export {
  isStreaming, setActiveJob, getActiveJob, clearActiveJob, getStreamingStartedAt,
  setStreamingTokens, getStreamingTokens, nextStreamSeq, getStreamSeq,
  touchActivity, pauseActivity, resumeActivity,
  resetChunkCounter,
  initStreamingState, getCurrentStreamingBlocks, replaceCurrentStreamingBlocks, replaceStreamingDisplayMessages, getStreamingDisplayMessages,
  pushStreamingBlock, appendToStreamingBlock, clearCurrentStreamingBlocks,
  getQueuedMessages, pushQueuedMessage, drainQueuedMessages, clearQueuedMessages, removeQueuedMessage,
} from "./streaming";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const summaries = new Map<string, PersistedConversationSummary>();
const folders = new Map<string, PersistedFolderSummary>();
const dirty = new Set<string>();
const unread = new Set<string>();

// ── Summary/index persistence helpers ──────────────────────────────

function saveSummaryIndex(): void {
  const entries: persistence.ConversationIndexEntry[] = [];
  for (const summary of summaries.values()) {
    const loaded = conversations.get(summary.id);
    if (loaded) {
      entries.push(persistence.indexEntryFromConversation(loaded));
      continue;
    }
    try {
      entries.push({ ...summary, ...persistence.getConversationFileStat(summary.id) });
    } catch {
      // The file disappeared between a mutation and the index write; omit it.
    }
  }
  persistence.saveConversationIndex(entries);
}

function updateSummaryFromConversation(conv: Conversation): void {
  summaries.set(conv.id, summarizeConversation(conv));
}

// ── Sidebar/folder ordering helpers ───────────────────────────────

type SidebarOrderEntry = { type: "conversation" | "folder"; id: string; pinned: boolean; sortOrder: number };

function sidebarItemKey(item: SidebarItemRef): string {
  return `${item.type}:${item.id}`;
}

function sortSidebarEntries<T extends Pick<SidebarOrderEntry, "pinned" | "sortOrder">>(entries: T[]): T[] {
  return entries.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder);
}

function sidebarEntries(parentId: string | null): SidebarOrderEntry[] {
  const entries: SidebarOrderEntry[] = [];
  for (const summary of summaries.values()) {
    if ((summary.folderId ?? null) === parentId) {
      entries.push({ type: "conversation", id: summary.id, pinned: summary.pinned, sortOrder: summary.sortOrder });
    }
  }
  for (const folder of folders.values()) {
    if ((folder.parentId ?? null) === parentId) {
      entries.push({ type: "folder", id: folder.id, pinned: folder.pinned, sortOrder: folder.sortOrder });
    }
  }
  return sortSidebarEntries(entries);
}

function nextUnpinnedOrderInFolder(folderId: string | null, excludeId?: string): number {
  return topUnpinnedOrder(sidebarEntries(folderId).filter(e => e.id !== excludeId));
}

function nextPinnedOrderInFolder(folderId: string | null, excludeId?: string): number {
  return bottomPinnedOrder(sidebarEntries(folderId).filter(e => e.id !== excludeId), excludeId ?? "");
}

function saveFolderState(): void {
  persistence.saveFolders(sortSidebarEntries([...folders.values()]));
}

function getItemParent(item: SidebarItemRef): string | null | undefined {
  if (item.type === "conversation") return summaries.get(item.id)?.folderId ?? null;
  return folders.get(item.id)?.parentId ?? null;
}

function getItemPinned(item: SidebarItemRef): boolean | undefined {
  if (item.type === "conversation") return summaries.get(item.id)?.pinned;
  return folders.get(item.id)?.pinned;
}

function getItemSortOrder(item: SidebarItemRef): number | undefined {
  if (item.type === "conversation") return summaries.get(item.id)?.sortOrder;
  return folders.get(item.id)?.sortOrder;
}

function setItemSortOrder(item: SidebarItemRef, sortOrder: number): boolean {
  if (item.type === "conversation") {
    const conv = get(item.id);
    if (!conv) return false;
    conv.sortOrder = sortOrder;
    markDirty(conv.id);
    flush(conv.id);
    return true;
  }
  const folder = folders.get(item.id);
  if (!folder) return false;
  folder.sortOrder = sortOrder;
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

function isDescendantFolder(folderId: string, candidateParentId: string | null): boolean {
  let current = candidateParentId;
  while (current) {
    if (current === folderId) return true;
    current = folders.get(current)?.parentId ?? null;
  }
  return false;
}

function descendantFolderIdsIncluding(folderId: string): Set<string> {
  const ids = new Set<string>();
  const queue = [folderId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (ids.has(current)) continue;
    ids.add(current);
    for (const folder of folders.values()) {
      if ((folder.parentId ?? null) === current) queue.push(folder.id);
    }
  }
  return ids;
}

function childSnapshots(folderId: string): persistence.TrashSidebarItemSnapshot[] {
  return sidebarEntries(folderId).map((entry) => ({
    item: { type: entry.type, id: entry.id },
    parentId: getItemParent({ type: entry.type, id: entry.id }) ?? null,
    pinned: entry.pinned,
    sortOrder: entry.sortOrder,
  }));
}

// ── Conversation loading/mutation helpers ─────────────────────────

function loadConversation(id: string): Conversation | undefined {
  const cached = conversations.get(id);
  if (cached) return cached;

  const conv = persistence.load(id);
  if (!conv) return undefined;
  const normalizedEffort = normalizeEffort(conv.provider, conv.model, conv.effort);
  if (normalizedEffort !== conv.effort) {
    conv.effort = normalizedEffort;
    markDirty(conv.id);
  }
  conversations.set(id, conv);
  updateSummaryFromConversation(conv);
  if (dirty.has(conv.id)) flush(conv.id);
  return conv;
}

function applyConversationMutation(id: string, conv: Conversation): void {
  conv.lastContextTokens = null;
  conv.updatedAt = Date.now();
  markDirty(id);
  flush(id);
}

export function trimConversation(id: string, mode: TrimMode, count: number): TrimConversationResult | null {
  const conv = get(id);
  if (!conv) return null;

  const result = trimConversationInPlace(conv, mode, count);
  if (result.changed) applyConversationMutation(id, conv);
  return result;
}

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversation CRUD/configuration ─────────────────────────────────

export function create(id: string, provider: ProviderId, model: ModelId, title?: string, effort?: EffortLevel, fastMode = false, folderId: string | null = null): Conversation {
  const parentId = folderId && folders.has(folderId) ? folderId : null;
  const conv = createConversation(id, provider, model, nextUnpinnedOrderInFolder(parentId), title, effort, fastMode, parentId);
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
  return conv;
}

export function createWithInitialUserMessage(
  id: string,
  provider: ProviderId,
  model: ModelId,
  title: string | undefined,
  effort: EffortLevel | undefined,
  fastMode: boolean,
  message: { text: string; startedAt: number; images?: ImageAttachment[] },
  folderId: string | null = null,
): Conversation {
  const parentId = folderId && folders.has(folderId) ? folderId : null;
  const conv = createConversation(id, provider, model, nextUnpinnedOrderInFolder(parentId), title, effort, fastMode, parentId);
  conv.messages.push(createStoredUserMessage(message.text, model, message.startedAt, message.images));
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
  return conv;
}

/** Bump an unpinned conversation to the top of the unpinned section. No-op for pinned conversations. */
export function bumpToTop(id: string): boolean {
  const conv = get(id);
  if (!conv || conv.pinned) return false;
  conv.sortOrder = nextUnpinnedOrderInFolder(conv.folderId ?? null, id);
  markDirty(id);
  return true;
}

/** Clone a conversation: deep-copy with a new ID, placed right after the original in sort order. */
export function clone(id: string): Conversation | null {
  const src = get(id);
  if (!src) return null;

  const newId = generateId();
  const now = Date.now();

  // Compute a sortOrder between the original and the item after it in the same folder.
  const siblings = sidebarEntries(src.folderId ?? null);
  const srcIdx = siblings.findIndex(s => s.type === "conversation" && s.id === id);
  let newOrder: number;
  if (srcIdx >= 0 && srcIdx + 1 < siblings.length && siblings[srcIdx + 1].pinned === src.pinned) {
    // Place between the original and the next item in the same section
    newOrder = (src.sortOrder + siblings[srcIdx + 1].sortOrder) / 2;
  } else {
    // Last item in its section — place after it
    newOrder = src.sortOrder + 1;
  }

  const conv: Conversation = {
    id: newId,
    provider: src.provider,
    model: src.model,
    effort: src.effort ?? DEFAULT_EFFORT,
    fastMode: src.fastMode ?? false,
    messages: structuredClone(src.messages),
    createdAt: now,
    updatedAt: now,
    lastContextTokens: src.lastContextTokens,
    marked: src.marked,
    pinned: src.pinned,
    sortOrder: newOrder,
    folderId: src.folderId ?? null,
    title: (src.title || "clone") + " 📋",
  };

  conversations.set(newId, conv);
  markDirty(newId);
  flush(newId);
  return conv;
}

export function get(id: string): Conversation | undefined {
  return loadConversation(id);
}

export function remove(id: string): boolean {
  const existed = summaries.has(id) || conversations.has(id);
  if (existed) {
    conversations.delete(id);
    summaries.delete(id);
    dirty.delete(id);
    unread.delete(id);
    streaming.clearActiveJob(id);
    streaming.resetChunkCounter(id);
    streaming.clearQueuedMessages(id);
    persistence.trashFile(id);
    saveSummaryIndex();
  }
  return existed;
}

export type UndoDeleteResult =
  | { type: "conversation"; conversation: Conversation }
  | { type: "sidebar_state" };

/** Restore the most recent undoable delete/unwrap operation, or null if trash is empty. */
export function undoDelete(): UndoDeleteResult | null {
  const restored = persistence.restoreLatest();
  if (!restored) return null;

  if (restored.type === "conversation") {
    const conv = restored.conversation;
    conversations.set(conv.id, conv);
    updateSummaryFromConversation(conv);
    saveSummaryIndex();
    log("info", `conversations: restored ${conv.id} from trash`);
    return { type: "conversation", conversation: conv };
  }

  if (restored.type === "folder_recursive") {
    for (const folder of restored.folders) {
      folders.set(folder.id, { ...folder });
    }
    for (const conv of restored.conversations) {
      conversations.set(conv.id, conv);
      updateSummaryFromConversation(conv);
    }
    saveFolderState();
    saveSummaryIndex();
    log("info", `conversations: restored folder tree from trash (${restored.folders.length} folders, ${restored.conversations.length} conversations)`);
    return { type: "sidebar_state" };
  }

  folders.set(restored.folder.id, { ...restored.folder });
  for (const child of restored.children) {
    if (child.item.type === "conversation") {
      const conv = get(child.item.id);
      if (!conv) continue;
      conv.folderId = child.parentId;
      conv.pinned = child.pinned;
      conv.sortOrder = child.sortOrder;
      markDirty(conv.id);
      flush(conv.id);
    } else {
      const folder = folders.get(child.item.id);
      if (!folder) continue;
      folder.parentId = child.parentId;
      folder.pinned = child.pinned;
      folder.sortOrder = child.sortOrder;
      folder.updatedAt = Date.now();
    }
  }
  saveFolderState();
  saveSummaryIndex();
  log("info", `conversations: restored unwrapped folder ${restored.folder.id}`);
  return { type: "sidebar_state" };
}

export function setModel(id: string, provider: ProviderId, model: ModelId, effort: EffortLevel, fastMode: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.provider = provider;
  conv.model = model;
  conv.effort = effort;
  conv.fastMode = fastMode;
  conv.lastContextTokens = null;
  conv.updatedAt = Date.now();
  markDirty(id);
  flush(id);
  return true;
}

export function setEffort(id: string, effort: EffortLevel): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.effort = effort;
  markDirty(id);
  flush(id);
  return true;
}

export function setFastMode(id: string, enabled: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.fastMode = enabled;
  markDirty(id);
  flush(id);
  return true;
}

export function rename(id: string, title: string): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.title = title;
  markDirty(id);
  flush(id);
  return true;
}

/** Set or update per-conversation system instructions. Empty text clears them. */
export function setSystemInstructions(id: string, text: string): boolean {
  const conv = get(id);
  if (!conv) return false;

  const hasExisting = conv.messages.length > 0 && conv.messages[0].role === "system_instructions";
  let changed = false;

  if (text === "") {
    // Clear: remove the system_instructions message if present
    if (hasExisting) {
      conv.messages.splice(0, 1);
      changed = true;
    }
  } else if (hasExisting) {
    // Update existing
    if (conv.messages[0].content !== text) {
      conv.messages[0].content = text;
      changed = true;
    }
  } else {
    // Insert new at the front
    conv.messages.unshift({ role: "system_instructions", content: text, metadata: null });
    changed = true;
  }

  if (changed) conv.updatedAt = Date.now();
  markDirty(id);
  flush(id);
  return true;
}

/** Get the per-conversation system instructions text, or null if none. */
export function getSystemInstructions(id: string): string | null {
  const conv = get(id);
  if (!conv) return null;
  if (conv.messages.length > 0 && conv.messages[0].role === "system_instructions") {
    return typeof conv.messages[0].content === "string" ? conv.messages[0].content : null;
  }
  return null;
}

/**
 * Unwind a conversation to before the Nth user message (0-based).
 * Removes that user message and everything after it.
 * Also aborts any active stream and clears any queued messages.
 * Returns a promise that resolves when any active stream has stopped.
 */
export async function unwindTo(id: string, userMessageIndex: number): Promise<boolean> {
  const conv = get(id);
  if (!conv) return false;

  // Validate the index before doing anything destructive.
  // Only count real user messages — tool_result messages also have
  // role="user" but are invisible in the TUI (folded into AI entries).
  // Skip system_instructions (always at index 0) — they're never unwound.
  let spliceAt = -1;
  let userCount = 0;
  for (let i = 0; i < conv.messages.length; i++) {
    if (conv.messages[i].role === "system_instructions") continue;
    if (conv.messages[i].role === "user" && !isToolResultMessage(conv.messages[i])) {
      if (userCount === userMessageIndex) { spliceAt = i; break; }
      userCount++;
    }
  }
  if (spliceAt === -1) return false;

  // Clear queued messages first — prevents the orchestrator's finally block
  // from draining the queue and starting a new stream after we abort.
  streaming.clearQueuedMessages(id);

  // Abort any active stream and wait for it to fully stop
  const ac = streaming.getActiveJob(id);
  if (ac) {
    ac.abort();
    const stopped = await waitForStreamStop(id);
    if (!stopped) log("warn", `conversations: stream for ${id} did not stop within timeout, unwinding anyway`);
  }

  conv.messages.splice(spliceAt);
  conv.updatedAt = Date.now();
  markDirty(id);
  flush(id);
  return true;
}

/** Wait for a streaming job to finish (poll until activeJob clears). Returns false on timeout. */
function waitForStreamStop(id: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (!streaming.isStreaming(id)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 10);
    };
    check();
  });
}

// ── Startup/load and flush persistence ──────────────────────────────

export interface LoadFromDiskStats {
  loaded: number;
  total: number;
  normalizedEffort: number;
  deduplicatedSortOrders: number;
  durationMs: number;
  indexReused: number;
  indexRebuilt: number;
  indexRemoved: number;
  indexSaved: boolean;
}

/** Load conversation summaries from disk into memory on daemon startup. Full conversations are lazy-loaded on demand. */
export function loadFromDisk(): LoadFromDiskStats {
  const startedAt = performance.now();
  const index = persistence.loadConversationIndex();
  summaries.clear();
  folders.clear();
  for (const folder of persistence.loadFolders()) {
    folders.set(folder.id, { ...folder, parentId: folder.parentId && folder.parentId !== folder.id ? folder.parentId : null });
  }

  let normalizedEffortCount = 0;
  for (const summary of index.summaries) {
    const normalizedEffort = normalizeEffort(summary.provider, summary.model, summary.effort);
    if (normalizedEffort !== summary.effort) {
      summary.effort = normalizedEffort;
      normalizedEffortCount++;
    }
    summary.folderId = summary.folderId && folders.has(summary.folderId) ? summary.folderId : null;
    summaries.set(summary.id, summary);
  }
  log("info", `conversations: loaded ${summaries.size} summaries from disk (index reused=${index.reused}, rebuilt=${index.rebuilt})`);

  // Deduplicate sortOrders — duplicate values cause move operations to
  // be no-ops (swapping identical values).  Walk each folder+pinned section
  // in order and bump any collision by a small offset.
  const sorted = [...summaries.values()].sort(
    (a, b) => ((a.folderId ?? "") === (b.folderId ?? "") ? 0 : (a.folderId ?? "").localeCompare(b.folderId ?? ""))
      || (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1)
      || a.sortOrder - b.sortOrder,
  );
  const seen = new Set<string>();    // "folder:pinned:sortOrder"
  let fixed = 0;
  for (const summary of sorted) {
    const key = `${summary.folderId ?? "root"}:${summary.pinned}:${summary.sortOrder}`;
    if (seen.has(key)) {
      summary.sortOrder += 0.001 * ++fixed;
      const conv = get(summary.id);
      if (conv) {
        conv.sortOrder = summary.sortOrder;
        markDirty(conv.id);
      }
    }
    seen.add(`${summary.folderId ?? "root"}:${summary.pinned}:${summary.sortOrder}`);
  }
  if (fixed > 0 || normalizedEffortCount > 0 || index.saved) {
    log("info", `conversations: repaired index (deduplicated=${fixed}, normalizedEffort=${normalizedEffortCount})`);
    if (dirty.size > 0) flushAll();
    else saveSummaryIndex();
  }

  return {
    loaded: index.summaries.length,
    total: summaries.size,
    normalizedEffort: normalizedEffortCount,
    deduplicatedSortOrders: fixed,
    durationMs: performance.now() - startedAt,
    indexReused: index.reused,
    indexRebuilt: index.rebuilt,
    indexRemoved: index.removed,
    indexSaved: index.saved,
  };
}

/** Mark a conversation as needing a save. */
export function markDirty(id: string): void {
  dirty.add(id);
}

/** Flush a dirty conversation to disk. */
export function flush(id: string): void {
  if (!dirty.has(id)) return;
  const conv = conversations.get(id);
  if (!conv) return;
  persistence.save(conv);
  dirty.delete(id);
  updateSummaryFromConversation(conv);
  saveSummaryIndex();
}

/** Flush all dirty conversations. */
export function flushAll(): void {
  for (const id of dirty) {
    const conv = conversations.get(id);
    if (!conv) continue;
    persistence.save(conv);
    updateSummaryFromConversation(conv);
  }
  dirty.clear();
  saveSummaryIndex();
}

/** Track chunk count and flush every N chunks. Returns true on save boundaries. */
export function onChunk(id: string): boolean {
  if (streaming.onChunk(id)) {
    markDirty(id);
    flush(id);
    return true;
  }
  return false;
}

// ── Sidebar/listing state ───────────────────────────────────────────

/** Get conversation summaries for the sidebar (from in-memory state). */
export function listSummaries(): ConversationSummary[] {
  const result: ConversationSummary[] = [];
  for (const summary of summaries.values()) {
    result.push({
      ...summary,
      streaming: streaming.isStreaming(summary.id),
      unread: unread.has(summary.id),
    });
  }
  sortSidebarEntries(result);
  return result;
}

export function listFolders(): FolderSummary[] {
  return sortSidebarEntries([...folders.values()].map(folder => ({ ...folder })));
}

export function listSidebarState(): { conversations: ConversationSummary[]; folders: FolderSummary[] } {
  return { conversations: listSummaries(), folders: listFolders() };
}

/** List conversation IDs that currently have an in-flight stream. */
export function listRunningConversationIds(): string[] {
  return listSummaries()
    .filter((summary) => summary.streaming)
    .map((summary) => summary.id);
}

// ── Conversation sidebar actions ───────────────────────────────────

/** Toggle or set the marked flag on a conversation. */
export function mark(id: string, marked: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.marked = marked;
  markDirty(id);
  flush(id);
  return true;
}

/** Toggle or set the pinned flag on a conversation. */
export function pin(id: string, pinned: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.pinned = pinned;
  conv.sortOrder = pinned
    ? nextPinnedOrderInFolder(conv.folderId ?? null, id)
    : nextUnpinnedOrderInFolder(conv.folderId ?? null, id);
  markDirty(id);
  flush(id);
  return true;
}

/** Move a conversation up or down within its folder section (pinned or unpinned). */
export function move(id: string, direction: "up" | "down"): boolean {
  return moveSidebarItem({ type: "conversation", id }, direction);
}

// ── Folder operations ───────────────────────────────────────────────

export function createFolder(name: string, parentId: string | null = null, items: SidebarItemRef[] = []): FolderSummary | null {
  const cleanName = name.trim();
  if (!cleanName) return null;
  const safeParent = parentId && folders.has(parentId) ? parentId : null;
  const now = Date.now();
  const selectedItemsInParent = items.filter(item => getItemParent(item) === safeParent);
  const selectedOrders = selectedItemsInParent
    .map(item => getItemSortOrder(item))
    .filter((order): order is number => typeof order === "number");
  const selectedPinnedStates = selectedItemsInParent
    .map(item => getItemPinned(item))
    .filter((pinned): pinned is boolean => typeof pinned === "boolean");
  const pinned = selectedPinnedStates.length > 0 && selectedPinnedStates.every(Boolean);
  const folder: PersistedFolderSummary = {
    id: `folder-${generateId()}`,
    name: cleanName,
    parentId: safeParent,
    createdAt: now,
    updatedAt: now,
    pinned,
    sortOrder: selectedOrders.length > 0
      ? Math.min(...selectedOrders)
      : pinned ? nextPinnedOrderInFolder(safeParent) : nextUnpinnedOrderInFolder(safeParent),
  };
  folders.set(folder.id, folder);
  saveFolderState();
  if (items.length > 0) moveSidebarItems(items, folder.id);
  return { ...folder };
}

export function renameFolder(folderId: string, name: string): boolean {
  const folder = folders.get(folderId);
  const cleanName = name.trim();
  if (!folder || !cleanName) return false;
  folder.name = cleanName;
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

export function pinFolder(folderId: string, pinned: boolean): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;
  folder.pinned = pinned;
  folder.sortOrder = pinned
    ? nextPinnedOrderInFolder(folder.parentId ?? null, folder.id)
    : nextUnpinnedOrderInFolder(folder.parentId ?? null, folder.id);
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

export function moveSidebarItem(item: SidebarItemRef, direction: "up" | "down"): boolean {
  const parentId = getItemParent(item);
  const pinned = getItemPinned(item);
  if (parentId === undefined || pinned === undefined) return false;

  const siblings = sidebarEntries(parentId);
  const idx = siblings.findIndex(entry => entry.type === item.type && entry.id === item.id);
  if (idx === -1) return false;
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= siblings.length) return false;
  const target = siblings[targetIdx];
  if (target.pinned !== pinned) return false;

  const currentOrder = getItemSortOrder(item);
  if (currentOrder === undefined) return false;
  const targetRef: SidebarItemRef = { type: target.type, id: target.id };
  const targetOrder = target.sortOrder;
  setItemSortOrder(item, targetOrder);
  setItemSortOrder(targetRef, currentOrder);

  if (targetOrder === currentOrder) {
    setItemSortOrder(item, currentOrder + (direction === "up" ? -0.5 : 0.5));
  }
  return true;
}

export function listFolderConversationIds(folderId: string): string[] {
  const folderIds = descendantFolderIdsIncluding(folderId);
  return [...summaries.values()]
    .filter(summary => summary.folderId && folderIds.has(summary.folderId))
    .map(summary => summary.id);
}

export function moveSidebarItems(
  items: SidebarItemRef[],
  parentId: string | null,
  before?: SidebarItemRef,
  options: MoveSidebarItemsOptions = {},
): boolean {
  const safeParent = parentId && folders.has(parentId) ? parentId : null;
  let moved = false;
  const seen = new Set<string>();
  const movableItems: SidebarItemRef[] = [];
  for (const item of items) {
    const key = sidebarItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.type === "folder" && (item.id === safeParent || isDescendantFolder(item.id, safeParent))) continue;
    if (item.type === "conversation" && !summaries.has(item.id) && !conversations.has(item.id)) continue;
    if (item.type === "folder" && !folders.has(item.id)) continue;
    movableItems.push(item);
  }
  if (movableItems.length === 0) return false;

  const movingKeys = new Set(movableItems.map(sidebarItemKey));
  const destinationEntries = sidebarEntries(safeParent).filter(entry => !movingKeys.has(sidebarItemKey({ type: entry.type, id: entry.id })));
  const preservedPinned = options.preservePinned ? getItemPinned(movableItems[0]) : undefined;
  const hasHomogeneousPinnedState = preservedPinned !== undefined && movableItems.every(item => getItemPinned(item) === preservedPinned);
  const anchorEntries = hasHomogeneousPinnedState
    ? destinationEntries.filter(entry => entry.pinned === preservedPinned)
    : destinationEntries;
  const beforeEntry = before && getItemParent(before) === safeParent
    ? anchorEntries.find(entry => entry.type === before.type && entry.id === before.id)
    : undefined;
  const beforeIndex = beforeEntry ? anchorEntries.findIndex(entry => entry.type === beforeEntry.type && entry.id === beforeEntry.id) : -1;
  const previousEntry = beforeIndex > 0 ? anchorEntries[beforeIndex - 1] : undefined;

  let startOrder: number;
  let step: number;
  if (beforeEntry) {
    startOrder = previousEntry
      ? previousEntry.sortOrder + ((beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1))
      : beforeEntry.sortOrder - movableItems.length;
    step = previousEntry ? (beforeEntry.sortOrder - previousEntry.sortOrder) / (movableItems.length + 1) : 1;
  } else if (options.placement === "bottom") {
    const placementEntries = hasHomogeneousPinnedState ? anchorEntries : destinationEntries;
    const maxOrder = placementEntries.reduce((max, entry) => Math.max(max, entry.sortOrder), -Infinity);
    startOrder = maxOrder === -Infinity ? 0 : maxOrder + 1;
    step = 1;
  } else {
    startOrder = nextUnpinnedOrderInFolder(safeParent) - movableItems.length;
    step = 1;
  }

  let order = startOrder - step;
  for (const item of movableItems) {
    order += step;
    const pinned = options.preservePinned ? getItemPinned(item) ?? false : false;
    if (item.type === "conversation") {
      const conv = get(item.id);
      if (!conv) continue;
      conv.folderId = safeParent;
      conv.pinned = pinned;
      conv.sortOrder = order;
      markDirty(conv.id);
      flush(conv.id);
      moved = true;
    } else {
      const folder = folders.get(item.id);
      if (!folder) continue;
      folder.parentId = safeParent;
      folder.pinned = pinned;
      folder.sortOrder = order;
      folder.updatedAt = Date.now();
      moved = true;
    }
  }
  if (moved) saveFolderState();
  return moved;
}

export function deleteFolder(folderId: string, mode: "recursive" | "unwrap" = "recursive"): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;

  if (mode === "unwrap") {
    const parentId = folder.parentId ?? null;
    const children: SidebarItemRef[] = sidebarEntries(folderId).map(entry => ({ type: entry.type, id: entry.id }));
    try {
      persistence.pushTrashEntry({ type: "folder_unwrap", folder: { ...folder }, children: childSnapshots(folderId) });
    } catch (err) {
      log("error", `conversations: failed to record undo entry before unwrapping folder ${folderId}: ${err}`);
      return false;
    }

    // Unwrap children into the exact slot occupied by the folder before deleting
    // the folder record. Moving while the folder still exists lets moveSidebarItems
    // use it as a stable insertion anchor; deleting first would dump children at the
    // top of the parent and make the TUI cursor appear to flicker/jump.
    if (children.length > 0) moveSidebarItems(children, parentId, { type: "folder", id: folderId });
    folders.delete(folderId);
    saveFolderState();
    return true;
  }

  const folderIds = descendantFolderIdsIncluding(folderId);
  const folderSnapshots = [...folders.values()]
    .filter(candidate => folderIds.has(candidate.id))
    .map(candidate => ({ ...candidate }));
  const conversationIds = [...summaries.values()]
    .filter(summary => summary.folderId && folderIds.has(summary.folderId))
    .map(summary => summary.id);

  for (const convId of conversationIds) {
    if (dirty.has(convId)) flush(convId);
  }
  if (!persistence.trashFolderRecursive({ type: "folder_recursive", folderId, folders: folderSnapshots, conversationIds })) {
    return false;
  }

  for (const convId of conversationIds) {
    conversations.delete(convId);
    summaries.delete(convId);
    dirty.delete(convId);
    unread.delete(convId);
    streaming.clearActiveJob(convId);
    streaming.resetChunkCounter(convId);
    streaming.clearQueuedMessages(convId);
  }
  for (const id of folderIds) folders.delete(id);
  saveFolderState();
  saveSummaryIndex();
  return true;
}

// ── Conversation summaries ─────────────────────────────────────────

/** Get a single conversation's summary. */
export function getSummary(id: string): ConversationSummary | null {
  const loaded = conversations.get(id);
  const summary = loaded ? summarizeConversation(loaded) : summaries.get(id);
  if (!summary) return null;
  return {
    ...summary,
    streaming: streaming.isStreaming(id),
    unread: unread.has(id),
  };
}

// ── Display data ───────────────────────────────────────────────────

export type { ConversationDisplayData, DisplayEntry } from "./display";

export interface ConversationRenderSnapshot extends ConversationDisplayData {
  pendingAI?: {
    blocks: Block[];
    metadata: MessageMetadata | null;
  };
}

function buildSnapshotDisplayData(
  conv: Conversation,
  messages: StoredMessage[],
  includeToolOutputs: boolean,
): ConversationDisplayData {
  return buildDisplayData(
    conv.id,
    conv.provider,
    conv.model,
    conv.effort,
    conv.fastMode ?? false,
    messages,
    conv.lastContextTokens,
    summarizeTool,
    { includeToolOutputs },
  );
}

function isCurrentAssistantAlreadyCommitted(conv: Conversation, startedAt: number | undefined): boolean {
  return typeof startedAt === "number"
    && conv.messages.some((msg) => msg.role === "assistant" && msg.metadata?.startedAt === startedAt);
}

export function getRenderSnapshot(id: string, includeToolOutputs = true): ConversationRenderSnapshot | null {
  const conv = get(id);
  if (!conv) return null;

  const persisted = buildSnapshotDisplayData(conv, conv.messages, includeToolOutputs);
  if (!streaming.isStreaming(id)) return persisted;

  const startedAt = streaming.getStreamingStartedAt(id);
  if (isCurrentAssistantAlreadyCommitted(conv, startedAt)) return persisted;

  const transientMessages = streaming.getStreamingDisplayMessages(id);
  const transient = buildSnapshotDisplayData(conv, transientMessages, includeToolOutputs);
  const transientEntries = [...transient.entries];
  const trailingAssistant = transientEntries.at(-1);
  const currentBlocks = streaming.getCurrentStreamingBlocks(id) ?? [];
  const livePrefix = trailingAssistant?.type === "ai" ? trailingAssistant.blocks : [];

  if (trailingAssistant?.type === "ai") transientEntries.pop();

  return {
    ...persisted,
    entries: [...persisted.entries, ...transientEntries],
    pendingAI: {
      blocks: [...livePrefix, ...currentBlocks],
      metadata: createMessageMetadata(
        startedAt ?? Date.now(),
        conv.model,
        { tokens: streaming.getStreamingTokens(id) },
      ),
    },
  };
}

export function getDisplayData(id: string, includeToolOutputs = true): ConversationDisplayData | null {
  const conv = get(id);
  if (!conv) return null;
  const transientMessages = streaming.getStreamingDisplayMessages(id);
  return buildSnapshotDisplayData(
    conv,
    transientMessages.length > 0 ? [...conv.messages, ...transientMessages] : conv.messages,
    includeToolOutputs,
  );
}

export function getToolOutputs(id: string): ToolOutputInfo[] | null {
  const conv = get(id);
  if (!conv) return null;
  const transientMessages = streaming.getStreamingDisplayMessages(id);
  const messages = transientMessages.length > 0 ? [...conv.messages, ...transientMessages] : conv.messages;
  return collectToolOutputs(messages);
}

// ── Unread state (runtime only, not persisted) ──────────────────────

export function markUnread(convId: string): void {
  unread.add(convId);
}

export function clearUnread(convId: string): boolean {
  return unread.delete(convId);
}

export function isUnread(convId: string): boolean {
  return unread.has(convId);
}
