/**
 * Helpers for broadcasting conversation-related daemon events.
 *
 * Keep the runtime null check here so callers do not accidentally turn a
 * missing conversation into `{ summary: null }`, which violates the IPC
 * protocol and can crash older clients.
 */

import * as convStore from "./conversations";
import { buildHistoryUpdatedEvents } from "./history-pagination";
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

/** Rebuild the canonical history shown by every subscriber of a conversation. */
export function broadcastConversationHistoryUpdated(server: DaemonServer, convId: string): boolean {
  const snapshot = convStore.getRenderSnapshot(convId, false);
  if (!snapshot) return false;
  const events = buildHistoryUpdatedEvents(snapshot);
  server.sendHistoryUpdatedToSubscribers(convId, events.legacy, events.paginated);
  return true;
}

/** Notify clients after a conversation instruction document changes. */
export function broadcastConversationInstructionsUpdated(server: DaemonServer, convId: string, text: string): void {
  server.broadcast({ type: "system_instructions_updated", convId, text });
  broadcastConversationUpdated(server, convId);
  broadcastConversationHistoryUpdated(server, convId);
}

/** Notify clients after a folder instruction document changes. */
export function broadcastFolderInstructionsUpdated(server: DaemonServer, folderId: string, text: string, reqId?: string): void {
  server.broadcast({ type: "folder_instructions_updated", reqId, folderId, text });
  server.broadcast({ type: "conversation_moved", ...convStore.listSidebarState() });
  for (const convId of convStore.listFolderConversationIds(folderId)) {
    broadcastConversationHistoryUpdated(server, convId);
  }
}
