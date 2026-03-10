/**
 * In-flight stream tracking.
 *
 * Manages the runtime state of active streams: abort controllers,
 * accumulated display blocks (for late-joining clients), chunk
 * counters (for periodic persistence), and startedAt timestamps.
 *
 * This is ephemeral runtime state — nothing here is persisted.
 * Conversation data and persistence live in conversations.ts.
 */

import type { Block } from "./messages";
import type { QueueTiming } from "./protocol";

// ── Types ──────────────────────────────────────────────────────────

export interface QueuedMessage {
  text: string;
  timing: QueueTiming;
}

// ── State ───────────────────────────────────────────────────────────

const activeJobs = new Map<string, AbortController>();
const chunkCounters = new Map<string, number>();
/** Accumulated display blocks for in-flight streams (for late-joining clients). */
const streamingBlocks = new Map<string, Block[]>();
/** Original startedAt timestamp per streaming job (for late-joining clients). */
const streamingStartedAt = new Map<string, number>();
/** Messages queued for delivery during or after streaming. */
const messageQueues = new Map<string, QueuedMessage[]>();

const CHUNK_SAVE_INTERVAL = 5;

// ── Active jobs (abort controllers for in-flight streams) ───────────

/** Streaming state is derived from activeJobs — no boolean on Conversation. */
export function isStreaming(convId: string): boolean {
  return activeJobs.has(convId);
}

export function setActiveJob(convId: string, ac: AbortController, startedAt: number): void {
  activeJobs.set(convId, ac);
  streamingStartedAt.set(convId, startedAt);
}

export function getActiveJob(convId: string): AbortController | undefined {
  return activeJobs.get(convId);
}

export function clearActiveJob(convId: string): void {
  activeJobs.delete(convId);
  streamingStartedAt.delete(convId);
}

export function getStreamingStartedAt(convId: string): number | undefined {
  return streamingStartedAt.get(convId);
}

// ── Chunk counting (for periodic persistence) ─────────────────────

/**
 * Track chunk count. Returns true when the count crosses the
 * save interval threshold (caller should flush to disk).
 */
export function onChunk(convId: string): boolean {
  const count = (chunkCounters.get(convId) ?? 0) + 1;
  chunkCounters.set(convId, count);
  if (count >= CHUNK_SAVE_INTERVAL) {
    chunkCounters.set(convId, 0);
    return true;
  }
  return false;
}

/** Reset chunk counter (call on block boundaries / message complete). */
export function resetChunkCounter(convId: string): void {
  chunkCounters.delete(convId);
}

// ── Streaming blocks (accumulated display blocks for late-joiners) ──

/** Initialize streaming blocks for a new stream. */
export function initStreamingBlocks(convId: string): void {
  streamingBlocks.set(convId, []);
}

/** Get the accumulated streaming blocks (for late-joining clients). */
export function getStreamingBlocks(convId: string): Block[] | undefined {
  return streamingBlocks.get(convId);
}

/** Push a new block to the streaming accumulator. */
export function pushStreamingBlock(convId: string, block: Block): void {
  const blocks = streamingBlocks.get(convId);
  if (blocks) blocks.push(block);
}

/** Append text to the last streaming block of the given type. */
export function appendToStreamingBlock(convId: string, type: "text" | "thinking", chunk: string): void {
  const blocks = streamingBlocks.get(convId);
  if (!blocks) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === type) last.text += chunk;
}

/** Clear streaming blocks (call when stream finishes). */
export function clearStreamingBlocks(convId: string): void {
  streamingBlocks.delete(convId);
}

// ── Message queue (queued messages for delivery during/after streaming) ─

/** Peek at queued messages without removing them (returns a shallow copy). */
export function getQueuedMessages(convId: string): QueuedMessage[] {
  return [...(messageQueues.get(convId) ?? [])];
}

/** Push a message onto a conversation's queue. */
export function pushQueuedMessage(convId: string, text: string, timing: QueueTiming): void {
  let queue = messageQueues.get(convId);
  if (!queue) {
    queue = [];
    messageQueues.set(convId, queue);
  }
  queue.push({ text, timing });
}

/**
 * Drain queued messages with the given timing. Removes and returns them.
 * If timing is omitted, drains all queued messages.
 */
export function drainQueuedMessages(convId: string, timing?: QueueTiming): QueuedMessage[] {
  const queue = messageQueues.get(convId);
  if (!queue || queue.length === 0) return [];

  const drained: QueuedMessage[] = [];
  const remaining: QueuedMessage[] = [];
  for (const qm of queue) {
    if (timing === undefined || qm.timing === timing) {
      drained.push(qm);
    } else {
      remaining.push(qm);
    }
  }

  if (remaining.length === 0) {
    messageQueues.delete(convId);
  } else {
    messageQueues.set(convId, remaining);
  }
  return drained;
}

/** Clear all queued messages for a conversation. */
export function clearQueuedMessages(convId: string): void {
  messageQueues.delete(convId);
}
