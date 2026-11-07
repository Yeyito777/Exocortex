/**
 * Optimistic echo of the user's own direct sends.
 *
 * A send shows its bubble and pending response at once; over /ssh the daemon
 * confirms it a round trip later. Until then the echo is tracked here so that:
 * - a canonical snapshot taken before the daemon saw the send (a history
 *   refresh, a conversation open or reconnect load) does not wipe the bubble
 *   and spinner for that round trip;
 * - a rejected send never stays on screen looking sent. A send that lost the
 *   race to a turn the daemon started meanwhile (a notification, a wake) is
 *   queued for the end of that turn, as the queue prompt would have offered;
 *   any other rejection puts the text back in the prompt.
 *
 * The daemon confirms an accepted send with an ack carrying its turn request
 * id, a user_message echo carrying its startedAt, or (after waking a Chrono
 * sleep) a history snapshot that contains it, and rejects one with an error
 * carrying its turn request id.
 *
 * A send can be lost with its connection (a daemon restart, a dropped /ssh
 * link). It stays tracked across the reconnect: the client sends it again
 * (client.ts, unresolvedSendCommands) and the daemon runs it once.
 */

import { randomUUID } from "node:crypto";
import type { ImageAttachment, UserMessage } from "./messages";
import type { Command } from "./protocol";
import { createPendingAI } from "./messages";
import type { RenderState } from "./state";
import { clearPendingAI } from "./state";
import { turnRequestStartedAt } from "./request-ids";

export interface UnconfirmedSend {
  convId: string;
  startedAt: number;
  /** The echoed bubble, by reference. */
  message: UserMessage;
  sentAt: number;
}

/** A snapshot this much later than the send is authoritative even without a verdict. */
export const UNCONFIRMED_SEND_TTL_MS = 60_000;

/** The daemon's answer when a turn was already running at admission. */
export const ALREADY_STREAMING = "Already streaming";

export function trackDirectSend(state: RenderState, convId: string, message: UserMessage, now = Date.now()): void {
  const startedAt = message.metadata?.startedAt;
  if (typeof startedAt !== "number") return;
  state.unconfirmedSends = state.unconfirmedSends.filter(send => send.startedAt !== startedAt);
  state.unconfirmedSends.push({ convId, startedAt, message, sentAt: now });
}

/** The daemon acked the send `reqId` named. */
export function confirmDirectSendRequest(state: RenderState, convId: string | undefined, reqId: string | undefined): void {
  const startedAt = turnRequestStartedAt(reqId);
  if (convId && startedAt !== null) confirmDirectSend(state, convId, startedAt);
}

/** The daemon echoed (accepted) the send that started at `startedAt`. */
export function confirmDirectSend(state: RenderState, convId: string, startedAt: number | undefined): void {
  if (typeof startedAt !== "number" || state.unconfirmedSends.length === 0) return;
  state.unconfirmedSends = state.unconfirmedSends.filter(send => !(send.convId === convId && send.startedAt === startedAt));
}

/**
 * Another user turn (a notification, a queued message) reached the transcript
 * before the daemon answered this send. The daemon admits this send after it
 * or not at all, so its bubble stays last.
 */
export function keepUnconfirmedSendsLast(state: RenderState, convId: string): void {
  for (const send of state.unconfirmedSends) {
    if (send.convId !== convId) continue;
    const index = state.messages.indexOf(send.message);
    if (index === -1 || index === state.messages.length - 1) continue;
    state.messages.splice(index, 1);
    state.messages.push(send.message);
  }
}

/**
 * The client sent these again after reconnecting: their wait for a verdict
 * starts over, so a snapshot loaded now does not outlive them.
 */
export function noteResentDirectSends(state: RenderState, commands: readonly Command[], now = Date.now()): void {
  for (const command of commands) {
    if (command.type !== "send_message") continue;
    const send = state.unconfirmedSends.find(candidate => candidate.convId === command.convId && candidate.startedAt === command.startedAt);
    if (send) send.sentAt = now;
  }
}

/**
 * The TUI is switching to another daemon, and the client drops what it never
 * got an answer for: unconfirmed sends go back to the prompt.
 */
