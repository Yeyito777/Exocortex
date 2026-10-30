/** Lightweight lifecycle hooks that avoid coupling the conversation store to services. */

import type { Block } from "./messages";

type RemovedListener = (conversationId: string) => void;
type RemovingListener = (conversationId: string) => void;
const removedListeners = new Set<RemovedListener>();
const removingListeners = new Set<RemovingListener>();

/** Register a non-destructive quiesce hook run before workspace movement. */
export function onConversationRemoving(listener: RemovingListener): () => void {
  removingListeners.add(listener);
  return () => removingListeners.delete(listener);
}

export function notifyConversationRemoving(conversationId: string): void {
  for (const listener of removingListeners) listener(conversationId);
}

export function onConversationRemoved(listener: RemovedListener): () => void {
  removedListeners.add(listener);
  return () => removedListeners.delete(listener);
}

export function notifyConversationRemoved(conversationId: string): void {
  for (const listener of removedListeners) listener(conversationId);
}

/** How an assistant turn ended, as turn-end listeners see it. */
export interface AssistantTurnEnd {
  convId: string;
  /** startedAt of the prompt that started the turn (a replay's is the prompt it replays). */
  promptStartedAt?: number;
  ok: boolean;
  blocks: readonly { type: string; text?: string }[];
  tokens: number;
  durationMs: number;
  error?: string;
  aborted?: boolean;
  /** Interrupted for a daemon restart: the next daemon replays it. */
  daemonRestart?: boolean;
  /** Ended at a deferred Chrono sleep: it continues later. */
  suspended?: boolean;
  /** A /compact turn, which asks the model nothing. */
  manualCompaction: boolean;
  /** Some of it ran on Claude API credits. */
  billing?: "api-credits";
  /** It ended because no route it may use could run it, and it may not wait (UsageLimitedError). */
  limited?: { resetAt: number | null };
  /** The whole turn as streamed: what an earlier job of it showed (before a daemon restart), then `blocks`. */
  turnBlocks?: readonly Block[];
}

type TurnEndedListener = (end: AssistantTurnEnd) => void;
const turnEndedListeners = new Set<TurnEndedListener>();

/** Told after every assistant turn ends, once its history is saved. */
export function onAssistantTurnEnded(listener: TurnEndedListener): () => void {
  turnEndedListeners.add(listener);
  return () => turnEndedListeners.delete(listener);
}

export function notifyAssistantTurnEnded(end: AssistantTurnEnd): void {
  for (const listener of turnEndedListeners) listener(end);
}

type LiveTurnRebasedListener = (convId: string) => void;
const liveTurnRebasedListeners = new Set<LiveTurnRebasedListener>();

/**
 * Told, right after the event that caused it, when a running turn's live view
 * cannot be followed by appending stream events alone: a stream started (also
 * a replay after a restart), or a streaming_sync replaced what was streamed.
 */
export function onLiveTurnRebased(listener: LiveTurnRebasedListener): () => void {
  liveTurnRebasedListeners.add(listener);
  return () => liveTurnRebasedListeners.delete(listener);
}

export function notifyLiveTurnRebased(convId: string): void {
  for (const listener of liveTurnRebasedListeners) listener(convId);
}
