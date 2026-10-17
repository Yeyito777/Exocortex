/**
 * Request ids that let a daemon `error` be correlated with the command it
 * answers. The daemon echoes a command's reqId on every error it reports for
 * that command, so encoding the owning identity in the id lets state handlers
 * settle exactly the optimistic UI that command created.
 */

const TURN_PREFIX = "turn_";
const QUEUE_PREFIX = "queue_message:";
const UNQUEUE_PREFIX = "unqueue_message:";

/** Turn-starting commands (send/new/replay/compact) carry their pendingAI start time. */
export function turnRequestId(startedAt: number, sequence: number): string {
  return `${TURN_PREFIX}${startedAt}_${sequence}`;
}

/** The pendingAI start time a turn-starting command was issued for, if `reqId` is one. */
export function turnRequestStartedAt(reqId: string | undefined): number | null {
  if (!reqId?.startsWith(TURN_PREFIX)) return null;
  const startedAt = Number(reqId.slice(TURN_PREFIX.length).split("_")[0]);
  return Number.isFinite(startedAt) ? startedAt : null;
}

/** Stable across replays, so a reconnect retry answers to the same id. */
export function queueRequestId(queueId: string): string {
  return `${QUEUE_PREFIX}${queueId}`;
}

export function unqueueRequestId(queueId: string): string {
  return `${UNQUEUE_PREFIX}${queueId}`;
}

/** The optimistic queue entry a failed enqueue was for. */
export function queueIdFromRequestId(reqId: string | undefined): string | null {
  return reqId?.startsWith(QUEUE_PREFIX) ? reqId.slice(QUEUE_PREFIX.length) || null : null;
}

/** The queue entry a failed unqueue targeted. */
export function unqueueIdFromRequestId(reqId: string | undefined): string | null {
  return reqId?.startsWith(UNQUEUE_PREFIX) ? reqId.slice(UNQUEUE_PREFIX.length) || null : null;
}
