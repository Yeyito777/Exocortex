import { CONTEXT_COMPACTION_FINISHED_KIND, isRealUserMessage, type StoredMessage } from "./messages";

/**
 * Work timer origin for a turn replayed after a daemon restart interrupted it.
 * The conversation never went idle, so the interrupted run's timer continues,
 * without charging the downtime. When the interrupted turn left no work after
 * its prompt, the replay starts a fresh timer.
 */
export function interruptedRunWorkTimer(messages: StoredMessage[], resumedAt: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRealUserMessage(message)) return resumedAt;
    const metadata = message.metadata;
    // A standalone compaction may be the latest work. Its marker carries the timer.
    const compaction = metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND && metadata.workTimerStartedAt !== undefined;
    if (message.role !== "assistant" && !compaction) continue;
    if (metadata?.workTimerStartedAt === undefined || metadata.endedAt == null) return resumedAt;
    return resumedAt - Math.max(0, metadata.endedAt - metadata.workTimerStartedAt);
  }
  return resumedAt;
}
