/**
 * Durable daemon-owned message queue.
 *
 * Both stream-relative messages (next-turn/message-end) and `/queue` idle-wait
 * messages live here. Every mutation is synchronously persisted before clients
 * are notified, so disconnecting a client or restarting the daemon cannot lose
 * accepted user intent.
 */

import { randomUUID } from "node:crypto";
import type { ImageAttachment } from "./messages";
import type { QueueTiming, QueuedMessageInfo, QueueWaitTarget } from "./protocol";
import * as persistence from "./persistence";

export interface QueuedMessage extends QueuedMessageInfo {
  /** Delegation budget installed if this queue entry starts a later turn. */
  subagentMaxDepth?: number | null;
  /** Durable completion notification represented by this queue item. */
  subagentNotificationId?: string;
}

export interface GlobalIdleQueueOptions {
  id?: string;
  target?: "conversation" | "new-conversation";
  provider?: QueuedMessageInfo["provider"];
  model?: QueuedMessageInfo["model"];
  effort?: QueuedMessageInfo["effort"];
  fastMode?: boolean;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
  createdAt?: number;
}

type QueueChangedListener = (messages: QueuedMessageInfo[]) => void;

let messages: QueuedMessage[] = [];
let changedListener: QueueChangedListener | null = null;
/** Ephemeral delivery gates used by destructive operations such as unwind. */
const deliverySuspended = new Set<string>();

function publicEntry(entry: QueuedMessage): QueuedMessageInfo {
  const {
    subagentMaxDepth: _subagentMaxDepth,
    subagentNotificationId: _subagentNotificationId,
    ...info
  } = entry;
  return info;
}

function commit(): void {
  persistence.saveQueuedMessages(messages);
  changedListener?.(listQueuedMessages());
}

/** Install the daemon-server broadcaster/scheduler hook. */
export function setQueuedMessagesChangedListener(listener: QueueChangedListener | null): void {
  changedListener = listener;
}

