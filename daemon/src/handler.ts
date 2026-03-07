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
        }
        break;
      }

      case "load_conversation": {
        const data = convStore.getDisplayData(cmd.convId);
        if (!data) {
          server.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} not found` });
          break;
        }
        server.sendTo(client, {
          type: "conversation_loaded",
          reqId: cmd.reqId,
          convId: data.convId,
          model: data.model,
          aiMessages: data.aiMessages,
          userMessages: data.userMessages,
          systemMessages: data.systemMessages,
          contextTokens: data.contextTokens,
        });
        server.subscribe(client, data.convId);
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
