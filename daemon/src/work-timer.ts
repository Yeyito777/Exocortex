import { LONG_CHRONO_SLEEP_THRESHOLD_MS } from "@exocortex/shared/chrono";
import { CONTEXT_COMPACTION_FINISHED_KIND, isRealUserMessage, type StoredMessage } from "./messages";

/**
 * Whether a Chrono sleep or wait really was long: only then does the work after
 * it start a new timer. A long limit can end at once (a wait whose task
 * finished, a sleep something woke), and that does not end the run.
 */
export function sleptLong(sleptAt: number, wokeAt: number): boolean {
  return wokeAt - sleptAt > LONG_CHRONO_SLEEP_THRESHOLD_MS;
}

/**
 * Work timer origin for a turn replayed after a daemon restart interrupted it
 * or a short sleep suspended it. The run never really ended, so its timer
 * continues, without charging the gap. When the interrupted turn left no work
 * after its prompt, the replay starts a fresh timer.
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
