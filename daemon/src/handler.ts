/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands to the appropriate action. Thin dispatcher —
 * orchestration lives in orchestrator.ts, conversation data
 * transformations live in conversations.ts.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import { fetchUsage, parseUsageHeaders } from "./usage";
import { orchestrateSendMessage } from "./orchestrator";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import type { ModelId, UsageData } from "./messages";

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  let lastUsage: UsageData | null = null;

  /** Fetch usage and broadcast to all clients. */
  function refreshUsage(): void {
    const auth = loadAuth();
    if (!auth?.tokens?.accessToken) return;
    fetchUsage(auth.tokens.accessToken).then((usage) => {
      if (usage) {
        lastUsage = usage;
        server.broadcast({ type: "usage_update", usage });
      }
    });
  }

  /** Update usage from streaming response headers and broadcast. */
  function handleHeaders(headers: Headers): void {
    const usage = parseUsageHeaders(headers, lastUsage);
    if (usage) {
      lastUsage = usage;
      server.broadcast({ type: "usage_update", usage });
    }
  }

  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        if (lastUsage) {
          server.sendTo(client, { type: "usage_update", usage: lastUsage });
        }
        server.sendTo(client, { type: "conversations_list", conversations: convStore.listSummaries() });
        refreshUsage();
        break;
      }

      case "new_conversation": {
        const id = convStore.generateId();
        const model = cmd.model ?? "sonnet";
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
          { onHeaders: handleHeaders, onComplete: refreshUsage },
        );
        break;
      }

      case "list_conversations": {
        const conversations = convStore.listSummaries();
        server.sendTo(client, { type: "conversations_list", reqId: cmd.reqId, conversations });
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
        });
        server.subscribe(client, data.convId);
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