export function returnUnconfirmedSendsToPrompt(state: RenderState): number {
  const sends = state.unconfirmedSends;
  state.unconfirmedSends = [];
  for (const send of sends) {
    const index = state.messages.indexOf(send.message);
    if (index !== -1) state.messages.splice(index, 1);
    if (state.pendingAI?.metadata?.startedAt === send.startedAt && state.pendingAI.blocks.length === 0) clearPendingAI(state);
    restoreToPrompt(state, send.message);
  }
  return sends.length;
}

function restoreToPrompt(state: RenderState, message: UserMessage): void {
  const { text, images } = message;
  state.inputBuffer = state.inputBuffer ? `${state.inputBuffer}\n${text}` : text;
  state.cursorPos = state.inputBuffer.length;
  if (images?.length) state.pendingImages.push(...images);
}

/**
 * A canonical snapshot just replaced the open conversation's messages. Sends
 * it already contains are confirmed; the rest are put back at the tail, with
 * the pending response of the newest one when no turn is live.
 */
export function restoreUnconfirmedSends(state: RenderState, convId: string, now = Date.now()): boolean {
  if (state.unconfirmedSends.length === 0) return false;
  const canonicalStarts = new Set<number>();
  for (const message of state.messages) {
    if (message.role === "user" && typeof message.metadata?.startedAt === "number") canonicalStarts.add(message.metadata.startedAt);
  }
  let restored: UnconfirmedSend | null = null;
  state.unconfirmedSends = state.unconfirmedSends.filter((send) => {
    if (send.convId !== convId) return now - send.sentAt < UNCONFIRMED_SEND_TTL_MS;
    if (canonicalStarts.has(send.startedAt) && !state.messages.includes(send.message)) return false;
    if (now - send.sentAt >= UNCONFIRMED_SEND_TTL_MS) return false;
    if (!state.messages.includes(send.message)) state.messages.push(send.message);
    restored = send;
    return true;
  });
  const newest = restored as UnconfirmedSend | null;
  if (newest && !state.pendingAI) {
    state.pendingAI = createPendingAI(newest.startedAt, newest.message.metadata?.model ?? state.model);
  }
  return newest !== null;
}

/**
 * The daemon rejected a direct send. Its echo and the pending response it
 * created are withdrawn; returns the send, or null when `reqId` names none.
 */
export function takeRejectedDirectSend(state: RenderState, reqId: string | undefined): UnconfirmedSend | null {
  const startedAt = turnRequestStartedAt(reqId);
  if (startedAt === null) return null;
  const send = state.unconfirmedSends.find(candidate => candidate.startedAt === startedAt);
  if (!send) return null;
  state.unconfirmedSends = state.unconfirmedSends.filter(candidate => candidate !== send);
  const index = state.messages.indexOf(send.message);
  if (index !== -1) state.messages.splice(index, 1);
  // A turn the daemon started meanwhile may have taken over pendingAI.
  if (state.pendingAI?.metadata?.startedAt === startedAt && state.pendingAI.blocks.length === 0) clearPendingAI(state);
  return send;
}

export interface QueueRejectedSendActions {
  queueMessage?(convId: string, text: string, timing: "message-end", images: ImageAttachment[] | undefined, options: { queueId: string }): void;
}

/**
 * Settle a rejected direct send: queue it behind the turn that won the race,
 * or return it to the prompt. Returns what happened, or null if `reqId` named
 * no tracked send.
 */
export function settleRejectedDirectSend(
  state: RenderState,
  daemon: QueueRejectedSendActions,
  reqId: string | undefined,
  message: string,
): "queued" | "restored" | null {
  const send = takeRejectedDirectSend(state, reqId);
  if (!send) return null;
  const { text, images } = send.message;
  if (message === ALREADY_STREAMING && daemon.queueMessage) {
    const queueId = randomUUID();
    state.queuedMessages.push({ id: queueId, optimistic: true, convId: send.convId, text, timing: "message-end", images, source: "daemon", createdAt: Date.now() });
    daemon.queueMessage(send.convId, text, "message-end", images, { queueId });
    return "queued";
  }
  restoreToPrompt(state, send.message);
  return "restored";
}
