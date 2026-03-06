/**
 * In-memory conversation store with persistence.
 *
 * Owns the conversation map, active job tracking, and dirty/flush
 * mechanism for saving to disk. Persistence operations are delegated
 * to persistence.ts.
 */

import type { Conversation, ModelId, ConversationSummary } from "./messages";
import { createConversation } from "./messages";
import * as persistence from "./persistence";
import { log } from "./log";

// ── State ───────────────────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const activeJobs = new Map<string, AbortController>();
const dirty = new Set<string>();
const chunkCounters = new Map<string, number>();

const CHUNK_SAVE_INTERVAL = 5;

// ── IDs ─────────────────────────────────────────────────────────────

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Conversations ───────────────────────────────────────────────────

export function create(id: string, model: ModelId): Conversation {
  const conv = createConversation(id, model);
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
    activeJobs.delete(id);
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
  const count = (chunkCounters.get(id) ?? 0) + 1;
  chunkCounters.set(id, count);
  if (count >= CHUNK_SAVE_INTERVAL) {
    markDirty(id);
    flush(id);
    chunkCounters.set(id, 0);
  }
}

/** Reset chunk counter (call on block boundaries / message complete). */
export function resetChunkCounter(id: string): void {
  chunkCounters.delete(id);
}

/** Get conversation summaries for the sidebar. */
export function listSummaries(): ConversationSummary[] {
  return persistence.loadAll();
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
    updatedAt: Date.now(),
    messageCount: conv.messages.length,
    preview,
    marked: conv.marked,
  };
}

// ── Display data ───────────────────────────────────────────────────

import { buildDisplayData, type ConversationDisplayData } from "./display";
import { summarizeTool } from "./tools/registry";

export type { ConversationDisplayData, AIMessageDisplay } from "./display";

export function getDisplayData(id: string): ConversationDisplayData | null {
  const conv = conversations.get(id);
  if (!conv) return null;
  return buildDisplayData(conv.id, conv.model, conv.messages, conv.lastContextTokens, summarizeTool);
}

// ── Active jobs (abort controllers for in-flight streams) ───────────

/** Streaming state is derived from activeJobs — no boolean on Conversation. */
export function isStreaming(convId: string): boolean {
  return activeJobs.has(convId);
}

export function setActiveJob(convId: string, ac: AbortController): void {
  activeJobs.set(convId, ac);
}

export function getActiveJob(convId: string): AbortController | undefined {
  return activeJobs.get(convId);
}

export function clearActiveJob(convId: string): void {
  activeJobs.delete(convId);
}
