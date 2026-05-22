/**
 * Helpers for broadcasting conversation-related daemon events.
 *
 * Keep the runtime null check here so callers do not accidentally turn a
 * missing conversation into `{ summary: null }`, which violates the IPC
 * protocol and can crash older clients.
 */

import * as convStore from "./conversations";
import { log } from "./log";
import type { DaemonServer } from "./server";
import type { StreamingStopReason } from "./protocol";

/** Broadcast a sidebar summary update if the conversation still exists. */
export function broadcastConversationUpdated(server: DaemonServer, convId: string, streamStopReason?: StreamingStopReason): boolean {
  const summary = convStore.getSummary(convId);
  if (!summary) {
    log("warn", `conversation-events: skipped conversation_updated for missing conversation ${convId}`);
    return false;
  }

  server.broadcast({
    type: "conversation_updated",
    summary,
    ...(streamStopReason ? { streamStopReason } : {}),
  });
  return true;
}
