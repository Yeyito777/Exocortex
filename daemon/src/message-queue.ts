import { isEphemeralConversation } from "./app-registry";
import { isFastMode, type FastMode } from "@exocortex/shared/messages";
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
import type { QueueTiming, QueuedMessageInfo, QueueWaitTarget, UserMessageAutomation } from "./protocol";
import * as persistence from "./persistence";

export interface QueuedMessage extends QueuedMessageInfo {
  /** Delegation budget installed if this queue entry starts a later turn. */
  subagentMaxDepth?: number | null;
  /** Durable completion notification represented by this queue item. */
  subagentNotificationId?: string;
}

export interface GlobalIdleQueueOptions {
  id?: string;
  command?: QueuedMessageInfo["command"];
  target?: "conversation" | "new-conversation";
  provider?: QueuedMessageInfo["provider"];
  model?: QueuedMessageInfo["model"];
  effort?: QueuedMessageInfo["effort"];
  fastMode?: FastMode;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
  createdAt?: number;
}

type QueueChangedListener = (messages: QueuedMessageInfo[]) => void;

let messages: QueuedMessage[] = [];
let changedListener: QueueChangedListener | null = null;
const observers = new Set<() => void>();
/** Ephemeral delivery gates used by destructive operations such as unwind. */
const deliverySuspended = new Set<string>();
let persistenceFailureForTest: Error | null = null;

function publicEntry(entry: QueuedMessage): QueuedMessageInfo {
  const {
    subagentMaxDepth: _subagentMaxDepth,
    subagentNotificationId: _subagentNotificationId,
    ...info
  } = cloneEntry(entry);
  return info;
}

function cloneEntry(entry: QueuedMessage): QueuedMessage {
  return {
    ...entry,
    ...(entry.automation ? { automation: { ...entry.automation } } : {}),
    ...(entry.command ? { command: { ...entry.command } } : {}),
    ...(entry.images ? { images: entry.images.map(image => ({ ...image })) } : {}),
  };
}

/** Ephemeral app conversations' queued messages live only in memory. */
function durableMessages(entries: QueuedMessage[]): QueuedMessage[] {
  return entries.some(entry => isEphemeralConversation(entry.convId)) ? entries.filter(entry => !isEphemeralConversation(entry.convId)) : entries;
}

function cloneMessages(): QueuedMessage[] {
  return messages.map(cloneEntry);
}

/**
 * Apply a mutation, save the queue file and tell listeners. `memoryOnly`: it
 * changes only an ephemeral conversation's entries, which are not in the file
 * (one a restart handed over exists before the file is loaded).
 */
function mutateAndCommit<T>(mutation: () => T, memoryOnly = false): T {
  const previous = cloneMessages();
  let result: T;
  try {
    result = mutation();
    if (!memoryOnly) {
      if (persistenceFailureForTest) throw persistenceFailureForTest;
      persistence.saveQueuedMessages(durableMessages(messages));
    }
  } catch (error) {
    messages = previous;
    throw error;
  }
  changedListener?.(listQueuedMessages());
  notifyObservers();
  return result;
}

function notifyObservers(): void {
  for (const observer of [...observers]) observer();
}

/** Install the daemon-server broadcaster/scheduler hook. */
export function setQueuedMessagesChangedListener(listener: QueueChangedListener | null): void {
  changedListener = listener;
}

