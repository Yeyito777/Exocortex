/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map and dirty/flush mechanism for saving
 * to disk. Persistence operations are delegated to persistence.ts.
 * In-flight stream tracking lives in streaming.ts.
 */

import type { Conversation, ProviderId, ModelId, EffortLevel, ConversationSummary, StoredMessage } from "./messages";
import { DEFAULT_EFFORT, createConversation, sortConversations, isToolResultMessage, topUnpinnedOrder, bottomPinnedOrder } from "./messages";
import { buildDisplayData, type ConversationDisplayData } from "./display";
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
  initStreamingBlocks, getStreamingBlocks, pushStreamingBlock, appendToStreamingBlock, clearStreamingBlocks,
  getQueuedMessages, pushQueuedMessage, drainQueuedMessages, clearQueuedMessages, removeQueuedMessage,
} from "./streaming";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const dirty = new Set<string>();
const unread = new Set<string>();

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, provider: ProviderId, model: ModelId, title?: string, effort?: EffortLevel): Conversation {
  const conv = createConversation(id, provider, model, topUnpinnedOrder(conversations.values()), title, effort);
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
  return conv;
}

/** Bump an unpinned conversation to the top of the unpinned section. No-op for pinned conversations. */
export function bumpToTop(id: string): boolean {
  const conv = conversations.get(id);
  if (!conv || conv.pinned) return false;
  conv.sortOrder = topUnpinnedOrder(conversations.values(), id);
  markDirty(id);
  return true;
}

/** Clone a conversation: deep-copy with a new ID, placed right after the original in sort order. */
export function clone(id: string): Conversation | null {
  const src = conversations.get(id);
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
  return conversations.get(id);
}

export function remove(id: string): boolean {
  const existed = conversations.delete(id);
  if (existed) {
    dirty.delete(id);
    streaming.clearActiveJob(id);
    streaming.clearStreamingBlocks(id);
    streaming.resetChunkCounter(id);
    streaming.clearQueuedMessages(id);
    persistence.trashFile(id);
  }
  return existed;
}

/** Restore the most recently trashed conversation. Returns it, or null if trash is empty. */
export function undoDelete(): Conversation | null {
  const conv = persistence.restoreLatest();
  if (!conv) return null;
  conversations.set(conv.id, conv);
  log("info", `conversations: restored ${conv.id} from trash`);
  return conv;
}

export function setModel(id: string, model: ModelId, effort?: EffortLevel): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.model = model;
  if (effort) conv.effort = effort;
  markDirty(id);
  flush(id);
  return true;
}

export function setEffort(id: string, effort: EffortLevel): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.effort = effort;
  markDirty(id);
  flush(id);
  return true;
}

export function rename(id: string, title: string): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.title = title;
  markDirty(id);
  flush(id);
  return true;
}

/**
 * Unwind a conversation to before the Nth user message (0-based).
 * Removes that user message and everything after it.
 * Also aborts any active stream and clears any queued messages.
 * Returns a promise that resolves when any active stream has stopped.
 */
export async function unwindTo(id: string, userMessageIndex: number): Promise<boolean> {
  const conv = conversations.get(id);
  if (!conv) return false;

  // Validate the index before doing anything destructive.
  // Only count real user messages — tool_result messages also have
  // role="user" but are invisible in the TUI (folded into AI entries).
  let spliceAt = -1;
  let userCount = 0;
  for (let i = 0; i < conv.messages.length; i++) {
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

/** Load all conversations from disk into memory on daemon startup. */
export function loadFromDisk(): void {
  const summaries = persistence.loadAll();
  for (const summary of summaries) {
    if (conversations.has(summary.id)) continue;
    const conv = persistence.load(summary.id);
    if (conv) {
      const normalizedEffort = normalizeEffort(conv.provider, conv.model, conv.effort);
      if (normalizedEffort !== conv.effort) {
        conv.effort = normalizedEffort;
        markDirty(conv.id);
      }
      conversations.set(conv.id, conv);
    }
  }
  log("info", `conversations: loaded ${conversations.size} from disk`);

  // Deduplicate sortOrders — duplicate values cause move operations to
  // be no-ops (swapping identical values).  Walk each section (pinned,
  // unpinned) in order and bump any collision by a small offset.
  const sorted = [...conversations.values()].sort(
    (a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder,
  );
  const seen = new Set<string>();    // "pinned:sortOrder"
  let fixed = 0;
  for (const conv of sorted) {
    const key = `${conv.pinned}:${conv.sortOrder}`;
    if (seen.has(key)) {
      conv.sortOrder += 0.001 * ++fixed;
      markDirty(conv.id);
    }
    seen.add(`${conv.pinned}:${conv.sortOrder}`);
  }
  if (fixed > 0) {
    log("info", `conversations: deduplicated ${fixed} colliding sortOrder(s)`);
    flushAll();
  }
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
}

/** Flush all dirty conversations. */
export function flushAll(): void {
  for (const id of dirty) {
    const conv = conversations.get(id);
    if (conv) persistence.save(conv);
  }
  dirty.clear();
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
  const summaries: ConversationSummary[] = [];
  for (const conv of conversations.values()) {
    const s = getSummary(conv.id);
    if (s) summaries.push(s);
  }
  sortConversations(summaries);
  return summaries;
}

/** Toggle or set the marked flag on a conversation. */
export function mark(id: string, marked: boolean): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.marked = marked;
  markDirty(id);
  flush(id);
  return true;
}

/** Toggle or set the pinned flag on a conversation. */
export function pin(id: string, pinned: boolean): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.pinned = pinned;
  conv.sortOrder = pinned
    ? bottomPinnedOrder(conversations.values(), id)
    : topUnpinnedOrder(conversations.values(), id);
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
  const currentConv = conversations.get(id)!;
  const targetConv = conversations.get(target.id)!;
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
  const conv = conversations.get(id);
  if (!conv) return null;
  return {
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort ?? DEFAULT_EFFORT,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    title: conv.title,
    marked: conv.marked,
    pinned: conv.pinned,
    streaming: streaming.isStreaming(conv.id),
    unread: unread.has(conv.id),
    sortOrder: conv.sortOrder,
  };
}

// ── Display data ───────────────────────────────────────────────────

export type { ConversationDisplayData, DisplayEntry } from "./display";

export function getDisplayData(id: string): ConversationDisplayData | null {
  const conv = conversations.get(id);
  if (!conv) return null;
  return buildDisplayData(conv.id, conv.provider, conv.model, conv.effort, conv.messages, conv.lastContextTokens, summarizeTool);
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
