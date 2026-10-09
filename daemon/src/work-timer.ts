import { continueWorkTimer } from "../../shared/src/work-timer";
export { resumeWorkTimer } from "../../shared/src/work-timer";
import { CONTEXT_COMPACTION_FINISHED_KIND, isRealUserMessage, REALTIME_TRANSCRIPT_KIND, type StoredMessage } from "./messages";
import { archiveWindow } from "./conversation-window";

/** Use canonical history, not the visible/paginated tail or the provider context. */
export function workTimerForTurn(messages: StoredMessage[], startedAt: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRealUserMessage(message) && !message.metadata?.automation) return startedAt;
    // A standalone/manual compaction may be the latest completed work even
    // though it has no assistant response. Its status marker preserves the clock.
    if (message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND
        && message.metadata.workTimerStartedAt !== undefined) {
      return continueWorkTimer(message.metadata, startedAt);
    }
    if (message.role !== "assistant" || !message.metadata) continue;
    if (message.metadata.kind === REALTIME_TRANSCRIPT_KIND) return startedAt;
    return continueWorkTimer(message.metadata, startedAt);
  }
  return continueWorkTimer(archiveWindow(messages)?.sparse?.workTimer ?? null, startedAt);
}
