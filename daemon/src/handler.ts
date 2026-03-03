/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands and orchestrates the agent loop.
 * Conversation state lives in conversations.ts.
 * System prompt lives in system.ts.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import { runAgentLoop, type AgentCallbacks } from "./agent";
import { buildSystemPrompt } from "./system";
import * as convStore from "./conversations";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import type { ModelId, Block, ApiMessage } from "./messages";

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
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
        await handleSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt);
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

// ── Send message orchestration ──────────────────────────────────────

async function handleSendMessage(
  server: DaemonServer,
  client: ConnectedClient,
  reqId: string | undefined,
  convId: string,
  text: string,
  startedAt: number,
): Promise<void> {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Not authenticated. Run: bun run login (in daemon/)" });
    return;
  }

  const conv = convStore.get(convId);
  if (!conv) {
    server.sendTo(client, { type: "error", reqId, convId, message: `Conversation ${convId} not found` });
    return;
  }
  if (convStore.isStreaming(convId)) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Already streaming" });
    return;
  }

  conv.messages.push({ role: "user", content: text });

  const ac = new AbortController();
  convStore.setActiveJob(convId, ac);

  server.broadcast({ type: "streaming_started", convId, model: conv.model });

  const apiMessages: ApiMessage[] = conv.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const callbacks: AgentCallbacks = {
    onBlockStart(blockType) {
      server.sendToSubscribers(convId, { type: "block_start", convId, blockType });
    },
    onTextChunk(chunk) {
      server.sendToSubscribers(convId, { type: "text_chunk", convId, text: chunk });
    },
    onThinkingChunk(chunk) {
      server.sendToSubscribers(convId, { type: "thinking_chunk", convId, text: chunk });
    },
    onToolCall(block) {
      server.sendToSubscribers(convId, {
        type: "tool_call", convId,
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
        summary: block.summary,
      });
    },
    onToolResult(block) {
      server.sendToSubscribers(convId, {
        type: "tool_result", convId,
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        output: block.output,
        isError: block.isError,
      });
    },
    onTokensUpdate(tokens) {
      server.sendToSubscribers(convId, { type: "tokens_update", convId, tokens });
    },
  };

  try {
    const result = await runAgentLoop(apiMessages, conv.model, callbacks, {
      system: buildSystemPrompt(),
      signal: ac.signal,
    });

    const textContent = result.blocks
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map(b => b.text)
      .join("\n");

    conv.messages.push({ role: "assistant", content: textContent });

    const endedAt = Date.now();
    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      blocks: result.blocks,
      endedAt,
    });

    log("info", `handler: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

  } catch (err) {
    if (!ac.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `handler: stream error for ${convId}: ${msg}`);
      server.sendToSubscribers(convId, { type: "error", convId, message: msg });
    } else {
      log("info", `handler: stream interrupted for ${convId}`);
    }
  } finally {
    convStore.clearActiveJob(convId);
    server.broadcast({ type: "streaming_stopped", convId });
  }
}
