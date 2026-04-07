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

import type { Block, ImageAttachment, StoredMessage } from "./messages";
import type { QueueTiming } from "./protocol";

// ── Types ──────────────────────────────────────────────────────────

export interface QueuedMessage {
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

// ── State ───────────────────────────────────────────────────────────

const activeJobs = new Map<string, AbortController>();
const chunkCounters = new Map<string, number>();
/** Current in-flight assistant blocks for late-joining clients. */
const streamingBlocks = new Map<string, Block[]>();
/** Completed display messages from the active stream that are not yet persisted. */
const streamingDisplayMessages = new Map<string, StoredMessage[]>();
/** Original startedAt timestamp per streaming job (for late-joining clients). */
const streamingStartedAt = new Map<string, number>();
/** Accumulated output token count per streaming job (for late-joining clients). */
const streamingTokens = new Map<string, number>();
/** Messages queued for delivery during or after streaming. */
const messageQueues = new Map<string, QueuedMessage[]>();
/** Last meaningful activity timestamp per streaming job (for stale stream detection). */
const lastActivityAt = new Map<string, number>();
/** Streams paused from staleness tracking (e.g. during tool execution). */
const pausedStreams = new Set<string>();

const CHUNK_SAVE_INTERVAL = 5;

/** How long a stream can be inactive before the watchdog considers it stale. */
export const STALE_STREAM_TIMEOUT = 5 * 60 * 1000; // 5 minutes

// ── Active jobs (abort controllers for in-flight streams) ───────────

/** Streaming state is derived from activeJobs — no boolean on Conversation. */
export function isStreaming(convId: string): boolean {
  return activeJobs.has(convId);
}

export function setActiveJob(convId: string, ac: AbortController, startedAt: number): void {
  activeJobs.set(convId, ac);
  streamingStartedAt.set(convId, startedAt);
  lastActivityAt.set(convId, startedAt);
}

export function getActiveJob(convId: string): AbortController | undefined {
  return activeJobs.get(convId);
}

export function clearActiveJob(convId: string): void {
  activeJobs.delete(convId);
  streamingBlocks.delete(convId);
  streamingStartedAt.delete(convId);
  streamingTokens.delete(convId);
  streamingDisplayMessages.delete(convId);
  lastActivityAt.delete(convId);
  pausedStreams.delete(convId);
}

export function getStreamingStartedAt(convId: string): number | undefined {
  return streamingStartedAt.get(convId);
}

// ── Streaming token count (for late-joining clients) ──────────────

/** Update the accumulated output token count for an in-flight stream. */
export function setStreamingTokens(convId: string, tokens: number): void {
  streamingTokens.set(convId, tokens);
}

/** Get the accumulated output token count for an in-flight stream. */
export function getStreamingTokens(convId: string): number {
  return streamingTokens.get(convId) ?? 0;
}

// ── Activity tracking (for stale stream detection) ──────────────────

/** Record meaningful activity on a stream (chunks, tool calls, retries, etc.). */
export function touchActivity(convId: string): void {
  if (activeJobs.has(convId)) lastActivityAt.set(convId, Date.now());
}

/**
 * Pause staleness tracking for a stream (e.g. during tool execution).
 * The watchdog ignores paused streams entirely — tools can run for hours.
 */
export function pauseActivity(convId: string): void {
  if (activeJobs.has(convId)) pausedStreams.add(convId);
}

/**
 * Resume staleness tracking for a stream (e.g. after tool execution).
 * Resets the activity clock so the stream gets a fresh window.
 */
export function resumeActivity(convId: string): void {
  pausedStreams.delete(convId);
  if (activeJobs.has(convId)) lastActivityAt.set(convId, Date.now());
}

/**
 * Return all streams that have been inactive for longer than STALE_STREAM_TIMEOUT.
 * Skips paused streams (tool execution in progress).
 * Returns [convId, AbortController, inactiveMs][] for the watchdog to act on.
 */
export function getStaleStreams(): Array<[string, AbortController, number]> {
  const now = Date.now();
  const stale: Array<[string, AbortController, number]> = [];
  for (const [convId, ac] of activeJobs) {
    if (pausedStreams.has(convId)) continue; // tools running — not our business
    const last = lastActivityAt.get(convId) ?? 0;
    const inactive = now - last;
    if (inactive >= STALE_STREAM_TIMEOUT) {
      stale.push([convId, ac, inactive]);
    }
  }
  return stale;
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

// ── Late-join streaming display state ───────────────────────────────

/** Initialize all transient streaming state for a new stream or retry. */
export function initStreamingState(convId: string): void {
  streamingBlocks.set(convId, []);
  streamingDisplayMessages.set(convId, []);
}

/** Get the current in-flight assistant blocks for a late-joining client. */
export function getCurrentStreamingBlocks(convId: string): Block[] | undefined {
  return streamingBlocks.get(convId);
}

/** Replace the completed, not-yet-persisted display messages for a stream. */
export function replaceStreamingDisplayMessages(convId: string, messages: StoredMessage[]): void {
  streamingDisplayMessages.set(convId, [...messages]);
}

/** Get the completed, not-yet-persisted display messages for a stream. */
export function getStreamingDisplayMessages(convId: string): StoredMessage[] {
  return [...(streamingDisplayMessages.get(convId) ?? [])];
}

/** Push a new block to the current in-flight assistant accumulator. */
export function pushStreamingBlock(convId: string, block: Block): void {
  const blocks = streamingBlocks.get(convId);
  if (blocks) blocks.push(block);
}

/** Append text to the last in-flight block of the given type. */
export function appendToStreamingBlock(convId: string, type: "text" | "thinking", chunk: string): void {
  const blocks = streamingBlocks.get(convId);
  if (!blocks) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === type) last.text += chunk;
}

/** Clear only the current in-flight assistant blocks between rounds or on finish. */
export function clearCurrentStreamingBlocks(convId: string): void {
  streamingBlocks.delete(convId);
}

// ── Message queue (queued messages for delivery during/after streaming) ─

/** Peek at queued messages without removing them (returns a shallow copy). */
export function getQueuedMessages(convId: string): QueuedMessage[] {
  return [...(messageQueues.get(convId) ?? [])];
}

/** Push a message onto a conversation's queue. */
export function pushQueuedMessage(convId: string, text: string, timing: QueueTiming, images?: ImageAttachment[]): void {
  let queue = messageQueues.get(convId);
  if (!queue) {
    queue = [];
    messageQueues.set(convId, queue);
  }
  queue.push({ text, timing, images });
}

/**
 * Drain queued messages. Removes and returns them.
 * If timing is given, only drains messages with that timing.
 * If omitted, drains all.
 */
export function drainQueuedMessages(convId: string, timing?: QueueTiming): QueuedMessage[] {
  const queue = messageQueues.get(convId);
  if (!queue || queue.length === 0) return [];

  if (timing === undefined) {
    messageQueues.delete(convId);
    return queue;
  }

  const drained: QueuedMessage[] = [];
  const remaining: QueuedMessage[] = [];
  for (const qm of queue) {
    if (qm.timing === timing) drained.push(qm);
    else remaining.push(qm);
  }

  if (remaining.length === 0) messageQueues.delete(convId);
  else messageQueues.set(convId, remaining);
  return drained;
}

/** Remove the first queued message with matching text. Returns true if found. */
export function removeQueuedMessage(convId: string, text: string): boolean {
  const queue = messageQueues.get(convId);
  if (!queue) return false;
  const idx = queue.findIndex(qm => qm.text === text);
  if (idx === -1) return false;
  queue.splice(idx, 1);
  if (queue.length === 0) messageQueues.delete(convId);
  return true;
}

/** Clear all queued messages for a conversation. */
export function clearQueuedMessages(convId: string): void {
  messageQueues.delete(convId);
}
