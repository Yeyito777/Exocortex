import { continueWorkTimer } from "../../shared/src/work-timer";
export { resumeWorkTimer } from "../../shared/src/work-timer";
import { CONTEXT_COMPACTION_FINISHED_KIND, isRealUserMessage, ownerRelayedText, type StoredMessage } from "./messages";
import { archiveWindow } from "./conversation-window";

/**
 * Whether a user message starts a new work stretch: the owner's own words
 * (typed, or relayed from Discord/WhatsApp) that arrived while the
 * conversation was idle. One that arrived during work, and any other
 * automated prompt, continues the stretch.
 */
function restartsWorkTimer(message: StoredMessage): boolean {
  const metadata = message.metadata;
  if (metadata?.arrivedWhileWorking) return false;
  if (!metadata?.automation) return true;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
  return ownerRelayedText(text, metadata) !== null;
}

/** Use canonical history, not the visible/paginated tail or the provider context. */
export function workTimerForTurn(messages: StoredMessage[], startedAt: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (isRealUserMessage(message) && restartsWorkTimer(message)) return startedAt;
    // A standalone/manual compaction may be the latest completed work even
    // though it has no assistant response. Its status marker preserves the clock.
    if (message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND
        && message.metadata.workTimerStartedAt !== undefined) {
      return continueWorkTimer(message.metadata, startedAt);
    }
    if (message.role !== "assistant" || !message.metadata) continue;
    return continueWorkTimer(message.metadata, startedAt);
  }
  return continueWorkTimer(archiveWindow(messages)?.sparse?.workTimer ?? null, startedAt);
}