/** Load queue state after conversations have loaded, dropping already-accepted crash-window entries. */
export function loadQueuedMessagesFromDisk(deliveredQueueIds: ReadonlySet<string> = new Set()): number {
  deliverySuspended.clear();
  const loaded = persistence.loadQueuedMessages();
  const unwindTombstones = persistence.loadUnwindQueueTombstones();
  const seen = new Set<string>();
  messages = loaded.filter((entry) => {
    if (seen.has(entry.id) || deliveredQueueIds.has(entry.id) || unwindTombstones.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  if (messages.length !== loaded.length || unwindTombstones.size > 0) {
    persistence.saveQueuedMessages(messages);
    persistence.acknowledgeRecoveredUnwindQueueCleanup();
  }
  changedListener?.(listQueuedMessages());
  return messages.length;
}

/** Full canonical snapshot in FIFO insertion order. */
export function listQueuedMessages(): QueuedMessageInfo[] {
  return messages.map(publicEntry);
}

/** Internal snapshot including delegation/notification metadata. */
export function listInternalQueuedMessages(): QueuedMessage[] {
  return messages.map(entry => ({ ...entry }));
}

/** Stream-relative entries for one conversation, in FIFO order. */
export function getQueuedMessages(convId: string): QueuedMessage[] {
  if (deliverySuspended.has(convId)) return [];
  return messages
    .filter(entry => entry.convId === convId && entry.source === "daemon")
    .map(entry => ({ ...entry }));
}

export function suspendQueuedMessageDelivery(convId: string): void {
  deliverySuspended.add(convId);
}

export function resumeQueuedMessageDelivery(convId: string): void {
  deliverySuspended.delete(convId);
}

export function isQueuedMessageDeliverySuspended(convId: string): boolean {
  return deliverySuspended.has(convId);
}

export function getQueuedMessageById(id: string): QueuedMessage | undefined {
  const entry = messages.find(candidate => candidate.id === id);
  return entry ? { ...entry } : undefined;
}

/** Push an ordinary stream-relative queue entry. Returns its durable identity. */
export function pushQueuedMessage(
  convId: string,
  text: string,
  timing: QueueTiming,
  images?: ImageAttachment[],
  subagentMaxDepth?: number | null,
  subagentNotificationId?: string,
  id: string = randomUUID(),
  createdAt = Date.now(),
): QueuedMessage {
  const existing = messages.find(entry => entry.id === id);
  if (existing) return { ...existing };
  const entry: QueuedMessage = {
    id,
    convId,
    text,
    timing,
    images,
    source: "daemon",
    createdAt,
    subagentMaxDepth,
    subagentNotificationId,
  };
  messages.push(entry);
  commit();
  return { ...entry };
}

/** Push a `/queue` entry whose readiness is evaluated by the daemon. */
export function pushGlobalIdleQueuedMessage(
  convId: string,
  text: string,
  images?: ImageAttachment[],
  options: GlobalIdleQueueOptions = {},
): QueuedMessage {
  const id = options.id ?? randomUUID();
  const existing = messages.find(entry => entry.id === id);
  if (existing) return { ...existing };
  const entry: QueuedMessage = {
    id,
    convId,
    text,
    timing: "message-end",
    images,
    source: "global-idle",
    createdAt: options.createdAt ?? Date.now(),
    ...(options.target ? { target: options.target } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
    ...("folderId" in options ? { folderId: options.folderId ?? null } : {}),
    ...(options.waitTarget && options.waitTarget.type !== "global" ? { waitTarget: options.waitTarget } : {}),
  };
  messages.push(entry);
  commit();
  return { ...entry };
}

/** Remove one entry by stable identity. */
export function removeQueuedMessageById(id: string): boolean {
  const index = messages.findIndex(entry => entry.id === id);
  if (index === -1) return false;
  messages.splice(index, 1);
  commit();
  return true;
}

export function removeQueuedMessagesById(ids: Iterable<string>): number {
  const remove = new Set(ids);
  if (remove.size === 0) return 0;
  const before = messages.length;
  messages = messages.filter(entry => !remove.has(entry.id));
  const removed = before - messages.length;
  if (removed > 0) commit();
  return removed;
}

/** Force the current in-memory queue snapshot to the durable queue file. */
export function persistQueuedMessagesSnapshot(): void {
  persistence.saveQueuedMessages(messages);
}

/** Remove the first ordinary queue entry with matching text. */
export function removeQueuedMessage(convId: string, text: string): boolean {
  const entry = messages.find(candidate => candidate.source === "daemon" && candidate.convId === convId && candidate.text === text);
  return entry ? removeQueuedMessageById(entry.id) : false;
}

/** Replace user-editable content while retaining identity, dependencies, and FIFO position. */
export function updateQueuedMessage(
  id: string,
  text: string,
  timing: QueueTiming,
  images?: ImageAttachment[],
): boolean {
  const entry = messages.find(candidate => candidate.id === id);
  if (!entry) return false;
  entry.text = text;
  entry.timing = entry.source === "global-idle" ? "message-end" : timing;
  if (images?.length) entry.images = images;
  else delete entry.images;
  commit();
  return true;
}

/** Reorder within the entry's FIFO: per-conversation for daemon queues, global for `/queue`. */
export function moveQueuedMessage(id: string, direction: "up" | "down"): boolean {
  const index = messages.findIndex(entry => entry.id === id);
  if (index === -1) return false;
  const entry = messages[index];
  const candidates = messages
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate }) => entry.source === "global-idle"
      ? candidate.source === "global-idle"
      : candidate.source === "daemon" && candidate.convId === entry.convId);
  const position = candidates.findIndex(candidate => candidate.candidateIndex === index);
  const swap = candidates[position + (direction === "up" ? -1 : 1)];
  if (!swap) return false;
  [messages[index], messages[swap.candidateIndex]] = [messages[swap.candidateIndex], messages[index]];
  commit();
  return true;
}

/** Drain ordinary stream-relative entries, optionally by timing. */
export function drainQueuedMessages(convId: string, timing?: QueueTiming): QueuedMessage[] {
  const drained = messages.filter(entry => entry.source === "daemon"
    && entry.convId === convId
    && (timing === undefined || entry.timing === timing));
  if (drained.length === 0) return [];
  const ids = new Set(drained.map(entry => entry.id));
  messages = messages.filter(entry => !ids.has(entry.id));
  commit();
  return drained.map(entry => ({ ...entry }));
}

/** Clear every queued entry targeting a conversation (including `/queue`). */
export function clearQueuedMessages(convId: string): void {
  deliverySuspended.delete(convId);
  const remaining = messages.filter(entry => entry.convId !== convId);
  if (remaining.length === messages.length) return;
  messages = remaining;
  commit();
}

/** Test/process cleanup helper. */
export function clearAllQueuedMessages(): void {
  deliverySuspended.clear();
  if (messages.length === 0) return;
  messages = [];
  commit();
}
