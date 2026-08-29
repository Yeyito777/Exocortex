import type { AIMessage } from "./messages";
import type { RenderState } from "./state";
import { isDurablySleeping } from "./taskvisibility";

const CHRONO_SLEEP_TASK_PREFIX = "chrono:sleep:";

/**
 * Find the committed assistant message whose Chrono tool call currently owns a
 * durable sleep.
 *
 * A long sleep deliberately ends the provider stream, so the assistant message
 * has already moved from pendingAI into history and has a persisted endedAt.
 * The durable task id retains the matching tool-call id, which lets late-joining
 * and restarted TUIs recover the live metadata clock without local-only state.
 */
export function activeDurableSleepAssistant(state: RenderState): AIMessage | null {
  if (!state.convId || state.folderInstructionsDoc) return null;
  const conversation = state.sidebar?.conversations.find(candidate => candidate.id === state.convId);
  if (!conversation || !isDurablySleeping(conversation)) return null;

  const sleepTaskIds = new Set(
    (conversation.tasks ?? [])
      .filter(task => task.kind === "chrono" && task.chronoMode === "sleep")
      .map(task => task.id),
  );

  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.role !== "assistant" || !message.metadata) continue;
    const ownsSleep = message.blocks.some(block =>
      block.type === "tool_call"
      && block.toolName === "chrono"
      && sleepTaskIds.has(`${CHRONO_SLEEP_TASK_PREFIX}${block.toolCallId}`)
    );
    if (ownsSleep) return message;
  }

  return null;
}

/** Start time of the assistant metadata clock that remains live while sleeping. */
export function activeDurableSleepMetadataStartedAt(state: RenderState): number | null {
  return activeDurableSleepAssistant(state)?.metadata?.startedAt ?? null;
}

/** Cache generation for the live durable-sleep metadata label. */
export function durableSleepMetadataFrame(state: RenderState, now = Date.now()): number | null {
  const startedAt = activeDurableSleepMetadataStartedAt(state);
  return startedAt === null ? null : Math.max(0, Math.floor((now - startedAt) / 1000));
}
