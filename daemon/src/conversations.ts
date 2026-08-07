/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map and dirty/flush mechanism for saving
 * to disk. Persistence operations are delegated to persistence.ts.
 * In-flight stream tracking lives in streaming.ts.
 */

import type { Conversation, ProviderId, ModelId, EffortLevel, ConversationSummary, FolderSummary, SidebarItemRef, StoredMessage, Block, MessageMetadata, PersistedConversationSummary, PersistedFolderSummary, ConversationGoal, ConversationGoalStatus, SubagentPolicy, ConversationToolPolicy } from "./messages";
import { CONTEXT_COMPACTION_FINISHED_KIND, DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, REALTIME_CALL_STATUS_KIND, REALTIME_TRANSCRIPT_KIND, cachedValidatedHistoryPrefixHashBeforeMessage, createConversation, countConversationMessages, createMessageMetadata, createModelVisibleSystemNotice, createStoredUserContextCheckpoint, createStoredUserMessage, historyPrefixHash, isRealUserMessage, isReplayHistoryMessage, isToolResultMessage, isValidActiveContextCached, rememberValidatedActiveContext, rewindActiveContextToHistoryCount, rewindValidatedActiveContextToHistoryCount, topUnpinnedOrder, bottomPinnedOrder, summarizeConversation, type StoredUserContextCheckpoint, validatedActiveContextCompactionHistoryCount } from "./messages";
import type { ImageAttachment, ToolPolicySnapshot } from "@exocortex/shared/messages";
import type { MoveSidebarItemsOptions, RealtimeCallSpeakerAttribution, TrimMode, ToolOutputInfo } from "./protocol";
import { trimConversationInPlace, type TrimConversationResult } from "./conversation-trim";
import { buildDisplayData, collectToolOutputs, type ConversationDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";
import * as persistence from "./persistence";
import { getConversationActivityCounts, getConversationTasks, stopBackgroundTasksForConversation } from "./conversation-activity";
import { ConversationWorkspaceRestoreError, assertConversationWorkspaceRestorable, createConversationWorkspace, reconcileConversationWorkspaces, restoreConversationWorkspace, trashConversationWorkspace } from "./workspace-service";
import * as streaming from "./streaming";
import * as messageQueue from "./message-queue";
import { log } from "./log";
import { notifyConversationRemoved, notifyConversationRemoving } from "./conversation-lifecycle";
import { getProvider, normalizeEffort } from "./providers/registry";
import { isDeepStrictEqual } from "node:util";
import { contextMessageChars } from "./context-token-attribution";
import { getConversationExternalIntegrations } from "./external-notifications";
import * as displayPageStore from "./display-page-store";
import { scheduleDisplayIndex } from "./display-index-backfill";
import { buildToolPolicySnapshot } from "./tool-policy";
import { clearConversationCustomTools } from "./tools/custom-tools";

// Re-export streaming functions so existing `convStore.*` call sites keep working
export {
  isStreaming, setActiveJob, getActiveJob, isRestartRecoverableJob, clearActiveJob, getStreamingStartedAt,
  setStreamingTokens, getStreamingTokens, nextStreamSeq, getStreamSeq,
  setContextCompactionStartedAt, getContextCompactionStartedAt,
  requestHistoryUnwind, isHistoryUnwindPending, clearHistoryUnwindPending,
  touchActivity, pauseActivity, resumeActivity,
  setActiveToolBackgrounder, clearActiveToolBackgrounder, backgroundActiveTool,
  resetChunkCounter,
  initStreamingState, getCurrentStreamingBlocks, replaceCurrentStreamingBlocks, replaceStreamingDisplayMessages, getStreamingDisplayMessages,
  setStreamingCommittedBlockCount, getStreamingCommittedBlockCount,
  pushStreamingBlock, appendToStreamingBlock, clearCurrentStreamingBlocks,
  requestGoalContinuationAfterStream, consumeGoalContinuationAfterStream, clearGoalContinuationAfterStream,
} from "./streaming";
export {
  getQueuedMessages, getQueuedMessageById, listQueuedMessages, listInternalQueuedMessages,
  pushQueuedMessage, pushGlobalIdleQueuedMessage, drainQueuedMessages,
  clearQueuedMessages, clearAllQueuedMessages, removeQueuedMessage, removeQueuedMessageById,
  removeQueuedMessagesById, updateQueuedMessage, moveQueuedMessage,
  persistQueuedMessagesSnapshot,
  suspendQueuedMessageDelivery, resumeQueuedMessageDelivery, isQueuedMessageDeliverySuspended,
  loadQueuedMessagesFromDisk, setQueuedMessagesChangedListener, setMessageQueuePersistenceFailureForTest,
} from "./message-queue";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const summaries = new Map<string, PersistedConversationSummary>();
const folders = new Map<string, PersistedFolderSummary>();
const folderInstructions = new Map<string, string>();
const dirty = new Set<string>();
/** Transcript content was mutated in place and requires field-level comparison. */
const messageContentDirty = new Set<string>();
/** Dirty state containing only rebuildable context-token attribution. */
const contextAttributionDirty = new Set<string>();
const unread = new Set<string>();
const renderSnapshotCache = new Map<string, Map<boolean, ConversationRenderSnapshot>>();

// Full transcripts are lazy-loaded, but historically every load stayed resident
// for the lifetime of the daemon. A startup scan (or enough ordinary opens) could
// therefore materialize the entire conversation corpus and retain several GiB.
// Keep summaries unbounded and cheap, while bounding only canonical transcripts.
const DEFAULT_CONVERSATION_CACHE_MAX_ENTRIES = 64;
const DEFAULT_CONVERSATION_CACHE_MAX_FILE_BYTES = 256 * 1024 * 1024;
let conversationCacheMaxEntries = DEFAULT_CONVERSATION_CACHE_MAX_ENTRIES;
let conversationCacheMaxFileBytes = DEFAULT_CONVERSATION_CACHE_MAX_FILE_BYTES;
const conversationCacheLru = new Map<string, true>();
const conversationCacheFileBytes = new Map<string, number>();
let conversationCacheTotalFileBytes = 0;

function cachedFileSize(id: string): number {
  try {
    return persistence.getConversationFileStat(id).fileSize;
  } catch {
    return 0;
  }
}

function setCachedFileSize(id: string, fileBytes: number): void {
  const previous = conversationCacheFileBytes.get(id) ?? 0;
  const normalized = Number.isFinite(fileBytes) && fileBytes > 0 ? fileBytes : 0;
  conversationCacheFileBytes.set(id, normalized);
  conversationCacheTotalFileBytes += normalized - previous;
}

function touchCachedConversation(id: string): void {
  conversationCacheLru.delete(id);
  conversationCacheLru.set(id, true);
}

function cacheIsOverLimit(): boolean {
  return conversations.size > conversationCacheMaxEntries
    || conversationCacheTotalFileBytes > conversationCacheMaxFileBytes;
}

function canEvictCachedConversation(id: string): boolean {
  if (dirty.has(id)) return false;
  if (streaming.isStreaming(id) || streaming.isHistoryUnwindPending(id)) return false;
  const activity = getConversationActivityCounts(id);
  return activity.subagentCount === 0 && activity.backgroundTaskCount === 0;
}

function evictCachedConversation(id: string): boolean {
  if (!conversations.delete(id)) return false;
  renderSnapshotCache.delete(id);
  conversationCacheLru.delete(id);
  conversationCacheTotalFileBytes -= conversationCacheFileBytes.get(id) ?? 0;
  conversationCacheFileBytes.delete(id);
  return true;
}

function pruneConversationCache(protectedId?: string): void {
  if (!cacheIsOverLimit()) return;
  for (const id of conversationCacheLru.keys()) {
    if (!cacheIsOverLimit()) break;
    if (id === protectedId || !canEvictCachedConversation(id)) continue;
    evictCachedConversation(id);
  }
}

function retainConversation(conv: Conversation): void {
  conversations.set(conv.id, conv);
  touchCachedConversation(conv.id);
  setCachedFileSize(conv.id, cachedFileSize(conv.id));
  // Never evict the object being returned by the current synchronous operation.
  pruneConversationCache(conv.id);
}

function saveUnreadState(): void {
  persistence.saveUnreadConversationIds([...unread].filter((id) =>
    (summaries.has(id) || conversations.has(id)) && !areConversationNotificationsMuted(id)
  ));
}

// ── Summary/index persistence helpers ──────────────────────────────

// Reordering large sidebars can persist several conversation files per keypress.
// Keep those file writes synchronous, but debounce the monolithic summary index
// rewrite so repeated e/Shift+E moves do not stat/stringify every chat twice per
// step. If the daemon exits before the debounce fires, the next load repairs the
// stale index from the changed conversation file mtimes; graceful shutdown calls
// flushAll(), which writes it immediately.
const SUMMARY_INDEX_DEBOUNCE_MS = 1000;
let summaryIndexDirty = false;
let summaryIndexSaveTimer: ReturnType<typeof setTimeout> | null = null;

type SummaryIndexFlushMode = "immediate" | "defer";

function saveSummaryIndexNow(): void {
  const entries: persistence.ConversationIndexEntry[] = [];
  for (const summary of summaries.values()) {
    const loaded = conversations.get(summary.id);
    if (loaded) {
      entries.push(persistence.indexEntryFromConversation(loaded));
      continue;
    }
    try {
      entries.push(persistence.indexEntryFromSummary(summary));
    } catch {
      // The file disappeared between a mutation and the index write; omit it.
    }
  }
  persistence.saveConversationIndex(entries);
}

function clearSummaryIndexSaveTimer(): void {
  if (!summaryIndexSaveTimer) return;
  clearTimeout(summaryIndexSaveTimer);
  summaryIndexSaveTimer = null;
}

function scheduleSummaryIndexSave(): void {
  summaryIndexDirty = true;
  clearSummaryIndexSaveTimer();
  summaryIndexSaveTimer = setTimeout(() => {
    summaryIndexSaveTimer = null;
    if (!summaryIndexDirty) return;
    summaryIndexDirty = false;
    saveSummaryIndexNow();
  }, SUMMARY_INDEX_DEBOUNCE_MS);
  summaryIndexSaveTimer.unref?.();
}

function saveSummaryIndex(mode: SummaryIndexFlushMode = "immediate"): void {
  if (mode === "defer") {
    scheduleSummaryIndexSave();
    return;
  }
  summaryIndexDirty = false;
  clearSummaryIndexSaveTimer();
  saveSummaryIndexNow();
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
  // Folder ancestry determines the instructions pinned into render snapshots.
  renderSnapshotCache.clear();
  persistence.saveFolders(sortSidebarEntries([...folders.values()]));
  pruneMutedUnreadState();
}

function saveFolderInstructionsState(): void {
  renderSnapshotCache.clear();
  persistence.saveFolderInstructions(folderInstructions);
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

function setConversationSidebarState(
  id: string,
  state: Pick<persistence.ConversationSidebarState, "folderId" | "pinned" | "sortOrder">,
): boolean {
  const summary = summaries.get(id);
  if (!summary) return false;
  const folderChanged = (summary.folderId ?? null) !== state.folderId;
  summary.folderId = state.folderId;
  summary.pinned = state.pinned;
  summary.sortOrder = state.sortOrder;
  const loaded = conversations.get(id);
  if (loaded) {
    loaded.folderId = state.folderId;
    loaded.pinned = state.pinned;
    loaded.sortOrder = state.sortOrder;
  }
  if (folderChanged) renderSnapshotCache.delete(id);
  return true;
}

function persistConversationSidebarStates(ids: Iterable<string>): void {
  const seen = new Set<string>();
  let persisted = false;
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const summary = summaries.get(id);
    if (!summary) continue;
    persistence.saveConversationSidebarState({
      id,
      folderId: summary.folderId ?? null,
      pinned: summary.pinned,
      sortOrder: summary.sortOrder,
    });
    persisted = true;
  }
  if (persisted) saveSummaryIndex("defer");
  pruneMutedUnreadState();
}

/** Update one item's order in memory. The caller batches the small durable writes. */
function setItemSortOrder(item: SidebarItemRef, sortOrder: number): boolean {
  if (item.type === "conversation") {
    const summary = summaries.get(item.id);
    if (!summary) return false;
    return setConversationSidebarState(item.id, {
      folderId: summary.folderId ?? null,
      pinned: summary.pinned,
      sortOrder,
    });
  }
  const folder = folders.get(item.id);
  if (!folder) return false;
  folder.sortOrder = sortOrder;
  folder.updatedAt = Date.now();
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

/** Folder muting is inherited through all ancestors. */
function areFolderNotificationsMuted(folderId: string | null | undefined): boolean {
  let currentId = folderId ?? null;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const folder = folders.get(currentId);
    if (!folder) return false;
    if (folder.muted === true) return true;
    currentId = folder.parentId;
  }
  return false;
}

function areConversationNotificationsMuted(id: string): boolean {
  const loaded = conversations.get(id);
  const summary = summaries.get(id);
  const directlyMuted = loaded ? loaded.muted === true : summary?.muted === true;
  const folderId = loaded ? loaded.folderId : summary?.folderId;
  return directlyMuted || areFolderNotificationsMuted(folderId);
}

/** Keep the durable unread set aligned when folder topology changes. */
function pruneMutedUnreadState(): void {
  let changed = false;
  for (const id of unread) {
    if (!areConversationNotificationsMuted(id)) continue;
    unread.delete(id);
    changed = true;
  }
  if (changed) saveUnreadState();
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

function sidebarItemSnapshot(item: SidebarItemRef): persistence.TrashSidebarItemSnapshot | null {
  const parentId = getItemParent(item);
  const pinned = getItemPinned(item);
  const sortOrder = getItemSortOrder(item);
  if (parentId === undefined || pinned === undefined || sortOrder === undefined) return null;
  return { item: { type: item.type, id: item.id }, parentId, pinned, sortOrder };
}

function sidebarItemSnapshots(items: SidebarItemRef[]): persistence.TrashSidebarItemSnapshot[] {
  const seen = new Set<string>();
  const snapshots: persistence.TrashSidebarItemSnapshot[] = [];
  for (const item of items) {
    const key = sidebarItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = sidebarItemSnapshot(item);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

function recordSidebarUndo(entry: persistence.TrashStackEntry): void {
  try {
    persistence.pushTrashEntry(entry);
  } catch (err) {
    log("error", `conversations: failed to record sidebar undo entry: ${err}`);
  }
}

function restoreSidebarItemSnapshots(snapshots: persistence.TrashSidebarItemSnapshot[]): boolean {
  let conversationChanged = false;
  let folderChanged = false;
  const changedConversationIds: string[] = [];

  for (const snapshot of snapshots) {
    if (snapshot.item.type === "conversation") {
      if (!setConversationSidebarState(snapshot.item.id, {
        folderId: snapshot.parentId,
        pinned: snapshot.pinned,
        sortOrder: snapshot.sortOrder,
      })) continue;
      changedConversationIds.push(snapshot.item.id);
      conversationChanged = true;
      continue;
    }

    const folder = folders.get(snapshot.item.id);
    if (!folder) continue;
    folder.parentId = snapshot.parentId && folders.has(snapshot.parentId) ? snapshot.parentId : null;
    folder.pinned = snapshot.pinned;
    folder.sortOrder = snapshot.sortOrder;
    folder.updatedAt = Date.now();
    folderChanged = true;
  }

  if (folderChanged) saveFolderState();
  if (conversationChanged) persistConversationSidebarStates(changedConversationIds);
  return conversationChanged || folderChanged;
}

function folderInstructionEntriesForFolder(folderId: string | null): string[] {
  if (!folderId) return [];
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = folders.get(current)?.parentId ?? null;
  }
  return chain.reverse().flatMap((id) => {
    const text = folderInstructions.get(id)?.trim();
    return text ? [text] : [];
  });
}

function formatFolderInstructionsForDisplay(folderId: string | null): string | null {
  const entries = folderInstructionEntriesForFolder(folderId);
  if (entries.length === 0) return null;
  return entries
    .map(text => `# Context from AGENTS.md:\n${text}`)
    .join("\n\n");
}

// ── Conversation loading/mutation helpers ─────────────────────────

function loadConversation(id: string): Conversation | undefined {
  const cached = conversations.get(id);
  if (cached) {
    touchCachedConversation(id);
    pruneConversationCache(id);
    return cached;
  }

  const conv = persistence.load(id);
  if (!conv) return undefined;
  const normalizedEffort = normalizeEffort(conv.provider, conv.model, conv.effort);
  if (normalizedEffort !== conv.effort) {
    conv.effort = normalizedEffort;
    markDirty(conv.id);
  }
  retainConversation(conv);
  updateSummaryFromConversation(conv);
  if (dirty.has(conv.id)) flush(conv.id);
  return conv;
}

function applyConversationMutation(id: string, conv: Conversation): void {
  conv.lastContextTokens = null;
  conv.activeContext = null;
  conv.updatedAt = Date.now();
  markDirty(id, "messages");
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

export function create(id: string, provider: ProviderId, model: ModelId, title?: string, effort?: EffortLevel, fastMode = false, folderId: string | null = null, adoptExistingWorkspace = false): Conversation {
  if (hasConversation(id) || persistence.hasDeletedConversation(id)) {
    throw new Error(`Conversation ${id} already exists or is recoverable from trash`);
  }
  createConversationWorkspace(id, { adoptExisting: adoptExistingWorkspace });
  const parentId = folderId && folders.has(folderId) ? folderId : null;
  const conv = createConversation(id, provider, model, nextUnpinnedOrderInFolder(parentId), title, effort, fastMode, parentId);
  retainConversation(conv);
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
  adoptExistingWorkspace = false,
): Conversation {
  if (hasConversation(id) || persistence.hasDeletedConversation(id)) {
    throw new Error(`Conversation ${id} already exists or is recoverable from trash`);
  }
  createConversationWorkspace(id, { adoptExisting: adoptExistingWorkspace });
  const parentId = folderId && folders.has(folderId) ? folderId : null;
  const conv = createConversation(id, provider, model, nextUnpinnedOrderInFolder(parentId), title, effort, fastMode, parentId);
  conv.messages.push(createStoredUserMessage(message.text, model, message.startedAt, message.images, {
    contextCheckpoint: createStoredUserContextCheckpoint(conv),
  }));
  retainConversation(conv);
  markDirty(id);
  flush(id);
  return conv;
}

export function setSubagentPolicy(id: string, policy: SubagentPolicy): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.subagentPolicy = {
    parentConversationId: policy.parentConversationId,
    allowEdits: policy.allowEdits === true,
    parentSystemInstructions: policy.parentSystemInstructions.trim(),
  };
  markDirty(id);
  flush(id);
  return true;
}

export function setToolPolicy(id: string, policy: ConversationToolPolicy | null): boolean {
  const conv = get(id);
  if (!conv) return false;
  conv.toolPolicy = policy ? {
    internal: [...new Set(policy.internal)],
    external: [...new Set(policy.external)],
    ...(policy.customToolModules?.length ? {
      customToolModules: policy.customToolModules.map((module) => ({
        ...module,
        tools: module.tools.map((tool) => ({ ...tool })),
      })),
    } : {}),
  } : null;
  if (!policy) {
    void clearConversationCustomTools(id).catch((error) => {
      log("warn", `conversations: failed to dispose custom tools for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  markDirty(id);
  flush(id);
  return true;
}

/** Bump an unpinned conversation to the top of the unpinned section. No-op for pinned conversations. */
export function bumpToTop(id: string): boolean {
  const conv = get(id);
  if (!conv || conv.pinned) return false;
  conv.sortOrder = nextUnpinnedOrderInFolder(conv.folderId ?? null, id);
  markDirty(id);
  // Keep the in-memory sidebar index in sync immediately. The conversation is
  // deliberately not flushed here (stream setup persists shortly after), but
  // later sidebar operations such as manual move up/down read from summaries.
  // Without this, the TUI can display the bumped summary while the daemon still
  // computes moves from the old order.
  updateSummaryFromConversation(conv);
  return true;
}

/** Clone a conversation: deep-copy with a new ID, placed right after the original in sort order. */
export function clone(id: string): Conversation | null {
  const src = get(id);
  if (!src) return null;

  let newId = generateId();
  while (hasConversation(newId) || persistence.hasDeletedConversation(newId)) newId = generateId();
  const now = Date.now();
  // Cloning copies transcript/configuration state, not potentially huge or
  // sensitive filesystem contents. Every clone starts with an empty workspace.
  createConversationWorkspace(newId);

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
    activeContext: src.activeContext
      ? { ...structuredClone(src.activeContext), windowId: `${newId}:${src.activeContext.windowNumber}` }
      : null,
    createdAt: now,
    updatedAt: now,
    lastContextTokens: src.lastContextTokens,
    marked: src.marked,
    pinned: src.pinned,
    muted: src.muted === true,
    sortOrder: newOrder,
    folderId: src.folderId ?? null,
    title: (src.title || "clone") + " 📋",
    toolPolicy: src.toolPolicy ? structuredClone(src.toolPolicy) : null,
  };
  if (src.activeContext && conv.activeContext) {
    for (const message of [...conv.messages, ...conv.activeContext.messages]) {
      if (message.contextCheckpoint?.windowId === src.activeContext.windowId) {
        message.contextCheckpoint.windowId = conv.activeContext.windowId;
      }
    }
  }

  retainConversation(conv);
  markDirty(newId);
  flush(newId);
  recordSidebarUndo({ type: "conversation_removed", id: newId });
  return conv;
}

export function get(id: string): Conversation | undefined {
  return loadConversation(id);
}

/** Check indexed existence without parsing and retaining the canonical transcript. */
export function hasConversation(id: string): boolean {
  return summaries.has(id) || conversations.has(id);
}

/** Check whether a soft-deleted conversation still reserves this ID for undo. */
export function hasDeletedConversation(id: string): boolean {
  return persistence.hasDeletedConversation(id);
}

export interface SetGoalOptions {
  pausable?: boolean;
  completable?: boolean;
}

export function setGoal(id: string, objective: string, options: SetGoalOptions = {}): ConversationGoal | null {
  const conv = get(id);
  const trimmed = objective.trim();
  if (!conv || !trimmed) return null;
  const now = Date.now();
  const completable = options.completable ?? true;
  const pausable = completable ? options.pausable ?? true : false;
  conv.goal = {
    objective: trimmed,
    status: "active",
    pausable,
    completable,
    createdAt: now,
    updatedAt: now,
    turns: 0,
  };
  markDirty(id);
  flush(id);
  return conv.goal;
}

export function updateGoalStatus(id: string, status: ConversationGoalStatus): ConversationGoal | null {
  const conv = get(id);
  if (!conv?.goal) return null;
  conv.goal.status = status;
  conv.goal.updatedAt = Date.now();
  markDirty(id);
  flush(id);
  return conv.goal;
}

export function clearGoal(id: string): boolean {
  const conv = get(id);
  if (!conv?.goal) return false;
  conv.goal = null;
  markDirty(id);
  flush(id);
  return true;
}

export function incrementGoalTurns(id: string): ConversationGoal | null {
  const conv = get(id);
  if (!conv?.goal) return null;
  conv.goal.turns += 1;
  conv.goal.updatedAt = Date.now();
  markDirty(id);
  flush(id);
  return conv.goal;
}

function removeConversationState(id: string): boolean {
  const existed = summaries.has(id) || conversations.has(id);
  if (!existed) return false;
  // Foreground tools are not yet in the detached-task registry. Abort the turn
  // before discarding its controller so their tool signal can terminate them.
  streaming.getActiveJob(id)?.abort();
  stopBackgroundTasksForConversation(id);
  notifyConversationRemoved(id);
  evictCachedConversation(id);
  renderSnapshotCache.delete(id);
  summaries.delete(id);
  dirty.delete(id);
  messageContentDirty.delete(id);
  contextAttributionDirty.delete(id);
  const wasUnread = unread.delete(id);
  streaming.clearActiveJob(id);
  streaming.resetChunkCounter(id);
  messageQueue.clearQueuedMessages(id);
  if (persistence.hasConversationUnwindReceipt(id)) {
    // Deletion can follow a recovered unwind whose prior queue write failed. Make
    // the current snapshot durable before removing its last tombstone receipt.
    messageQueue.persistQueuedMessagesSnapshot();
    persistence.removeConversationUnwindReceipt(id);
  }
  streaming.clearGoalContinuationAfterStream(id);
  streaming.clearHistoryUnwindPending(id);
  return wasUnread;
}

function stopConversationWorkspaceUsers(id: string): void {
  notifyConversationRemoving(id);
  streaming.getActiveJob(id)?.abort();
  stopBackgroundTasksForConversation(id);
}

function trashWorkspaceAfterConversation(id: string): void {
  try {
    trashConversationWorkspace(id);
  } catch (err) {
    // The durable conversation deletion already committed. Preserve data in its
    // live location rather than risking overwrite or destructive cleanup.
    log("error", `conversations: failed to trash workspace for ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Fold targeted overlays through the canonical live object before trashing. */
function materializeConversationOverlaysForTrash(id: string): void {
  if (!dirty.has(id)
      && !persistence.hasConversationSidebarState(id)
      && !persistence.hasConversationUnwindReceipt(id)) return;
  const conv = get(id);
  if (!conv) return;
  markDirty(id);
  flush(id);
}

export function removeMany(ids: string[], recordUndo = true): string[] {
  const seen = new Set<string>();
  const existing: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (streaming.isHistoryUnwindPending(id)) {
      log("warn", `conversations: refusing to delete ${id} while a history unwind is pending`);
      continue;
    }
    if (summaries.has(id) || conversations.has(id)) existing.push(id);
  }
  if (existing.length === 0) return [];

  for (const id of existing) materializeConversationOverlaysForTrash(id);
  const moved = persistence.trashConversations(existing, recordUndo);
  if (moved.length === 0) return [];

  for (const id of moved) stopConversationWorkspaceUsers(id);
  let unreadChanged = false;
  for (const id of moved) {
    trashWorkspaceAfterConversation(id);
    displayPageStore.removeDisplayProjection(id);
    unreadChanged = removeConversationState(id) || unreadChanged;
    void clearConversationCustomTools(id).catch((error) => {
      log("warn", `conversations: failed to dispose custom tools for deleted conversation ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  if (unreadChanged) saveUnreadState();
  saveSummaryIndex();
  return moved;
}

export function remove(id: string): boolean {
  return removeMany([id]).length > 0;
}

function deleteConversationWithoutUndo(id: string): boolean {
  if (streaming.isHistoryUnwindPending(id)) {
    log("warn", `conversations: refusing to delete ${id} while a history unwind is pending`);
    return false;
  }
  materializeConversationOverlaysForTrash(id);
  const moved = persistence.trashConversations([id], false).length > 0;
  if (!moved) return false;
  stopConversationWorkspaceUsers(id);
  trashWorkspaceAfterConversation(id);
  displayPageStore.removeDisplayProjection(id);
  const unreadChanged = removeConversationState(id);
  void clearConversationCustomTools(id).catch((error) => {
    log("warn", `conversations: failed to dispose custom tools for deleted conversation ${id}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (unreadChanged) saveUnreadState();
  saveSummaryIndex();
  return true;
}

export type UndoDeleteResult =
  | { type: "conversation"; conversation: Conversation }
  | { type: "conversations"; conversations: Conversation[] }
  | {
      type: "sidebar_state";
      deletedConvIds?: string[];
      updatedConvIds?: string[];
      folderInstructions?: { folderId: string; text: string }[];
    };

type SidebarUndoDirection = "undo" | "redo";

function pushOppositeSidebarEntry(direction: SidebarUndoDirection, entry: persistence.TrashStackEntry): void {
  try {
    if (direction === "undo") persistence.pushRedoEntry(entry);
    else persistence.pushUndoEntry(entry);
  } catch (err) {
    log("error", `conversations: failed to record sidebar ${direction === "undo" ? "redo" : "undo"} entry: ${err}`);
  }
}

function restoreConversationsFromTrash(conversationIds: string[]): Conversation[] {
  for (const id of conversationIds) {
    if (hasConversation(id)) {
      throw new ConversationWorkspaceRestoreError(
        `Refusing to overwrite existing live conversation: ${id}`,
      );
    }
    assertConversationWorkspaceRestorable(id);
  }

  let restored: Conversation[];
  try {
    restored = persistence.restoreConversationsFromTrash(conversationIds);
  } catch (err) {
    throw new ConversationWorkspaceRestoreError(`Conversation restore failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const conv of restored) {
    try {
      // Transcript state commits first. A crash before this rename is repaired by
      // ensureConversationWorkspace on first use, so the deleted data always
      // remains recoverable rather than being attached to a different transcript.
      restoreConversationWorkspace(conv.id);
    } catch (err) {
      log("error", `conversations: restored ${conv.id}, but its workspace remains recoverable in trash: ${err instanceof Error ? err.message : String(err)}`);
    }
    retainConversation(conv);
    updateSummaryFromConversation(conv);
    if (!persistence.isSqliteConversationStore()) scheduleDisplayIndex(conv.id);
  }
  if (restored.length > 0) saveSummaryIndex();
  return restored;
}

function sidebarStateWithDeleted(deletedConvIds: string[]): UndoDeleteResult | null {
  return deletedConvIds.length > 0 ? { type: "sidebar_state", deletedConvIds } : null;
}

function applySidebarStackEntry(entry: persistence.TrashStackEntry, direction: SidebarUndoDirection): UndoDeleteResult | null {
  if (entry.type === "conversation") {
    const restored = restoreConversationsFromTrash([entry.id]);
    if (restored.length === 0) return null;
    pushOppositeSidebarEntry(direction, { type: "conversation_removed", id: restored[0].id });
    log("info", `conversations: restored ${restored[0].id} from trash`);
    return { type: "conversation", conversation: restored[0] };
  }

  if (entry.type === "conversations") {
    const restored = restoreConversationsFromTrash(entry.ids);
    if (restored.length === 0) return null;
    const ids = restored.map(conv => conv.id);
    pushOppositeSidebarEntry(direction, { type: "conversations_removed", ids });
    log("info", `conversations: restored ${restored.length} conversations from trash`);
    return { type: "conversations", conversations: restored };
  }

  if (entry.type === "conversation_removed") {
    const deleted = deleteConversationWithoutUndo(entry.id);
    if (!deleted) return null;
    pushOppositeSidebarEntry(direction, { type: "conversation", id: entry.id });
    return { type: "sidebar_state", deletedConvIds: [entry.id] };
  }

  if (entry.type === "conversations_removed") {
    const deletedIds = removeMany(entry.ids, false);
    if (deletedIds.length === 0) return null;
    pushOppositeSidebarEntry(direction, deletedIds.length === 1 ? { type: "conversation", id: deletedIds[0] } : { type: "conversations", ids: deletedIds });
    return sidebarStateWithDeleted(deletedIds);
  }

  if (entry.type === "folder_recursive") {
    const restored = restoreConversationsFromTrash(entry.conversationIds);
    for (const folder of entry.folders) {
      folders.set(folder.id, { ...folder });
    }
    saveFolderState();
    saveSummaryIndex();
    pushOppositeSidebarEntry(direction, { type: "folder_recursive_removed", folderId: entry.folderId });
    log("info", `conversations: restored folder tree from trash (${entry.folders.length} folders, ${restored.length} conversations)`);
    return { type: "sidebar_state" };
  }

  if (entry.type === "folder_recursive_removed") {
    const folderIds = descendantFolderIdsIncluding(entry.folderId);
    const folderSnapshots = [...folders.values()]
      .filter(candidate => folderIds.has(candidate.id))
      .map(candidate => ({ ...candidate }));
    const conversationIds = [...summaries.values()]
      .filter(summary => summary.folderId && folderIds.has(summary.folderId))
      .map(summary => summary.id);
    if (folderSnapshots.length === 0 && conversationIds.length === 0) return null;
    if (!deleteFolder(entry.folderId, "recursive", false)) return null;
    pushOppositeSidebarEntry(direction, { type: "folder_recursive", folderId: entry.folderId, folders: folderSnapshots, conversationIds });
    return sidebarStateWithDeleted(conversationIds) ?? { type: "sidebar_state" };
  }

  if (entry.type === "folder_unwrap") {
    folders.set(entry.folder.id, { ...entry.folder });
    for (const child of entry.children) {
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
    pushOppositeSidebarEntry(direction, { type: "folder_unwrapped", folderId: entry.folder.id });
    log("info", `conversations: restored unwrapped folder ${entry.folder.id}`);
    return { type: "sidebar_state" };
  }

  if (entry.type === "folder_unwrapped") {
    const folder = folders.get(entry.folderId);
    if (!folder) return null;
    const undoEntry: persistence.TrashStackEntry = { type: "folder_unwrap", folder: { ...folder }, children: childSnapshots(entry.folderId) };
    if (!deleteFolder(entry.folderId, "unwrap", false)) return null;
    pushOppositeSidebarEntry(direction, undoEntry);
    return { type: "sidebar_state" };
  }

  if (entry.type === "sidebar_items") {
    const inverseItems = sidebarItemSnapshots(entry.items.map(snapshot => snapshot.item));
    if (!restoreSidebarItemSnapshots(entry.items)) return null;
    if (inverseItems.length > 0) pushOppositeSidebarEntry(direction, { type: "sidebar_items", items: inverseItems });
    return { type: "sidebar_state" };
  }

  if (entry.type === "folder_created") {
    restoreSidebarItemSnapshots(entry.movedItems);
    const folder = folders.get(entry.folder.id);
    if (folder) {
      const remainingChildren: SidebarItemRef[] = sidebarEntries(entry.folder.id).map(child => ({ type: child.type, id: child.id }));
      if (remainingChildren.length > 0) {
        moveSidebarItems(remainingChildren, entry.folder.parentId ?? null, { type: "folder", id: entry.folder.id }, {}, false);
      }
      folders.delete(entry.folder.id);
      if (folderInstructions.delete(entry.folder.id)) saveFolderInstructionsState();
      saveFolderState();
    }
    saveSummaryIndex();
    pushOppositeSidebarEntry(direction, { type: "folder_create", folder: entry.folder, items: entry.movedItems.map(snapshot => snapshot.item) });
    log("info", `conversations: removed created folder ${entry.folder.id}`);
    return { type: "sidebar_state", folderInstructions: [{ folderId: entry.folder.id, text: "" }] };
  }

  if (entry.type === "folder_create") {
    if (folders.has(entry.folder.id)) return null;
    const movedItems = sidebarItemSnapshots(entry.items);
    folders.set(entry.folder.id, { ...entry.folder });
    saveFolderState();
    if (entry.items.length > 0) moveSidebarItems(entry.items, entry.folder.id, undefined, {}, false);
    pushOppositeSidebarEntry(direction, { type: "folder_created", folder: entry.folder, movedItems });
    return { type: "sidebar_state" };
  }

  if (entry.type === "folder_renamed") {
    const folder = folders.get(entry.folderId);
    if (!folder) return null;
    const inverse = { type: "folder_renamed" as const, folderId: entry.folderId, previousName: folder.name, previousUpdatedAt: folder.updatedAt };
    folder.name = entry.previousName;
    folder.updatedAt = entry.previousUpdatedAt;
    saveFolderState();
    pushOppositeSidebarEntry(direction, inverse);
    return { type: "sidebar_state" };
  }

  if (entry.type === "conversation_marked") {
    const conv = get(entry.convId);
    if (!conv) return null;
    const inverse = { type: "conversation_marked" as const, convId: entry.convId, marked: conv.marked };
    conv.marked = entry.marked;
    markDirty(conv.id);
    flush(conv.id);
    pushOppositeSidebarEntry(direction, inverse);
    return { type: "sidebar_state", updatedConvIds: [conv.id] };
  }

  if (entry.type === "conversation_renamed") {
    const conv = get(entry.convId);
    if (!conv) return null;
    const inverse = { type: "conversation_renamed" as const, convId: entry.convId, title: conv.title };
    conv.title = entry.title;
    markDirty(conv.id);
    flush(conv.id);
    pushOppositeSidebarEntry(direction, inverse);
    return { type: "sidebar_state", updatedConvIds: [conv.id] };
  }

  if (entry.type === "conversation_cloned") {
    const deleted = deleteConversationWithoutUndo(entry.convId);
    if (!deleted) return null;
    pushOppositeSidebarEntry(direction, { type: "conversation", id: entry.convId });
    return { type: "sidebar_state", deletedConvIds: [entry.convId] };
  }

  if (entry.type === "folder_instructions") {
    const folder = folders.get(entry.folderId);
    if (!folder) return null;
    const current = folderInstructions.get(entry.folderId) ?? "";
    if (entry.text) folderInstructions.set(entry.folderId, entry.text);
    else folderInstructions.delete(entry.folderId);
    folder.updatedAt = Date.now();
    saveFolderInstructionsState();
    saveFolderState();
    pushOppositeSidebarEntry(direction, { type: "folder_instructions", folderId: entry.folderId, text: current });
    return { type: "sidebar_state", folderInstructions: [{ folderId: entry.folderId, text: entry.text }] };
  }

  return null;
}

/** Restore the most recent undoable sidebar operation, or null if the undo stack is empty. */
export function undoDelete(): UndoDeleteResult | null {
  let entry: persistence.TrashStackEntry | null = null;
  try {
    entry = persistence.popUndoEntry();
    return entry ? applySidebarStackEntry(entry, "undo") : null;
  } catch (err) {
    if (entry && err instanceof ConversationWorkspaceRestoreError) {
      try { persistence.pushUndoEntry(entry); } catch (restoreErr) {
        log("error", `conversations: failed to preserve blocked undo entry: ${restoreErr}`);
      }
    }
    log("error", `conversations: failed to undo sidebar entry: ${err}`);
    return null;
  }
}

/** Re-apply the most recently undone sidebar operation, or null if redo is empty. */
export function redoDelete(): UndoDeleteResult | null {
  let entry: persistence.TrashStackEntry | null = null;
  try {
    entry = persistence.popRedoEntry();
    return entry ? applySidebarStackEntry(entry, "redo") : null;
  } catch (err) {
    if (entry && err instanceof ConversationWorkspaceRestoreError) {
      try { persistence.pushRedoEntry(entry); } catch (restoreErr) {
        log("error", `conversations: failed to preserve blocked redo entry: ${restoreErr}`);
      }
    }
    log("error", `conversations: failed to redo sidebar entry: ${err}`);
    return null;
  }
}
export function setModel(
  id: string,
  provider: ProviderId,
  model: ModelId,
  effort: EffortLevel,
  fastMode: boolean,
): boolean {
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

export function rename(id: string, title: string, recordUndo = true): boolean {
  const conv = get(id);
  if (!conv) return false;
  if (conv.title === title) return true;
  if (recordUndo) recordSidebarUndo({ type: "conversation_renamed", convId: id, title: conv.title });
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
  markDirty(id, "messages");
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

export function getFolderInstructions(folderId: string): string | null {
  return folders.has(folderId) ? folderInstructions.get(folderId) ?? "" : null;
}

export function getEffectiveFolderInstructions(folderId: string): string | null {
  return folders.has(folderId) ? formatFolderInstructionsForDisplay(folderId) ?? "" : null;
}

export function setFolderInstructions(folderId: string, text: string): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;
  const normalized = text.trim();
  const current = folderInstructions.get(folderId) ?? "";
  if (normalized === current) return true;
  recordSidebarUndo({ type: "folder_instructions", folderId, text: current });
  if (normalized) folderInstructions.set(folderId, normalized);
  else folderInstructions.delete(folderId);
  folder.updatedAt = Date.now();
  saveFolderInstructionsState();
  saveFolderState();
  return true;
}

export function getEffectiveSystemInstructions(id: string): string | null {
  const conv = get(id);
  if (!conv) return null;
  const parts: string[] = [];
  const inheritedText = typeof conv.subagentPolicy?.parentSystemInstructions === "string"
    ? conv.subagentPolicy.parentSystemInstructions.trim()
    : "";
  if (inheritedText) parts.push(`Inherited parent instructions:\n${inheritedText}`);
  const folderText = formatFolderInstructionsForDisplay(conv.folderId ?? null);
  if (folderText) parts.push(folderText);
  const conversationText = getSystemInstructions(id)?.trim();
  if (conversationText) parts.push(`Conversation instructions:\n${conversationText}`);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Unwind a conversation to before the Nth user message (0-based).
 * Removes that user message and everything after it.
 * Also aborts any active stream and clears any queued messages.
 * Returns a promise that resolves when any active stream has stopped.
 */
export interface ConversationUnwindResult {
  status: "applied" | "already_applied";
  operationId: string;
  convId: string;
  userMessageIndex: number;
  historyTotalEntries: number;
  contextTokens: number | null;
  summary: ConversationSummary;
}

export class HistoryUnwindRefreshRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HistoryUnwindRefreshRequiredError";
  }
}

const inFlightUnwinds = new Map<string, {
  operationId: string;
  promise: Promise<ConversationUnwindResult | null>;
}>();

export function releaseHistoryUnwindLease(id: string, operationId: string): void {
  streaming.clearHistoryUnwindPending(id, operationId);
}

export function unwindTo(
  id: string,
  userMessageIndex: number,
  operationId = `unwind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  expectedStartedAt?: number,
  targetFingerprint?: string,
  deferLeaseRelease = false,
  onCommitted?: (result: ConversationUnwindResult) => void,
): Promise<ConversationUnwindResult | null> {
  const inFlight = inFlightUnwinds.get(id);
  if (inFlight) {
    if (inFlight.operationId !== operationId) return Promise.resolve(null);
    return inFlight.promise.then((result) => result ? { ...result, status: "already_applied" } : null);
  }

  const promise = performUnwindTo(
    id,
    userMessageIndex,
    operationId,
    expectedStartedAt,
    targetFingerprint,
    deferLeaseRelease,
    onCommitted,
  );
  inFlightUnwinds.set(id, { operationId, promise });
  const clear = () => {
    if (inFlightUnwinds.get(id)?.promise === promise) inFlightUnwinds.delete(id);
  };
  void promise.then(clear, clear);
  return promise;
}

async function performUnwindTo(
  id: string,
  userMessageIndex: number,
  operationId: string,
  expectedStartedAt: number | undefined,
  targetFingerprint: string | undefined,
  deferLeaseRelease: boolean,
  onCommitted: ((result: ConversationUnwindResult) => void) | undefined,
): Promise<ConversationUnwindResult | null> {
  const conv = get(id);
  if (!conv) return null;
  const receipt = persistence.getLastUnwindReceipt(conv);
  if (receipt?.operationId === operationId) {
    return {
      status: "already_applied",
      operationId,
      convId: id,
      userMessageIndex: receipt.userMessageIndex,
      historyTotalEntries: receipt.historyTotalEntries,
      contextTokens: conv.lastContextTokens,
      summary: getSummary(id)!,
    };
  }

  // Validate the index before doing anything destructive.
  // Only count real user messages — tool_result messages also have
  // role="user" but are invisible in the TUI (folded into AI entries).
  // Skip system_instructions (always at index 0) — they're never unwound.
  let spliceAt = -1;
  let userCount = 0;
  let historyCount = 0;
  let targetHistoryCount = -1;
  let targetContextCheckpoint: StoredUserContextCheckpoint | undefined;
  let targetMessage: StoredMessage | undefined;
  for (let i = 0; i < conv.messages.length; i++) {
    const message = conv.messages[i];
    if (message.role === "system_instructions") continue;
    if (isRealUserMessage(message)) {
      if (userCount === userMessageIndex) {
        spliceAt = i;
        targetHistoryCount = historyCount;
        targetContextCheckpoint = message.contextCheckpoint;
        targetMessage = message;
        break;
      }
      userCount++;
    }
    if (isReplayHistoryMessage(message)) historyCount++;
  }
  if (spliceAt === -1 || !targetMessage) return null;
  if (expectedStartedAt !== undefined && targetMessage.metadata?.startedAt !== expectedStartedAt) {
    log("warn", `conversations: refusing unwind with stale target identity for ${id} at user index ${userMessageIndex}`);
    return null;
  }
  const targetFingerprintMatches = (): boolean => targetFingerprint === undefined
    || (displayPageStore.isPagedUserFingerprint(targetFingerprint)
      ? displayPageStore.pagedUserFingerprint(id, userMessageIndex, targetMessage!) === targetFingerprint
      : historyPrefixHash(conv.messages, targetHistoryCount + 1) === targetFingerprint);
  if (!targetFingerprintMatches()) {
    log("warn", `conversations: refusing unwind with stale target fingerprint for ${id} at user index ${userMessageIndex}`);
    return null;
  }

  // A compaction item is irreversible: only the one-to-one transcript tail
  // written after its fixed boundary can be edited. Enforce this in the daemon
  // as well as the TUI so stale/third-party clients cannot destroy the checkpoint.
  if (conv.activeContext) {
    const compactionHistoryCount = validatedActiveContextCompactionHistoryCount(conv.activeContext, conv.messages);
    if (compactionHistoryCount == null || targetHistoryCount < compactionHistoryCount) {
      log("warn", `conversations: refusing unwind before active compaction boundary for ${id} (target=${targetHistoryCount}, boundary=${compactionHistoryCount ?? "unknown"})`);
      return null;
    }
  } else if (conv.messages.some((message) => message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND)) {
    // A divider without its derived replay means the checkpoint was discarded or
    // corrupted. There is no safe generation to rewind, so freeze sent history
    // until a later successful compaction establishes a new one.
    log("warn", `conversations: refusing unwind for ${id}; transcript has a compaction boundary but no active checkpoint`);
    return null;
  }

  // Aborting below can race with a successful compaction install or discard.
  // Remember whether a checkpoint existed so a disappearing replay base causes
  // a non-destructive refusal rather than a fallback to the full transcript.
  const hadActiveContextBeforeAbort = conv.activeContext != null;
  const ac = streaming.getActiveJob(id) ?? null;
  if (!streaming.requestHistoryUnwind(id, operationId, ac)) return null;

  // Gate delivery without removing durable entries. If the process crashes
  // during the abort wait, suspension disappears on restart and the queue is
  // still intact; a successful unwind explicitly clears it below.
  messageQueue.suspendQueuedMessageDelivery(id);
  const goalContinuationBeforeAbort = streaming.consumeGoalContinuationAfterStream(id);
  let committed = false;
  let stoppedAbortedStream = false;
  try {
    // Abort any active stream and wait for that exact job to release the turn.
    if (ac) {
      ac.abort();
      const stopped = await waitForStreamStop(id);
      if (!stopped) {
        log("warn", `conversations: stream for ${id} did not stop within timeout; refusing unsafe unwind`);
        return null;
      }
      stoppedAbortedStream = true;
    }

    // A compaction or another destructive mutation can win the race with abort.
    // Revalidate both the immutable boundary and the exact target object before
    // committing a durable cut.
    const postAbortCompactionHistoryCount = conv.activeContext
      ? validatedActiveContextCompactionHistoryCount(conv.activeContext, conv.messages)
      : null;
    const lostCheckpointDuringAbort = hadActiveContextBeforeAbort && conv.activeContext == null;
    if (conversations.get(id) !== conv
        || lostCheckpointDuringAbort
        || conv.messages[spliceAt] !== targetMessage
        || !targetFingerprintMatches()
        || (conv.activeContext != null
          && (postAbortCompactionHistoryCount == null || targetHistoryCount < postAbortCompactionHistoryCount))) {
      throw new Error(
        `Conversation state changed while unwinding ${id} `
        + `(target=${targetHistoryCount}, boundary=${postAbortCompactionHistoryCount ?? "missing"})`,
      );
    }

    // Build an immutable result first. The sidecar rename below is the operation's
    // linearization point; live history and queue state remain untouched until it
    // succeeds.
    const plannedMessages = conv.messages.slice(0, spliceAt);
    const targetCheckpointPrefixHash = trustedUserCheckpointPrefixHash(
      conv,
      targetMessage,
      targetContextCheckpoint,
      targetHistoryCount,
      conv.activeContext?.windowId ?? null,
    );
    const recoveredActiveContext = conv.activeContext
      ? (postAbortCompactionHistoryCount != null
        && targetHistoryCount >= conv.activeContext.transcriptHistoryCount
        // The cut removes only canonical history that this compact replay has
        // never represented, so its already-validated cursor is unchanged.
        ? conv.activeContext
        : (postAbortCompactionHistoryCount != null && targetCheckpointPrefixHash
          ? rewindValidatedActiveContextToHistoryCount(
            conv.activeContext,
            targetHistoryCount,
            postAbortCompactionHistoryCount,
            targetCheckpointPrefixHash,
          )
          : rewindActiveContextToHistoryCount(conv.activeContext, plannedMessages, targetHistoryCount)))
      : null;
    const plannedConversation: Conversation = {
      ...conv,
      messages: plannedMessages,
      activeContext: recoveredActiveContext,
      updatedAt: Date.now(),
    };
    plannedConversation.lastContextTokens = contextTokensAtUserCheckpoint(
      plannedConversation,
      targetContextCheckpoint,
      targetHistoryCount,
      recoveredActiveContext?.windowId ?? null,
      targetCheckpointPrefixHash,
    ) ?? estimateRewoundReplayTokens(conv, plannedConversation, spliceAt);
    const historyTotalEntries = persistence.displayEntryCountBeforeUser(id, userMessageIndex)
      ?? buildSnapshotDisplayData(
        plannedConversation,
        plannedMessages,
        false,
        true,
        undefined,
        false,
      ).entries.filter((entry) => entry.type !== "system_instructions").length;
    const plannedSummary = summarizeConversation(plannedConversation);
    const supersededQueueIds = messageQueue.listInternalQueuedMessages()
      .filter((entry) => entry.convId === id)
      .map((entry) => entry.id);

    if (dirty.has(id) && !contextAttributionDirty.has(id)) {
      throw new Error(`Cannot persist targeted unwind for ${id} with unrelated dirty state`);
    }
    persistence.saveUnwind(conv, plannedConversation, targetHistoryCount, {
      operationId,
      userMessageIndex,
      historyTotalEntries,
      messageCount: plannedSummary.messageCount,
      supersededQueueIds,
    });
    if (!persistence.isSqliteConversationStore()) scheduleDisplayIndex(id);
    committed = true;

    conv.messages.splice(spliceAt);
    conv.activeContext = recoveredActiveContext;
    if (recoveredActiveContext) rememberValidatedActiveContext(recoveredActiveContext, conv.messages);
    conv.lastContextTokens = plannedConversation.lastContextTokens;
    conv.updatedAt = plannedConversation.updatedAt;
    renderSnapshotCache.delete(id);
    dirty.delete(id);
    messageContentDirty.delete(id);
    contextAttributionDirty.delete(id);
    updateSummaryFromConversation(conv);
    try {
      const removedQueueEntries = messageQueue.removeQueuedMessagesById(supersededQueueIds);
      // A prior queue write may have failed after its in-memory entry was removed.
      // Even when this cut sees no such entry, durably rewrite the canonical queue
      // before acknowledging the inherited tombstone union.
      if (removedQueueEntries === 0) messageQueue.persistQueuedMessagesSnapshot();
      persistence.acknowledgeUnwindQueueCleanup(id, operationId);
    } catch (err) {
      // The committed sidecar carries these exact tombstones, so restart recovery
      // will finish the queue cleanup without deleting later queue entries.
      log("error", `conversations: failed to persist queue cleanup after unwind ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    streaming.clearGoalContinuationAfterStream(id);
    const result: ConversationUnwindResult = {
      status: "applied",
      operationId,
      convId: id,
      userMessageIndex,
      historyTotalEntries,
      contextTokens: conv.lastContextTokens,
      summary: getSummary(id)!,
    };
    // Publish synchronously while this operation still owns the mutation lease.
    // No other command can observe the committed cut and then race a stale event.
    onCommitted?.(result);
    return result;
  } catch (err) {
    if (stoppedAbortedStream && !committed) {
      throw new HistoryUnwindRefreshRequiredError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
    throw err;
  } finally {
    messageQueue.resumeQueuedMessageDelivery(id);
    if (!deferLeaseRelease || (!committed && !stoppedAbortedStream)) {
      streaming.clearHistoryUnwindPending(id, operationId);
    }
    if (!committed) {
      const goalContinuationDuringWait = streaming.consumeGoalContinuationAfterStream(id);
      if (goalContinuationBeforeAbort || goalContinuationDuringWait) {
        streaming.requestGoalContinuationAfterStream(id);
      }
      // A pending unwind makes the exact aborted stream skip its obsolete final
      // save. If the cut did not commit, restore that interrupted state now.
      if (ac && conversations.get(id) === conv && streaming.getActiveJob(id) !== ac) {
        markDirty(id);
        flush(id);
      }
    }
  }
}

function contextTokensAtUserCheckpoint(
  conv: Conversation,
  checkpoint: StoredUserContextCheckpoint | undefined,
  targetHistoryCount: number,
  windowId: string | null,
  trustedPrefixHash: string | null = null,
): number | null {
  if (!checkpoint
      || checkpoint.version !== 1
      || checkpoint.provider !== conv.provider
      || checkpoint.model !== conv.model
      || checkpoint.windowId !== windowId
      || checkpoint.transcriptHistoryCount !== targetHistoryCount
      || checkpoint.contextTokens == null
      || !Number.isFinite(checkpoint.contextTokens)
      || checkpoint.contextTokens < 0
      // Avoid serializing a large prefix when this legacy checkpoint has no
      // usable token value anyway.
      || checkpoint.transcriptPrefixHash !== (trustedPrefixHash ?? historyPrefixHash(conv.messages, targetHistoryCount))) return null;
  return checkpoint.contextTokens;
}

/**
 * A user checkpoint is written atomically with the canonical message and is
 * immutable under the generation/target-identity checks above. Prefer its
 * already-computed rolling prefix hash when it either matches the value captured
 * during full active-context validation or lies in the canonical append-only
 * tail beyond that validated cursor. Malformed, stale, and legacy checkpoints
 * inside represented history fall back to full hashing.
 */
function trustedUserCheckpointPrefixHash(
  conv: Conversation,
  targetMessage: StoredMessage,
  checkpoint: StoredUserContextCheckpoint | undefined,
  targetHistoryCount: number,
  windowId: string | null,
): string | null {
  if (!checkpoint
      || checkpoint.version !== 1
      || checkpoint.provider !== conv.provider
      || checkpoint.model !== conv.model
      || checkpoint.windowId !== windowId
      || checkpoint.transcriptHistoryCount !== targetHistoryCount
      || !/^[0-9a-f]{24}$/.test(checkpoint.transcriptPrefixHash)) return null;
  const active = conv.activeContext;
  if (!active) return null;
  // Active-context validation proves the immutable prefix through this cursor.
  // Later canonical messages and their checkpoints are append-only, and the
  // target object/generation is checked again after abort immediately before
  // commit. Trust that persisted checkpoint without serializing the whole tail.
  if (targetHistoryCount > active.transcriptHistoryCount) return checkpoint.transcriptPrefixHash;
  const validatedHash = targetHistoryCount === active.transcriptHistoryCount
    ? active.transcriptPrefixHash
    : cachedValidatedHistoryPrefixHashBeforeMessage(active, conv.messages, targetMessage);
  return validatedHash === checkpoint.transcriptPrefixHash ? validatedHash : null;
}

/** Best-effort statusline value when an older user turn has no stored token snapshot. */
function estimateRewoundReplayTokens(
  base: Conversation,
  planned: Conversation,
  spliceAt: number,
): number {
  // When the compact replay cursor is unchanged, the current provider total is
  // already a calibrated estimate of the same replay plus the removed canonical
  // suffix. Subtract only that suffix instead of walking large retained tool and
  // image payloads. Exact provider usage on the replacement turn supersedes this
  // best-effort statusline value.
  if (planned.activeContext && planned.activeContext === base.activeContext
      && base.lastContextTokens != null && Number.isFinite(base.lastContextTokens)) {
    const removedChars = base.messages.slice(spliceAt)
      .filter(isReplayHistoryMessage)
      .reduce((sum, message) => sum + contextMessageChars(message, base.provider), 0);
    return Math.max(0, Math.round(base.lastContextTokens) - Math.ceil(removedChars / 4));
  }
  return estimateCurrentReplayTokens(planned);
}

/** Full replay estimate for legacy/malformed checkpoints and changed compact cursors. */
function estimateCurrentReplayTokens(conv: Conversation): number {
  const history = conv.messages.filter(isReplayHistoryMessage);
  const replay = conv.activeContext && isValidActiveContextCached(conv.activeContext, conv.messages)
    ? [
        ...conv.activeContext.messages.map((message) => ({
          role: message.role,
          content: message.content,
          metadata: message.metadata ?? null,
          providerData: message.providerData,
        })),
        ...history.slice(conv.activeContext.transcriptHistoryCount).map((message) => ({
          role: message.role as "user" | "assistant",
          content: message.content,
          metadata: message.metadata ?? null,
          providerData: message.providerData,
        })),
      ]
    : history;
  const chars = replay.reduce((sum, message) => sum + contextMessageChars(message, conv.provider), 0);
  return Math.max(0, Math.ceil(chars / 4));
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
  renderSnapshotCache.clear();
  summaries.clear();
  folders.clear();
  folderInstructions.clear();
  for (const folder of persistence.loadFolders()) {
    folders.set(folder.id, { ...folder, parentId: folder.parentId && folder.parentId !== folder.id ? folder.parentId : null });
  }
  for (const [folderId, text] of persistence.loadFolderInstructions()) {
    if (folders.has(folderId)) folderInstructions.set(folderId, text);
  }

  let normalizedEffortCount = 0;
  let normalizedGoalCount = 0;
  for (const summary of index.summaries) {
    if (!getProvider(summary.provider)) {
      summary.provider = DEFAULT_PROVIDER_ID;
      summary.model = DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID];
      normalizedEffortCount++;
    }
    const normalizedEffort = normalizeEffort(summary.provider, summary.model, summary.effort);
    if (normalizedEffort !== summary.effort) {
      summary.effort = normalizedEffort;
      normalizedEffortCount++;
    }
    if (summary.goal?.status === "complete") {
      summary.goal = null;
      normalizedGoalCount++;
    }
    summary.folderId = summary.folderId && folders.has(summary.folderId) ? summary.folderId : null;
    summaries.set(summary.id, summary);
  }

  const workspaceRepair = reconcileConversationWorkspaces(summaries.keys());
  if (workspaceRepair.movedToTrash.length > 0) {
    log("warn", `conversations: moved ${workspaceRepair.movedToTrash.length} orphaned live workspace(s) to trash after startup reconciliation`);
  }
  for (const failure of workspaceRepair.errors) {
    log("error", `conversations: failed to reconcile workspace ${failure.conversationId}: ${failure.error}`);
  }

  unread.clear();
  let staleUnreadCount = 0;
  for (const id of persistence.loadUnreadConversationIds()) {
    if (summaries.has(id) && !areConversationNotificationsMuted(id)) unread.add(id);
    else staleUnreadCount++;
  }
  if (staleUnreadCount > 0) saveUnreadState();

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
  if (fixed > 0 || normalizedEffortCount > 0 || normalizedGoalCount > 0 || index.saved) {
    log("info", `conversations: repaired index (deduplicated=${fixed}, normalizedEffort=${normalizedEffortCount}, normalizedGoals=${normalizedGoalCount})`);
    if (dirty.size > 0) flushAll();
    else saveSummaryIndex();
  }
  pruneConversationCache();

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
export function markDirty(id: string, mode: "auto" | "messages" = "auto"): void {
  renderSnapshotCache.delete(id);
  contextAttributionDirty.delete(id);
  if (mode === "messages") messageContentDirty.add(id);
  dirty.add(id);
}

/** Mark only provider-derived token attribution as dirty. */
export function markContextAttributionDirty(id: string): void {
  renderSnapshotCache.delete(id);
  dirty.add(id);
  messageContentDirty.delete(id);
  contextAttributionDirty.add(id);
}

/** Flush a dirty conversation to disk. */
export function flush(id: string, options: { summaryIndex?: SummaryIndexFlushMode } = {}): void {
  if (!dirty.has(id)) return;
  const conv = conversations.get(id);
  if (!conv) return;
  persistence.save(conv, {
    forceMessages: messageContentDirty.has(id),
    contextAttributionOnly: contextAttributionDirty.has(id),
  });
  if (!persistence.isSqliteConversationStore()) scheduleDisplayIndex(id);
  dirty.delete(id);
  messageContentDirty.delete(id);
  contextAttributionDirty.delete(id);
  setCachedFileSize(id, cachedFileSize(id));
  updateSummaryFromConversation(conv);
  saveSummaryIndex(options.summaryIndex ?? "immediate");
  pruneConversationCache(id);
}

/** Flush all dirty conversations. */
export function flushAll(): void {
  clearSummaryIndexSaveTimer();
  for (const id of dirty) {
    const conv = conversations.get(id);
    if (!conv) continue;
    persistence.save(conv, {
      forceMessages: messageContentDirty.has(id),
      contextAttributionOnly: contextAttributionDirty.has(id),
    });
    if (!persistence.isSqliteConversationStore()) scheduleDisplayIndex(id);
    setCachedFileSize(id, cachedFileSize(id));
    updateSummaryFromConversation(conv);
  }
  dirty.clear();
  messageContentDirty.clear();
  contextAttributionDirty.clear();
  summaryIndexDirty = false;
  saveSummaryIndexNow();
  pruneConversationCache();
}

/** Explicit test hooks for deterministic cache-pressure coverage. */
export const conversationCacheInternalsForTest = {
  snapshot(): { ids: string[]; entries: number; fileBytes: number } {
    return {
      ids: [...conversationCacheLru.keys()],
      entries: conversations.size,
      fileBytes: conversationCacheTotalFileBytes,
    };
  },
  setLimits(limits: { maxEntries: number; maxFileBytes: number }): void {
    conversationCacheMaxEntries = Math.max(0, Math.floor(limits.maxEntries));
    conversationCacheMaxFileBytes = Math.max(0, Math.floor(limits.maxFileBytes));
    pruneConversationCache();
  },
  resetLimits(): void {
    conversationCacheMaxEntries = DEFAULT_CONVERSATION_CACHE_MAX_ENTRIES;
    conversationCacheMaxFileBytes = DEFAULT_CONVERSATION_CACHE_MAX_FILE_BYTES;
    pruneConversationCache();
  },
  evictClean(): void {
    for (const id of [...conversationCacheLru.keys()]) {
      if (canEvictCachedConversation(id)) evictCachedConversation(id);
    }
  },
};

/** Track chunk count for throttled activity updates. Live blocks remain in streaming state. */
export function onChunk(id: string): boolean {
  return streaming.onChunk(id);
}

// ── Sidebar/listing state ───────────────────────────────────────────

/** Get conversation summaries for the sidebar (from in-memory state). */
export function listSummaries(): ConversationSummary[] {
  const result: ConversationSummary[] = [];
  for (const summary of summaries.values()) {
    const notificationsMuted = areConversationNotificationsMuted(summary.id);
    result.push({
      ...summary,
      streaming: streaming.isStreaming(summary.id),
      ...(streaming.isStreaming(summary.id) && !streaming.isRestartRecoverableJob(summary.id) ? { restartRecoverable: false } : {}),
      unread: !notificationsMuted && unread.has(summary.id),
      ...(notificationsMuted ? { notificationsMuted: true } : {}),
      ...getConversationActivityCounts(summary.id),
      tasks: getConversationTasks(summary.id),
      integrations: getConversationExternalIntegrations(summary.id),
    });
  }
  sortSidebarEntries(result);
  return result;
}

export function listFolders(): FolderSummary[] {
  return sortSidebarEntries([...folders.values()].map(folder => ({
    ...folder,
    effectiveInstructions: formatFolderInstructionsForDisplay(folder.id) ?? "",
  })));
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

/** Active model turns that should be replayed after a daemon restart. */
export function listRestartRecoverableConversationIds(): string[] {
  return listSummaries()
    .filter((summary) => summary.streaming && summary.restartRecoverable !== false)
    .map((summary) => summary.id);
}

// ── Conversation sidebar actions ───────────────────────────────────

/** Toggle or set the marked flag on a conversation. */
export function mark(id: string, marked: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  if (conv.marked === marked) return true;
  recordSidebarUndo({ type: "conversation_marked", convId: id, marked: conv.marked });
  conv.marked = marked;
  markDirty(id);
  flush(id);
  return true;
}

/** Toggle or set the pinned flag on a conversation. */
export function pin(id: string, pinned: boolean): boolean {
  const summary = summaries.get(id);
  if (!summary) return false;
  if (summary.pinned === pinned) return true;
  const snapshot = sidebarItemSnapshot({ type: "conversation", id });
  if (snapshot) recordSidebarUndo({ type: "sidebar_items", items: [snapshot] });
  setConversationSidebarState(id, {
    folderId: summary.folderId ?? null,
    pinned,
    sortOrder: pinned
      ? nextPinnedOrderInFolder(summary.folderId ?? null, id)
      : nextUnpinnedOrderInFolder(summary.folderId ?? null, id),
  });
  persistConversationSidebarStates([id]);
  return true;
}

/** Explicitly mute or unmute a conversation. Folder muting still takes precedence. */
export function mute(id: string, muted: boolean): boolean {
  const conv = get(id);
  if (!conv) return false;
  if (conv.muted === muted) return true;
  conv.muted = muted;
  markDirty(id);
  flush(id);
  if (muted) clearUnread(id);
  return true;
}

/** Move a conversation up or down within its folder section (pinned or unpinned). */
export function move(id: string, direction: "up" | "down"): boolean {
  return moveSidebarItem({ type: "conversation", id }, direction);
}

// ── Folder operations ───────────────────────────────────────────────

export function findTopLevelFolderByName(name: string): FolderSummary | null {
  const target = name.trim().toLocaleLowerCase();
  if (!target) return null;
  const folder = sortSidebarEntries([...folders.values()])
    .find(candidate => (candidate.parentId ?? null) === null && candidate.name.trim().toLocaleLowerCase() === target);
  return folder ? { ...folder } : null;
}

export function ensureTopLevelFolder(name: string, options: { mutedOnCreate?: boolean } = {}): FolderSummary | null {
  return findTopLevelFolderByName(name) ?? createFolder(name, null, [], false, options.mutedOnCreate === true);
}

export function moveConversationToFolder(id: string, folderId: string | null): boolean {
  const summary = summaries.get(id);
  if (!summary) return false;
  const parentId = folderId && folders.has(folderId) ? folderId : null;
  if ((summary.folderId ?? null) === parentId) return true;
  return moveSidebarItems([{ type: "conversation", id }], parentId, undefined, { placement: "bottom" });
}

export function createFolder(
  name: string,
  parentId: string | null = null,
  items: SidebarItemRef[] = [],
  recordUndo = true,
  muted = false,
): FolderSummary | null {
  const cleanName = name.trim();
  if (!cleanName) return null;
  const safeParent = parentId && folders.has(parentId) ? parentId : null;
  const now = Date.now();
  const movedItemSnapshots = sidebarItemSnapshots(items);
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
    muted,
    sortOrder: selectedOrders.length > 0
      ? Math.min(...selectedOrders)
      : pinned ? nextPinnedOrderInFolder(safeParent) : nextUnpinnedOrderInFolder(safeParent),
  };
  folders.set(folder.id, folder);
  saveFolderState();
  if (recordUndo) recordSidebarUndo({ type: "folder_created", folder: { ...folder }, movedItems: movedItemSnapshots });
  if (items.length > 0) moveSidebarItems(items, folder.id, undefined, {}, false);
  return { ...folder };
}

export function renameFolder(folderId: string, name: string): boolean {
  const folder = folders.get(folderId);
  const cleanName = name.trim();
  if (!folder || !cleanName) return false;
  if (folder.name === cleanName) return true;
  recordSidebarUndo({ type: "folder_renamed", folderId, previousName: folder.name, previousUpdatedAt: folder.updatedAt });
  folder.name = cleanName;
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

export function pinFolder(folderId: string, pinned: boolean): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;
  if (folder.pinned === pinned) return true;
  const snapshot = sidebarItemSnapshot({ type: "folder", id: folderId });
  if (snapshot) recordSidebarUndo({ type: "sidebar_items", items: [snapshot] });
  folder.pinned = pinned;
  folder.sortOrder = pinned
    ? nextPinnedOrderInFolder(folder.parentId ?? null, folder.id)
    : nextUnpinnedOrderInFolder(folder.parentId ?? null, folder.id);
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

/** Explicitly mute or unmute a folder and its complete descendant tree. */
export function muteFolder(folderId: string, muted: boolean): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;
  if (folder.muted === muted) return true;
  folder.muted = muted;
  folder.updatedAt = Date.now();
  saveFolderState();
  return true;
}

export function pinSidebarItems(pins: { item: SidebarItemRef; pinned: boolean }[]): boolean {
  const mutations: { item: SidebarItemRef; pinned: boolean }[] = [];
  for (const pin of pins) {
    const current = getItemPinned(pin.item);
    if (current === undefined || current === pin.pinned) continue;
    mutations.push(pin);
  }
  if (mutations.length === 0) return false;

  const snapshots = sidebarItemSnapshots(mutations.map(pin => pin.item));
  if (snapshots.length > 0) recordSidebarUndo({ type: "sidebar_items", items: snapshots });

  let conversationChanged = false;
  let folderChanged = false;
  const changedConversationIds: string[] = [];
  for (const mutation of mutations) {
    if (mutation.item.type === "conversation") {
      const summary = summaries.get(mutation.item.id);
      if (!summary) continue;
      setConversationSidebarState(mutation.item.id, {
        folderId: summary.folderId ?? null,
        pinned: mutation.pinned,
        sortOrder: mutation.pinned
          ? nextPinnedOrderInFolder(summary.folderId ?? null, summary.id)
          : nextUnpinnedOrderInFolder(summary.folderId ?? null, summary.id),
      });
      changedConversationIds.push(mutation.item.id);
      conversationChanged = true;
    } else {
      const folder = folders.get(mutation.item.id);
      if (!folder) continue;
      folder.pinned = mutation.pinned;
      folder.sortOrder = mutation.pinned
        ? nextPinnedOrderInFolder(folder.parentId ?? null, folder.id)
        : nextUnpinnedOrderInFolder(folder.parentId ?? null, folder.id);
      folder.updatedAt = Date.now();
      folderChanged = true;
    }
  }

  if (folderChanged) saveFolderState();
  if (conversationChanged) persistConversationSidebarStates(changedConversationIds);
  return conversationChanged || folderChanged;
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
  const snapshots = sidebarItemSnapshots([item, targetRef]);
  if (snapshots.length > 0) recordSidebarUndo({ type: "sidebar_items", items: snapshots });
  setItemSortOrder(item, targetOrder);
  setItemSortOrder(targetRef, currentOrder);

  if (targetOrder === currentOrder) {
    setItemSortOrder(item, currentOrder + (direction === "up" ? -0.5 : 0.5));
  }
  const changedItems = [item, targetRef];
  persistConversationSidebarStates(changedItems.filter(candidate => candidate.type === "conversation").map(candidate => candidate.id));
  if (changedItems.some(candidate => candidate.type === "folder")) saveFolderState();
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
  recordUndo = true,
): boolean {
  const safeParent = parentId && folders.has(parentId) ? parentId : null;
  let moved = false;
  let folderChanged = false;
  const changedConversationIds: string[] = [];
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
  const undoSnapshots = recordUndo ? sidebarItemSnapshots(movableItems) : [];

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
  if (recordUndo && undoSnapshots.length > 0) recordSidebarUndo({ type: "sidebar_items", items: undoSnapshots });
  for (const item of movableItems) {
    order += step;
    const pinned = options.preservePinned ? getItemPinned(item) ?? false : false;
    if (item.type === "conversation") {
      if (!setConversationSidebarState(item.id, { folderId: safeParent, pinned, sortOrder: order })) continue;
      changedConversationIds.push(item.id);
      moved = true;
    } else {
      const folder = folders.get(item.id);
      if (!folder) continue;
      folder.parentId = safeParent;
      folder.pinned = pinned;
      folder.sortOrder = order;
      folder.updatedAt = Date.now();
      folderChanged = true;
      moved = true;
    }
  }
  if (changedConversationIds.length > 0) persistConversationSidebarStates(changedConversationIds);
  if (folderChanged) saveFolderState();
  return moved;
}

export function deleteFolder(folderId: string, mode: "recursive" | "unwrap" = "recursive", recordUndo = true): boolean {
  const folder = folders.get(folderId);
  if (!folder) return false;

  if (mode === "unwrap") {
    const parentId = folder.parentId ?? null;
    const children: SidebarItemRef[] = sidebarEntries(folderId).map(entry => ({ type: entry.type, id: entry.id }));
    if (recordUndo) {
      try {
        persistence.pushTrashEntry({ type: "folder_unwrap", folder: { ...folder }, children: childSnapshots(folderId) });
      } catch (err) {
        log("error", `conversations: failed to record undo entry before unwrapping folder ${folderId}: ${err}`);
        return false;
      }
    }

    // Unwrap children into the exact slot occupied by the folder before deleting
    // the folder record. Moving while the folder still exists lets moveSidebarItems
    // use it as a stable insertion anchor; deleting first would dump children at the
    // top of the parent and make the TUI cursor appear to flicker/jump.
    if (children.length > 0) moveSidebarItems(children, parentId, { type: "folder", id: folderId }, {}, false);
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

  if (conversationIds.some((convId) => streaming.isHistoryUnwindPending(convId))) {
    log("warn", `conversations: refusing to delete folder ${folderId} while a history unwind is pending`);
    return false;
  }

  for (const convId of conversationIds) materializeConversationOverlaysForTrash(convId);
  if (!persistence.trashFolderRecursive({ type: "folder_recursive", folderId, folders: folderSnapshots, conversationIds }, recordUndo)) {
    return false;
  }
  for (const convId of conversationIds) stopConversationWorkspaceUsers(convId);
  for (const convId of conversationIds) trashWorkspaceAfterConversation(convId);
  for (const convId of conversationIds) displayPageStore.removeDisplayProjection(convId);

  let unreadChanged = false;
  for (const convId of conversationIds) {
    unreadChanged = removeConversationState(convId) || unreadChanged;
  }
  for (const id of folderIds) folders.delete(id);
  saveFolderState();
  if (unreadChanged) saveUnreadState();
  saveSummaryIndex();
  return true;
}

// ── Conversation summaries ─────────────────────────────────────────

/** Get a single conversation's summary. */
export function getSummary(id: string): ConversationSummary | null {
  const loaded = conversations.get(id);
  const summary = loaded ? summarizeConversation(loaded) : summaries.get(id);
  if (!summary) return null;
  const notificationsMuted = areConversationNotificationsMuted(id);
  return {
    ...summary,
    streaming: streaming.isStreaming(id),
    ...(streaming.isStreaming(id) && !streaming.isRestartRecoverableJob(id) ? { restartRecoverable: false } : {}),
    unread: !notificationsMuted && unread.has(id),
    ...(notificationsMuted ? { notificationsMuted: true } : {}),
    ...getConversationActivityCounts(id),
    tasks: getConversationTasks(id),
    integrations: getConversationExternalIntegrations(id),
  };
}

/**
 * Resolve the focused conversation's tool policy without forcing SQLite to load
 * its transcript. This projection is sent on conversation open and refreshed
 * whenever a policy mutation is broadcast.
 */
export function getToolPolicySnapshot(id: string): ToolPolicySnapshot | null {
  const policyState = conversations.get(id) ?? persistence.loadToolPolicyState(id);
  return policyState ? buildToolPolicySnapshot(policyState) : null;
}

/** Read durable/indexed metadata without loading or rescanning a full transcript. */
export function getIndexedSummary(id: string): PersistedConversationSummary | null {
  const summary = summaries.get(id);
  if (summary) return { ...summary };
  const loaded = conversations.get(id);
  return loaded ? summarizeConversation(loaded) : null;
}

// ── Display data ───────────────────────────────────────────────────

export type { ConversationDisplayData, DisplayEntry } from "./display";

export interface ConversationRenderSnapshot extends ConversationDisplayData {
  pendingAI?: {
    blocks: Block[];
    metadata: MessageMetadata | null;
    /** Blocks from this active turn already represented by entries. */
    blockOffset: number;
  };
}

/** Optional phase timings for diagnosing slow conversation opens/history loads. */
export interface RenderSnapshotDiagnostics {
  conversationCacheHit: boolean;
  snapshotCacheHit: boolean;
  /** Compact page projection hit; false means this request built the index. */
  displayPageHit?: boolean;
  /** Time spent reading compact manifest/chunk files. */
  displayPageReadMs?: number;
  /** Time spent writing a missing/stale compact projection. */
  displayPageWriteMs?: number;
  streaming: boolean;
  loadMs: number;
  buildMs: number;
  totalMs: number;
  fileBytes: number | null;
  messageCount: number;
  entryCount: number;
}

export type StoredDisplayHistoryPage = displayPageStore.StoredDisplayHistoryPage;

/**
 * Read a compact user-turn page without materializing the canonical transcript.
 * A missing/stale projection is rebuilt once from an unvalidated display-only
 * load; active-context integrity remains deferred until provider replay needs it.
 */
export function getStoredDisplayPage(
  id: string,
  turns: number,
  beforeEntryIndex?: number,
  diagnostics?: Partial<RenderSnapshotDiagnostics>,
): StoredDisplayHistoryPage | null {
  if (!summaries.has(id) && !conversations.has(id)) return null;
  const totalStartedAt = diagnostics ? performance.now() : 0;
  const conversationCacheHit = diagnostics ? conversations.has(id) : false;
  if (persistence.isSqliteConversationStore()) {
    if (dirty.has(id)) return null;
    const readStartedAt = diagnostics ? performance.now() : 0;
    const page = persistence.loadDisplayPage(id, turns, beforeEntryIndex);
    const loadedConversation = conversations.get(id);
    // Preserve the existing safety fallback for direct in-memory mutations that
    // have not yet been marked dirty/flushed (notably test and maintenance code).
    if (!page || (loadedConversation && page.storedMessageCount !== loadedConversation.messages.length)) return null;
    const summary = summaries.get(id) ?? summarizeConversation(conversations.get(id)!);
    const folderInstructionsText = formatFolderInstructionsForDisplay(summary.folderId ?? null);
    const pinnedEntries = folderInstructionsText
      ? [{ type: "system_instructions" as const, text: folderInstructionsText }, ...page.pinnedEntries]
      : page.pinnedEntries;
    if (diagnostics) {
      diagnostics.conversationCacheHit = conversationCacheHit;
      diagnostics.snapshotCacheHit = false;
      diagnostics.displayPageHit = true;
      diagnostics.displayPageReadMs = performance.now() - readStartedAt;
      diagnostics.displayPageWriteMs = 0;
      diagnostics.streaming = false;
      diagnostics.loadMs = 0;
      diagnostics.buildMs = 0;
      diagnostics.totalMs = performance.now() - totalStartedAt;
      diagnostics.fileBytes = page.source.baseSize;
      diagnostics.messageCount = summary.messageCount;
      diagnostics.entryCount = page.totalEntries + pinnedEntries.length;
    }
    return { ...page, pinnedEntries };
  }
  let readStartedAt = diagnostics ? performance.now() : 0;
  let page = displayPageStore.loadDisplayPage(id, turns, beforeEntryIndex);
  const loadedConversation = conversations.get(id);
  if (loadedConversation && dirty.has(id)) return null;
  if (page && loadedConversation && page.storedMessageCount !== loadedConversation.messages.length) {
    // An in-memory mutation can exist briefly before its canonical save. Never
    // publish or serve a projection ahead of the durable source of truth.
    page = null;
  }
  let readMs = diagnostics ? performance.now() - readStartedAt : 0;
  const displayPageHit = page !== null;
  let sourceLoadMs = 0;
  let projectionBuildMs = 0;
  let projectionWriteMs = 0;

  if (!page) {
    const sourceLoadStartedAt = diagnostics ? performance.now() : 0;
    // Re-read the canonical source even when a clean in-memory conversation is
    // present. If callers have an unflushed in-memory mutation that somehow was
    // not marked dirty, preserve the existing full-snapshot behavior rather than
    // binding either version to the other's file signature.
    const source = persistence.loadForDisplayProjection(id);
    sourceLoadMs = diagnostics ? performance.now() - sourceLoadStartedAt : 0;
    if (!source) return null;
    if (loadedConversation && !isDeepStrictEqual({
      provider: loadedConversation.provider,
      model: loadedConversation.model,
      effort: loadedConversation.effort,
      fastMode: loadedConversation.fastMode,
      lastContextTokens: loadedConversation.lastContextTokens,
      activeContext: loadedConversation.activeContext,
      messages: loadedConversation.messages,
    }, {
      provider: source.provider,
      model: source.model,
      effort: source.effort,
      fastMode: source.fastMode,
      lastContextTokens: source.lastContextTokens,
      activeContext: source.activeContext,
      messages: source.messages,
    })) return null;
    const expectedSource = displayPageStore.getConversationSourceSignature(id);
    if (!expectedSource) return null;
    const projectionDiagnostics: Partial<displayPageStore.DisplayProjectionWriteDiagnostics> | undefined = diagnostics ? {} : undefined;
    try {
      if (!displayPageStore.writeDisplayProjection(source, expectedSource, projectionDiagnostics)) return null;
    } catch (err) {
      log("warn", `display pages: failed on-demand index for ${id}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    projectionBuildMs = projectionDiagnostics?.buildMs ?? 0;
    projectionWriteMs = projectionDiagnostics?.writeMs ?? 0;
    readStartedAt = diagnostics ? performance.now() : 0;
    page = displayPageStore.loadDisplayPage(id, turns, beforeEntryIndex);
    readMs += diagnostics ? performance.now() - readStartedAt : 0;
  }
  if (!page) return null;

  const summary = summaries.get(id) ?? summarizeConversation(conversations.get(id)!);
  const folderInstructionsText = formatFolderInstructionsForDisplay(summary.folderId ?? null);
  const pinnedEntries = folderInstructionsText
    ? [{ type: "system_instructions" as const, text: folderInstructionsText }, ...page.pinnedEntries]
    : page.pinnedEntries;
  const result = { ...page, pinnedEntries };
  if (diagnostics) {
    diagnostics.conversationCacheHit = conversationCacheHit;
    diagnostics.snapshotCacheHit = false;
    diagnostics.displayPageHit = displayPageHit;
    diagnostics.displayPageReadMs = readMs;
    diagnostics.displayPageWriteMs = projectionWriteMs;
    diagnostics.streaming = false;
    diagnostics.loadMs = sourceLoadMs;
    diagnostics.buildMs = projectionBuildMs;
    diagnostics.totalMs = performance.now() - totalStartedAt;
    diagnostics.fileBytes = page.source.baseSize;
    diagnostics.messageCount = summary.messageCount;
    diagnostics.entryCount = page.totalEntries + pinnedEntries.length;
  }
  return result;
}

function buildSnapshotDisplayData(
  conv: Conversation,
  messages: StoredMessage[],
  includeToolOutputs: boolean,
  includeFolderInstructions = true,
  unwindFingerprintPrefix?: StoredMessage[],
  includeUnwindFingerprints = true,
): ConversationDisplayData {
  const folderInstructionsText = includeFolderInstructions ? formatFolderInstructionsForDisplay(conv.folderId ?? null) : null;
  const displayMessages = folderInstructionsText
    ? [{ role: "system_instructions" as const, content: folderInstructionsText, metadata: null }, ...messages]
    : messages;
  const validActiveContext = conv.activeContext != null
    && isValidActiveContextCached(conv.activeContext, conv.messages);
  const editableUserHistoryStart = validActiveContext
    ? validatedActiveContextCompactionHistoryCount(conv.activeContext!, conv.messages)
    : undefined;
  const hasLostCompactionBoundary = !validActiveContext
    && conv.messages.some((message) => message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND);
  const editableHistoryStart = validActiveContext
    ? editableUserHistoryStart
    : hasLostCompactionBoundary ? null : undefined;
  return buildDisplayData(
    conv.id,
    conv.provider,
    conv.model,
    conv.effort,
    conv.fastMode ?? false,
    displayMessages,
    conv.lastContextTokens,
    summarizeTool,
    {
      includeToolOutputs,
      includeUnwindFingerprints,
      unwindFingerprintPrefix,
      replayHistoryPrefixCount: unwindFingerprintPrefix?.filter(isReplayHistoryMessage).length ?? 0,
      editableUserHistoryStart: editableHistoryStart,
    },
  );
}

function isCurrentAssistantAlreadyCommitted(conv: Conversation, startedAt: number | undefined): boolean {
  return typeof startedAt === "number"
    && conv.messages.some((msg) => msg.role === "assistant" && msg.metadata?.startedAt === startedAt);
}

function sameStreamingTranscriptMessage(persisted: StoredMessage, transient: StoredMessage): boolean {
  const { contextTokens: _persistedContextTokens, ...persistedTranscript } = persisted;
  const { contextTokens: _transientContextTokens, ...transientTranscript } = transient;
  return isDeepStrictEqual(persistedTranscript, transientTranscript);
}

/**
 * Completed provider rounds are canonical as soon as they finish. The transient
 * stream mirror is retained for recovery, but external events (voice transcripts,
 * notices, queue injections) can be interleaved between those canonical rounds,
 * so suffix subtraction is fundamentally incorrect. Match the mirror as an
 * ordered subsequence instead and retain only genuinely unpersisted extras.
 */
function unpersistedStreamingMessages(messages: StoredMessage[], transientMessages: StoredMessage[]): StoredMessage[] {
  const extras: StoredMessage[] = [];
  let persistedCursor = 0;
  for (const transient of transientMessages) {
    let matchedIndex = -1;
    for (let index = persistedCursor; index < messages.length; index++) {
      if (sameStreamingTranscriptMessage(messages[index]!, transient)) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex >= 0) persistedCursor = matchedIndex + 1;
    else extras.push(transient);
  }
  return extras;
}

function messagesWithUnpersistedStreamingExtras(conv: Conversation): StoredMessage[] {
  const transientMessages = streaming.getStreamingDisplayMessages(conv.id);
  if (transientMessages.length === 0) return conv.messages;
  const extras = unpersistedStreamingMessages(conv.messages, transientMessages);
  return extras.length > 0 ? [...conv.messages, ...extras] : conv.messages;
}

export function getRenderSnapshot(
  id: string,
  includeToolOutputs = true,
  diagnostics?: Partial<RenderSnapshotDiagnostics>,
): ConversationRenderSnapshot | null {
  // Avoid clocks, cache probes, and file stats entirely unless a caller opts in.
  const collectingDiagnostics = diagnostics !== undefined;
  const totalStartedAt = collectingDiagnostics ? performance.now() : 0;
  const conversationCacheHit = collectingDiagnostics ? conversations.has(id) : false;
  const loadStartedAt = collectingDiagnostics ? performance.now() : 0;
  const conv = get(id);
  const loadMs = collectingDiagnostics ? performance.now() - loadStartedAt : 0;
  const isStreaming = streaming.isStreaming(id);
  const finishDiagnostics = (snapshot: ConversationRenderSnapshot | null, snapshotCacheHit: boolean, buildStartedAt: number): ConversationRenderSnapshot | null => {
    if (diagnostics) {
      diagnostics.conversationCacheHit = conversationCacheHit;
      diagnostics.snapshotCacheHit = snapshotCacheHit;
      diagnostics.streaming = isStreaming;
      diagnostics.loadMs = loadMs;
      diagnostics.buildMs = buildStartedAt === 0 ? 0 : performance.now() - buildStartedAt;
      diagnostics.totalMs = performance.now() - totalStartedAt;
      try {
        diagnostics.fileBytes = persistence.getConversationFileStat(id).fileSize;
      } catch {
        diagnostics.fileBytes = null;
      }
      diagnostics.messageCount = conv?.messages.length ?? 0;
      diagnostics.entryCount = snapshot?.entries.length ?? 0;
    }
    return snapshot;
  };
  if (!conv) return finishDiagnostics(null, false, 0);

  if (!isStreaming) {
    const cached = renderSnapshotCache.get(id)?.get(includeToolOutputs);
    if (cached) return finishDiagnostics(cached, true, 0);
  }

  const buildStartedAt = collectingDiagnostics ? performance.now() : 0;
  const fullPersisted = buildSnapshotDisplayData(conv, conv.messages, includeToolOutputs);
  if (!isStreaming) {
    let variants = renderSnapshotCache.get(id);
    if (!variants) {
      variants = new Map();
      renderSnapshotCache.set(id, variants);
    }
    variants.set(includeToolOutputs, fullPersisted);
    return finishDiagnostics(fullPersisted, false, buildStartedAt);
  }

  const startedAt = streaming.getStreamingStartedAt(id);
  if (isCurrentAssistantAlreadyCommitted(conv, startedAt)) {
    return finishDiagnostics(fullPersisted, false, buildStartedAt);
  }

  const displayMessages = messagesWithUnpersistedStreamingExtras(conv);
  const canonical = displayMessages === conv.messages
    ? fullPersisted
    : buildSnapshotDisplayData(conv, displayMessages, includeToolOutputs);
  const currentBlocks = streaming.getCurrentStreamingBlocks(id) ?? [];
  const completedBlockCount = streaming.getStreamingCommittedBlockCount(id);

  const snapshot: ConversationRenderSnapshot = {
    ...canonical,
    pendingAI: {
      blocks: [...currentBlocks],
      blockOffset: completedBlockCount,
      metadata: createMessageMetadata(
        startedAt ?? Date.now(),
        conv.model,
        { tokens: streaming.getStreamingTokens(id) },
      ),
    },
  };
  return finishDiagnostics(snapshot, false, buildStartedAt);
}

export function getDisplayData(id: string, includeToolOutputs = true): ConversationDisplayData | null {
  const conv = get(id);
  if (!conv) return null;
  return buildSnapshotDisplayData(conv, messagesWithUnpersistedStreamingExtras(conv), includeToolOutputs);
}

export function getToolOutputs(id: string): ToolOutputInfo[] | null {
  if (persistence.isSqliteConversationStore() && !streaming.isStreaming(id)) {
    const loaded = conversations.get(id);
    const summary = summaries.get(id);
    if (!loaded || !summary || countConversationMessages(loaded.messages) === summary.messageCount) {
      return persistence.loadToolOutputs(id);
    }
  }
  const conv = get(id);
  if (!conv) return null;
  return collectToolOutputs(messagesWithUnpersistedStreamingExtras(conv));
}

// ── Unread state ─────────────────────────────────────────────────────

export function markUnread(convId: string): void {
  if (!summaries.has(convId) && !conversations.has(convId)) return;
  if (areConversationNotificationsMuted(convId)) return;
  if (unread.has(convId)) return;
  unread.add(convId);
  saveUnreadState();
}

/**
 * Persist an external event in the transcript without autonomously starting a
 * model turn. It remains model-visible on the next user turn and is rendered as
 * a provenance-tagged system notice rather than user-authored text.
 */
export function appendExternalInboxNotification(convId: string, text: string, startedAt = Date.now()): boolean {
  const conv = get(convId);
  if (!conv) return false;
  conv.messages.push(createModelVisibleSystemNotice(text, conv.model, "external_notification", startedAt));
  conv.updatedAt = Math.max(conv.updatedAt, startedAt);
  markDirty(convId);
  flush(convId);
  markUnread(convId);
  return true;
}

/** Persist one finalized voice-call utterance as a normal provenance-tagged turn. */
export function appendRealtimeTranscript(
  convId: string,
  role: "user" | "assistant",
  text: string,
  startedAt = Date.now(),
  details: {
    endedAt?: number;
    model?: ModelId;
    tokens?: number;
    callId?: string;
    adapterType?: "tui" | "external";
    adapterId?: string;
    toolName?: string;
    sourceLabel?: string;
    accountAlias?: string;
    endpointId?: string;
    speaker?: RealtimeCallSpeakerAttribution;
  } = {},
): boolean {
  const conv = get(convId);
  const normalized = text.trim();
  if (!conv || !normalized) return false;

  if (role === "user") {
    const message = createStoredUserMessage(normalized, conv.model, startedAt, undefined, {
      contextCheckpoint: createStoredUserContextCheckpoint(conv),
    });
    Object.assign(message.metadata!, realtimeSourceMetadata(details), { kind: REALTIME_TRANSCRIPT_KIND });
    conv.messages.push(message);
  } else {
    conv.messages.push({
      role: "assistant",
      content: normalized,
      metadata: {
        ...createMessageMetadata(startedAt, details.model ?? conv.model, {
          endedAt: details.endedAt ?? startedAt,
          tokens: details.tokens ?? 0,
        }),
        ...realtimeSourceMetadata(details),
        kind: REALTIME_TRANSCRIPT_KIND,
      },
    });
  }

  conv.updatedAt = Math.max(conv.updatedAt, startedAt);
  markDirty(convId);
  flush(convId);
  return true;
}

function visibleMessageText(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function realtimeUtteranceKey(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

/**
 * Promote the latest matching call transcript into the one canonical user
 * request consumed by a delegated backend turn. The message keeps its original
 * timestamp/checkpoint so live transcript projections can reconcile by identity.
 */
export function promoteRealtimeTranscript(
  convId: string,
  originalUserUtterance: string,
  delegatedMessage: string,
  callId?: string,
): boolean {
  const conv = get(convId);
  const expected = realtimeUtteranceKey(originalUserUtterance);
  const replacement = delegatedMessage.trim();
  if (!conv || !expected || !replacement) return false;

  for (let index = conv.messages.length - 1; index >= 0; index--) {
    const message = conv.messages[index]!;
    if (
      message.role !== "user"
      || message.metadata?.kind !== REALTIME_TRANSCRIPT_KIND
      || (callId !== undefined && message.metadata.realtimeCallId !== callId)
      || realtimeUtteranceKey(visibleMessageText(message.content)) !== expected
    ) {
      continue;
    }

    message.content = replacement;
    message.contextTokens = null;
    conv.updatedAt = Date.now();
    // This edits an existing canonical row in place rather than appending a new
    // object. Force field-level SQLite comparison from the changed sequence.
    markDirty(convId, "messages");
    flush(convId);
    return true;
  }
  return false;
}

function realtimeSourceMetadata(details: {
  callId?: string;
  adapterType?: "tui" | "external";
  adapterId?: string;
  toolName?: string;
  sourceLabel?: string;
  accountAlias?: string;
  endpointId?: string;
  speaker?: RealtimeCallSpeakerAttribution;
}): Partial<MessageMetadata> {
  return {
    ...(details.callId ? { realtimeCallId: details.callId } : {}),
    ...(details.adapterType ? { realtimeAdapterType: details.adapterType } : {}),
    ...(details.adapterId ? { realtimeAdapterId: details.adapterId } : {}),
    ...(details.toolName ? { realtimeToolName: details.toolName } : {}),
    ...(details.sourceLabel ? { realtimeSourceLabel: details.sourceLabel } : {}),
    ...(details.accountAlias ? { realtimeAccountAlias: details.accountAlias } : {}),
    ...(details.endpointId ? { realtimeEndpointId: details.endpointId } : {}),
    ...(details.speaker ? { realtimeSpeaker: structuredClone(details.speaker) } : {}),
  };
}

/** Persist a model-hidden lifecycle marker so call boundaries survive history reloads. */
export function appendRealtimeCallStatus(
  convId: string,
  text: string,
  startedAt = Date.now(),
  details: Parameters<typeof realtimeSourceMetadata>[0] = {},
): boolean {
  const conv = get(convId);
  const normalized = text.trim();
  if (!conv || !normalized) return false;
  conv.messages.push({
    role: "system",
    content: normalized,
    metadata: {
      ...createMessageMetadata(startedAt, conv.model, { endedAt: startedAt }),
      ...realtimeSourceMetadata(details),
      kind: REALTIME_CALL_STATUS_KIND,
    },
  });
  conv.updatedAt = Math.max(conv.updatedAt, startedAt);
  markDirty(convId);
  flush(convId);
  return true;
}

export function clearUnread(convId: string): boolean {
  const changed = unread.delete(convId);
  if (changed) saveUnreadState();
  return changed;
}

export function isUnread(convId: string): boolean {
  return !areConversationNotificationsMuted(convId) && unread.has(convId);
}
