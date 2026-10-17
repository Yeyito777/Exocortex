/** Ending a turn suspended in a deferred Chrono sleep/wait without starting another. */
import { cancelDeferredChronoSleep } from "./chrono-service";
import { broadcastConversationHistoryUpdated } from "./conversation-events";
import { getSubagentNotificationRuntime } from "./subagent-notifications";
import type { DaemonServer } from "./server";

/**
 * Stop, a goal pause/time limit and `exo abort` close the pending tool call.
 * No turn finalizer runs for a suspended turn, so settle its parent
 * notification here as an abort; otherwise the parent's task stays "running"
 * forever and the next boot replays the stopped child.
 */
export function cancelSuspendedTurn(server: DaemonServer, convId: string): boolean {
  if (!cancelDeferredChronoSleep(convId)) return false;
  broadcastConversationHistoryUpdated(server, convId);
  getSubagentNotificationRuntime(server)?.complete(convId, { ok: false, aborted: true, blocks: [] });
  return true;
}