/** Call `observer` after every change to what getQueuedMessages returns. Returns a function that stops it. */
export function observeQueuedMessages(observer: () => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

/**
 * Load queue state after conversations have loaded, dropping already-accepted
 * crash-window entries. Ephemeral conversations' entries were never in the
 * file: the ones a graceful restart handed over (adoptQueuedMessages) stay.
 */
export function loadQueuedMessagesFromDisk(deliveredQueueIds: ReadonlySet<string> = new Set()): number {
  deliverySuspended.clear();
  const loaded = persistence.loadQueuedMessages();
  const unwindTombstones = persistence.loadUnwindQueueTombstones();
  const seen = new Set<string>();
  const kept = loaded.filter((entry) => {
    if (seen.has(entry.id) || deliveredQueueIds.has(entry.id) || unwindTombstones.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  if (kept.length !== loaded.length || unwindTombstones.size > 0) {
    persistence.saveQueuedMessages(durableMessages(kept));
    persistence.acknowledgeRecoveredUnwindQueueCleanup();
  }
  messages = [...kept, ...messages.filter(entry => isEphemeralConversation(entry.convId) && !seen.has(entry.id))];
  changedListener?.(listQueuedMessages());
  notifyObservers();
  return messages.length;
}

/** Full canonical snapshot in FIFO insertion order. */
export function listQueuedMessages(): QueuedMessageInfo[] {
  return messages.map(publicEntry);
}

/** Internal snapshot including delegation/notification metadata. */
export function listInternalQueuedMessages(): QueuedMessage[] {
  return messages.map(cloneEntry);
}

/** Stream-relative entries for one conversation, in FIFO order. */
export function getQueuedMessages(convId: string): QueuedMessage[] {
  if (deliverySuspended.has(convId)) return [];
  return messages
    .filter(entry => entry.convId === convId && entry.source === "daemon")
    .map(cloneEntry);
}

/** Deliver a conversation's message-end entries at the next turn boundary instead. */
export function advanceQueuedMessagesToNextTurn(convId: string): boolean {
  const entries = getQueuedMessages(convId).filter(entry => entry.timing === "message-end").map(entry => entry.id);
  if (entries.length === 0) return false;
  const ids = new Set(entries);
  mutateAndCommit(() => {
    for (const entry of messages) if (ids.has(entry.id)) entry.timing = "next-turn";
  }, isEphemeralConversation(convId));
  return true;
}

/** Whether any next-turn input, automated or not, is queued for a conversation. */
export function hasQueuedNextTurn(convId: string): boolean {
  return getQueuedMessages(convId).some(entry => entry.timing === "next-turn");
}

/**
 * Whether a person queued next-turn input that should steer the active turn
 * now. Automated next-turn entries (wakes, notifications) wait for a boundary.
 */
export function hasQueuedUserSteer(convId: string): boolean {
  return getQueuedMessages(convId).some(entry => entry.timing === "next-turn" && !entry.automation);
}

export function suspendQueuedMessageDelivery(convId: string): void {
  deliverySuspended.add(convId);
  notifyObservers();
}

export function resumeQueuedMessageDelivery(convId: string): void {
  deliverySuspended.delete(convId);
  notifyObservers();
}

export function isQueuedMessageDeliverySuspended(convId: string): boolean {
  return deliverySuspended.has(convId);
}

export function getQueuedMessageById(id: string): QueuedMessage | undefined {
  const entry = messages.find(candidate => candidate.id === id);
  return entry ? cloneEntry(entry) : undefined;
}

/**
 * An ephemeral conversation's entries, which a graceful restart handed over
 * in place of the queue file. Returns how many were new. The file does not
 * change (and is not loaded yet when a restart's handover is taken over).
 */
export function adoptQueuedMessages(entries: readonly QueuedMessage[]): number {
  const known = new Set(messages.map(entry => entry.id));
  const adopted = entries.filter(entry => isEphemeralConversation(entry.convId) && !known.has(entry.id)).map(cloneEntry);
  if (adopted.length > 0) mutateAndCommit(() => { messages.push(...adopted); }, true);
  return adopted.length;
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
  automation?: UserMessageAutomation,
): QueuedMessage {
  const existing = messages.find(entry => entry.id === id);
  if (existing) return cloneEntry(existing);
  const entry: QueuedMessage = {
    id,
    convId,
    text,
    timing,
    images,
    source: "daemon",
    createdAt,
    ...(automation ? { automation: { ...automation } } : {}),
    subagentMaxDepth,
    subagentNotificationId,
  };
  return mutateAndCommit(() => {
    messages.push(entry);
    return cloneEntry(entry);
  }, isEphemeralConversation(convId));
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
  if (existing) return cloneEntry(existing);
  const entry: QueuedMessage = {
    id,
    convId,
    text,
    ...(options.command ? { command: { ...options.command } } : {}),
    timing: "message-end",
    images,
    source: "global-idle",
    createdAt: options.createdAt ?? Date.now(),
    ...(options.target ? { target: options.target } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(isFastMode(options.fastMode) ? { fastMode: options.fastMode } : {}),
    ...("folderId" in options ? { folderId: options.folderId ?? null } : {}),
    ...(options.waitTarget && options.waitTarget.type !== "global" ? { waitTarget: options.waitTarget } : {}),
  };
  return mutateAndCommit(() => {
    messages.push(entry);
    return cloneEntry(entry);
  }, isEphemeralConversation(convId));
}

/** Remove one entry by stable identity. */
export function removeQueuedMessageById(id: string): boolean {
  const index = messages.findIndex(entry => entry.id === id);
  if (index === -1) return false;
  mutateAndCommit(() => messages.splice(index, 1), isEphemeralConversation(messages[index].convId));
  return true;
}

export function removeQueuedMessagesById(ids: Iterable<string>): number {
  const remove = new Set(ids);
  if (remove.size === 0) return 0;
  const before = messages.length;
  const removed = before - messages.filter(entry => !remove.has(entry.id)).length;
  if (removed > 0) mutateAndCommit(() => { messages = messages.filter(entry => !remove.has(entry.id)); });
  return removed;
}

/** Force the current in-memory queue snapshot to the durable queue file. */
export function persistQueuedMessagesSnapshot(): void {
  persistence.saveQueuedMessages(durableMessages(messages));
}

/** Remove the first ordinary queue entry with matching text. */
export function removeQueuedMessage(convId: string, text: string): boolean {
  const entry = messages.find(candidate => candidate.source === "daemon" && candidate.convId === convId && candidate.text === text);
  return entry ? removeQueuedMessageById(entry.id) : false;
}

/** Hand a ready plain `/queue` entry to its conversation's active turn as a steer. */
export function steerGlobalIdleQueuedMessage(id: string): boolean {
  const index = messages.findIndex(entry => entry.id === id && entry.source === "global-idle" && !entry.command);
  if (index === -1) return false;
  const { convId, text, images, createdAt, automation } = messages[index];
  mutateAndCommit(() => {
    messages[index] = {
      id, convId, text, timing: "next-turn", source: "daemon", createdAt,
      ...(images ? { images } : {}),
      ...(automation ? { automation } : {}),
    };
  }, isEphemeralConversation(convId));
  return true;
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
  mutateAndCommit(() => {
    entry.text = text;
    entry.timing = entry.source === "global-idle" ? "message-end" : timing;
    if (images?.length) entry.images = images;
    else delete entry.images;
  }, isEphemeralConversation(entry.convId));
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
  mutateAndCommit(() => {
    [messages[index], messages[swap.candidateIndex]] = [messages[swap.candidateIndex], messages[index]];
  });
  return true;
}

/** Drain ordinary stream-relative entries, optionally by timing. */
export function drainQueuedMessages(convId: string, timing?: QueueTiming): QueuedMessage[] {
  const drained = messages.filter(entry => entry.source === "daemon"
    && entry.convId === convId
    && (timing === undefined || entry.timing === timing));
  if (drained.length === 0) return [];
  const ids = new Set(drained.map(entry => entry.id));
  mutateAndCommit(() => { messages = messages.filter(entry => !ids.has(entry.id)); }, isEphemeralConversation(convId));
  return drained.map(cloneEntry);
}

/** Clear every queued entry targeting a conversation (including `/queue`). */
export function clearQueuedMessages(convId: string): void {
  deliverySuspended.delete(convId);
  const remaining = messages.filter(entry => entry.convId !== convId);
  if (remaining.length === messages.length) return;
  mutateAndCommit(() => { messages = remaining; }, isEphemeralConversation(convId));
}

/** Test/process cleanup helper. */
export function clearAllQueuedMessages(): void {
  deliverySuspended.clear();
  if (messages.length === 0) return;
  mutateAndCommit(() => { messages = []; });
}

export function setMessageQueuePersistenceFailureForTest(error: Error | null): void {
  persistenceFailureForTest = error;
}
