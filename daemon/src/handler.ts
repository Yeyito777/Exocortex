/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands to the appropriate action. Thin dispatcher —
 * orchestration lives in orchestrator.ts, conversation data
 * transformations live in conversations.ts, usage state lives
 * in usage.ts.
 */

import { log } from "./log";
import { refreshUsage, handleUsageHeaders, getLastUsage } from "./usage";
import { orchestrateSendMessage } from "./orchestrator";
import { getToolDisplayInfo } from "./tools/registry";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  const broadcastUsage = (usage: import("./messages").UsageData) => {
    server.broadcast({ type: "usage_update", usage });
  };

  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        server.sendTo(client, { type: "tools_available", tools: getToolDisplayInfo() });
        const lastUsage = getLastUsage();
        if (lastUsage) {
          server.sendTo(client, { type: "usage_update", usage: lastUsage });
        }
        server.sendTo(client, { type: "conversations_list", conversations: convStore.listSummaries() });
        refreshUsage(broadcastUsage);
        break;
      }

      case "new_conversation": {
        const id = convStore.generateId();
        const model = cmd.model ?? "opus";
        convStore.create(id, model);
        log("info", `handler: created conversation ${id} (model=${model})`);

        server.sendTo(client, {
          type: "conversation_created",
          reqId: cmd.reqId,
          convId: id,
          model,
        });
        server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(id)! });
        break;
      }

      case "subscribe": {
        server.subscribe(client, cmd.convId);
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(cmd.convId)) {
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }
      case "unsubscribe": {
        server.unsubscribe(client, cmd.convId);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "abort": {
        const ac = convStore.getActiveJob(cmd.convId);
        if (ac) {
          ac.abort();
          log("info", `handler: abort requested for ${cmd.convId}`);
        }
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        break;
      }

      case "send_message": {
        await orchestrateSendMessage(
          server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt,
          {
            onHeaders: (h) => handleUsageHeaders(h, broadcastUsage),
            onComplete: () => refreshUsage(broadcastUsage),
          },
          cmd.images,
        );
        break;
      }

      case "set_model": {
        const ok = convStore.setModel(cmd.convId, cmd.model);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          log("info", `handler: model set to ${cmd.model} for ${cmd.convId}`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "list_conversations": {
        const conversations = convStore.listSummaries();
        server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, conversations });
        break;
      }

      case "delete_conversation": {
        const ok = convStore.remove(cmd.convId);
        if (ok) {
          log("info", `handler: deleted conversation ${cmd.convId}`);
          server.broadcast({ type: "conversation_deleted", convId: cmd.convId });
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "mark_conversation": {
        const ok = convStore.mark(cmd.convId, cmd.marked);
        if (ok) {
          server.broadcast({ type: "conversation_marked", convId: cmd.convId, marked: cmd.marked });
        }
        break;
      }

      case "pin_conversation": {
        const ok = convStore.pin(cmd.convId, cmd.pinned);
        if (ok) {
          server.broadcast({ type: "conversation_pinned", convId: cmd.convId, pinned: cmd.pinned });
          // Broadcast full list so all clients get the updated sortOrder
          server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
        }
        break;
      }

      case "move_conversation": {
        const ok = convStore.move(cmd.convId, cmd.direction);
        if (ok) {
          server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
        }
        break;
      }

      case "rename_conversation": {
        const ok = convStore.rename(cmd.convId, cmd.title);
        if (ok) {
          server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(cmd.convId)! });
          log("info", `handler: renamed conversation ${cmd.convId} to "${cmd.title}"`);
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "clone_conversation": {
        const cloned = convStore.clone(cmd.convId);
        if (cloned) {
          const summary = convStore.getSummary(cloned.id);
          if (summary) {
            log("info", `handler: cloned conversation ${cmd.convId} → ${cloned.id}`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
          }
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
        }
        break;
      }

      case "undo_delete": {
        const restored = convStore.undoDelete();
        if (restored) {
          const summary = convStore.getSummary(restored.id);
          if (summary) {
            log("info", `handler: restored conversation ${restored.id} from trash`);
            server.broadcast({ type: "conversation_restored", reqId: cmd.reqId, summary });
            server.broadcast({ type: "conversation_moved", conversations: convStore.listSummaries() });
          }
        } else {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, message: "Nothing to undo" });
        }
        break;
      }

      case "queue_message": {
        convStore.pushQueuedMessage(cmd.convId, cmd.text, cmd.timing);
        server.sendTo(client, { type: "ack", reqId: cmd.reqId, convId: cmd.convId });
        log("info", `handler: queued ${cmd.timing} message for ${cmd.convId}: "${cmd.text.slice(0, 50)}"`);
        break;
      }

      case "load_conversation": {
        const data = convStore.getDisplayData(cmd.convId);
        if (!data) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        const queued = convStore.getQueuedMessages(data.convId);
        server.sendTo(client, {
          type: "conversation_loaded",
          reqId: cmd.reqId,
          convId: data.convId,
          model: data.model,
          entries: data.entries,
          contextTokens: data.contextTokens,
          queuedMessages: queued.length > 0 ? queued : undefined,
        });
        server.subscribe(client, data.convId);
        // If the conversation is actively streaming, tell the late-joining client
        // so it creates pendingAI and picks up future chunks.
        if (convStore.isStreaming(data.convId)) {
          server.sendTo(client, {
            type: "streaming_started",
            convId: data.convId,
            model: data.model,
            startedAt: convStore.getStreamingStartedAt(data.convId) ?? Date.now(),
            blocks: convStore.getStreamingBlocks(data.convId) ?? [],
          });
        }
        // Clear unread when a client views the conversation
        if (convStore.clearUnread(data.convId)) {
          server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(data.convId)! });
        }
        break;
      }

      default: {
        server.sendTo(client, {
          type: "error",
          reqId: (cmd as any).reqId,
          message: `Unknown command: ${(cmd as any).type}`,
        });
      }
    }
  };
}
