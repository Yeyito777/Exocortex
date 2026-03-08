/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map and dirty/flush mechanism for saving
 * to disk. Persistence operations are delegated to persistence.ts.
 * In-flight stream tracking lives in streaming.ts.
 */

import type { Conversation, ModelId, ConversationSummary } from "./messages";
import { createConversation, sortConversations } from "./messages";
import { buildDisplayData, type ConversationDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";
import * as persistence from "./persistence";
import * as streaming from "./streaming";
import { log } from "./log";

// Re-export streaming functions so existing `convStore.*` call sites keep working
export {
  isStreaming, setActiveJob, getActiveJob, clearActiveJob, getStreamingStartedAt,
  resetChunkCounter,
  initStreamingBlocks, getStreamingBlocks, pushStreamingBlock, appendToStreamingBlock, clearStreamingBlocks,
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

export function create(id: string, model: ModelId): Conversation {
  // New conversations go to the top of unpinned: find min sortOrder and subtract 1
  let minOrder = 0;
  for (const c of conversations.values()) {
    if (!c.pinned && c.sortOrder < minOrder) minOrder = c.sortOrder;
  }
  const conv = createConversation(id, model, minOrder - 1);
  conversations.set(id, conv);
  markDirty(id);
  flush(id);
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
    persistence.deleteFile(id);
  }
  return existed;
}

export function setModel(id: string, model: ModelId): boolean {
  const conv = conversations.get(id);
  if (!conv) return false;
  conv.model = model;
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

// ── Persistence ─────────────────────────────────────────────────────

/** Load all conversations from disk into memory on daemon startup. */
export function loadFromDisk(): void {
  const summaries = persistence.loadAll();
  for (const summary of summaries) {
    if (conversations.has(summary.id)) continue;
    const conv = persistence.load(summary.id);
    if (conv) {
      conversations.set(conv.id, conv);
    }
  }
  log("info", `conversations: loaded ${conversations.size} from disk`);
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

/** Track chunk count and flush every N chunks. */
export function onChunk(id: string): void {
  if (streaming.onChunk(id)) {
    markDirty(id);
    flush(id);
  }
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
  if (pinned) {
    // Pinning: place at the bottom of the pinned section
    let maxOrder = -Infinity;
    for (const c of conversations.values()) {
      if (c.pinned && c.id !== id && c.sortOrder > maxOrder) maxOrder = c.sortOrder;
    }
    conv.sortOrder = maxOrder === -Infinity ? 0 : maxOrder + 1;
  } else {
    // Unpinning: place at the top of the unpinned section
    let minOrder = 0;
    for (const c of conversations.values()) {
      if (!c.pinned && c.id !== id && c.sortOrder < minOrder) minOrder = c.sortOrder;
    }
    conv.sortOrder = minOrder - 1;
  }
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
  const firstUserMsg = conv.messages.find(m => m.role === "user");
  const preview = firstUserMsg
    ? typeof firstUserMsg.content === "string"
      ? firstUserMsg.content.slice(0, 80)
      : ""
    : "";
  return {
    id: conv.id,
    model: conv.model,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    preview,
    title: conv.title ?? null,
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
  return buildDisplayData(conv.id, conv.model, conv.messages, conv.lastContextTokens, summarizeTool);
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

