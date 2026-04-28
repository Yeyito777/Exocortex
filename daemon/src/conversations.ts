/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map and dirty/flush mechanism for saving
 * to disk. Persistence operations are delegated to persistence.ts.
 * In-flight stream tracking lives in streaming.ts.
 */

import type { Conversation, ProviderId, ModelId, EffortLevel, ConversationSummary, StoredMessage, Block, MessageMetadata, PersistedConversationSummary } from "./messages";
import { DEFAULT_EFFORT, createConversation, createMessageMetadata, sortConversations, isToolResultMessage, topUnpinnedOrder, bottomPinnedOrder, summarizeConversation } from "./messages";
import type { TrimMode, ToolOutputInfo } from "./protocol";
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
  setStreamingTokens, getStreamingTokens,
  touchActivity, pauseActivity, resumeActivity,
  resetChunkCounter,
  initStreamingState, getCurrentStreamingBlocks, replaceCurrentStreamingBlocks, replaceStreamingDisplayMessages, getStreamingDisplayMessages,
  pushStreamingBlock, appendToStreamingBlock, clearCurrentStreamingBlocks,
  getQueuedMessages, pushQueuedMessage, drainQueuedMessages, clearQueuedMessages, removeQueuedMessage,
} from "./streaming";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const summaries = new Map<string, PersistedConversationSummary>();
const dirty = new Set<string>();
const unread = new Set<string>();

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

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, provider: ProviderId, model: ModelId, title?: string, effort?: EffortLevel, fastMode = false): Conversation {
  const conv = createConversation(id, provider, model, topUnpinnedOrder(summaries.values()), title, effort, fastMode);
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
  return conv;
}

/** Bump an unpinned conversation to the top of the unpinned section. No-op for pinned conversations. */
export function bumpToTop(id: string): boolean {
  const conv = get(id);
  if (!conv || conv.pinned) return false;
  conv.sortOrder = topUnpinnedOrder(summaries.values(), id);
  markDirty(id);
  return true;
}

/** Clone a conversation: deep-copy with a new ID, placed right after the original in sort order. */
export function clone(id: string): Conversation | null {
  const src = get(id);
  if (!src) return null;

  const newId = generateId();
  const now = Date.now();

  // Compute a sortOrder between the original and the item after it
  const summaries = listSummaries();
  const srcIdx = summaries.findIndex(s => s.id === id);
  let newOrder: number;
  if (srcIdx >= 0 && srcIdx + 1 < summaries.length && summaries[srcIdx + 1].pinned === src.pinned) {
    // Place between the original and the next item in the same section
    newOrder = (src.sortOrder + summaries[srcIdx + 1].sortOrder) / 2;
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

/** Restore the most recently trashed conversation. Returns it, or null if trash is empty. */
export function undoDelete(): Conversation | null {
  const conv = persistence.restoreLatest();
  if (!conv) return null;
  conversations.set(conv.id, conv);
  updateSummaryFromConversation(conv);
  saveSummaryIndex();
  log("info", `conversations: restored ${conv.id} from trash`);
  return conv;
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

// ── Persistence ─────────────────────────────────────────────────────

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

  let normalizedEffortCount = 0;
  for (const summary of index.summaries) {
    const normalizedEffort = normalizeEffort(summary.provider, summary.model, summary.effort);
    if (normalizedEffort !== summary.effort) {
      summary.effort = normalizedEffort;
      normalizedEffortCount++;
    }
    summaries.set(summary.id, summary);
  }
  log("info", `conversations: loaded ${summaries.size} summaries from disk (index reused=${index.reused}, rebuilt=${index.rebuilt})`);

  // Deduplicate sortOrders — duplicate values cause move operations to
  // be no-ops (swapping identical values).  Walk each section (pinned,
  // unpinned) in order and bump any collision by a small offset.
  const sorted = [...summaries.values()].sort(
    (a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder,
  );
  const seen = new Set<string>();    // "pinned:sortOrder"
  let fixed = 0;
  for (const summary of sorted) {
    const key = `${summary.pinned}:${summary.sortOrder}`;
    if (seen.has(key)) {
      summary.sortOrder += 0.001 * ++fixed;
      const conv = get(summary.id);
      if (conv) {
        conv.sortOrder = summary.sortOrder;
        markDirty(conv.id);
      }
    }
    seen.add(`${summary.pinned}:${summary.sortOrder}`);
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
  sortConversations(result);
  return result;
}

/** List conversation IDs that currently have an in-flight stream. */
export function listRunningConversationIds(): string[] {
  return listSummaries()
    .filter((summary) => summary.streaming)
    .map((summary) => summary.id);
}

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
    ? bottomPinnedOrder(summaries.values(), id)
    : topUnpinnedOrder(summaries.values(), id);
  markDirty(id);
  flush(id);
  return true;
}

/** Move a conversation up or down within its section (pinned or unpinned). */
export function move(id: string, direction: "up" | "down"): boolean {
  const summaries = listSummaries();
  const idx = summaries.findIndex(s => s.id === id);
  if (idx === -1) return false;

  const current = summaries[idx];
  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= summaries.length) return false;

  const target = summaries[targetIdx];
  // Don't cross the pinned/unpinned boundary
  if (target.pinned !== current.pinned) return false;

  // Swap sortOrder values
  const currentConv = get(id)!;
  const targetConv = get(target.id)!;
  const tmp = currentConv.sortOrder;
  currentConv.sortOrder = targetConv.sortOrder;
  targetConv.sortOrder = tmp;

  // If sortOrders were equal the swap is a no-op — differentiate them
  // so the move actually takes effect.
  if (currentConv.sortOrder === targetConv.sortOrder) {
    if (direction === "up") {
      currentConv.sortOrder -= 0.5;
    } else {
      currentConv.sortOrder += 0.5;
    }
  }

  markDirty(id);
  markDirty(target.id);
  flush(id);
  flush(target.id);
  return true;
}

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
