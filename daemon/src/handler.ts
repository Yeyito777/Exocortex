/**
 * Command handler for exocortexd.
 *
 * Routes IPC commands, manages in-memory conversation state,
 * and drives the agent loop for AI responses.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import { AuthError, type ApiMessage } from "./api";
import { runAgentLoop, type AgentCallbacks } from "./agent";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import {
  type ModelId, type Block, type Conversation,
  createConversation,
} from "./messages";

// ── Conversation state ──────────────────────────────────────────────

const conversations = new Map<string, Conversation>();
const activeJobs = new Map<string, AbortController>();

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── System prompt ───────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return [
    `You are an AI assistant. You are helpful, harmless, and honest.`,
    ``,
    `Environment:`,
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
  ].join("\n");
}

// ── Handler ─────────────────────────────────────────────────────────

export function createHandler(server: DaemonServer) {
  return async function handleCommand(client: ConnectedClient, cmd: Command): Promise<void> {
    switch (cmd.type) {

      case "ping": {
        server.sendTo(client, { type: "pong", reqId: cmd.reqId });
        break;
      }

      case "new_conversation": {
        const id = generateId();
        const model = cmd.model ?? "sonnet";
        const conv = createConversation(id, model);
        conversations.set(id, conv);
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
        const ac = activeJobs.get(cmd.convId);
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

// ── Send message handler ────────────────────────────────────────────

async function handleSendMessage(
  server: DaemonServer,
  client: ConnectedClient,
  reqId: string | undefined,
  convId: string,
  text: string,
  startedAt: number,
): Promise<void> {
  // Auth check
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Not authenticated. Run: bun run login (in daemon/)" });
    return;
  }

  // Find conversation
  const conv = conversations.get(convId);
  if (!conv) {
    server.sendTo(client, { type: "error", reqId, convId, message: `Conversation ${convId} not found` });
    return;
  }
  if (conv.streaming) {
    server.sendTo(client, { type: "error", reqId, convId, message: "Already streaming" });
    return;
  }

  // Add user message
  conv.messages.push({ role: "user", content: text });

  // Set up abort
  const ac = new AbortController();
  activeJobs.set(convId, ac);
  conv.streaming = true;
  conv.abortController = ac;

  server.broadcast({ type: "streaming_started", convId, model: conv.model });

  // Build API messages from stored conversation
  const apiMessages: ApiMessage[] = conv.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Wire callbacks to IPC events
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
  };

  try {
    const result = await runAgentLoop(apiMessages, conv.model, callbacks, {
      system: buildSystemPrompt(),
      signal: ac.signal,
    });

    // Store assistant response: extract text blocks for simple storage,
    // but keep full block data available for the complete event
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
      model: result.model,
      tokens: result.tokens,
      endedAt,
    });

    log("info", `handler: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `handler: stream error for ${convId}: ${msg}`);
    server.sendToSubscribers(convId, { type: "error", convId, message: msg });
  } finally {
    activeJobs.delete(convId);
    conv.streaming = false;
    conv.abortController = null;
    server.broadcast({ type: "streaming_stopped", convId });
  }
}
