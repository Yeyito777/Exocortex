/**
 * Streaming orchestration for exocortexd.
 *
 * Wires the agent loop to the IPC layer: sets up callbacks,
 * runs the loop, handles errors/abort, flushes persistence,
 * and broadcasts events. The only file that connects agent.ts
 * to the server's event dispatch.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import { runAgentLoop, type AgentCallbacks } from "./agent";
import { buildSystemPrompt } from "./system";
import * as convStore from "./conversations";
import type { DaemonServer, ConnectedClient } from "./server";
import type { Block, ApiMessage } from "./messages";

// ── Types ──────────────────────────────────────────────────────────

export interface OrchestrationCallbacks {
  /** Called with response headers (for usage/rate-limit parsing). */
  onHeaders(headers: Headers): void;
  /** Called after the message completes (for usage refresh). */
  onComplete(): void;
}

// ── Orchestrate a send_message ─────────────────────────────────────

export async function orchestrateSendMessage(
  server: DaemonServer,
  client: ConnectedClient,
  reqId: string | undefined,
  convId: string,
  text: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
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

  conv.messages.push({ role: "user", content: text, metadata: null });

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
      convStore.markDirty(convId);
      convStore.flush(convId);
      convStore.resetChunkCounter(convId);
    },
    onTextChunk(chunk) {
      server.sendToSubscribers(convId, { type: "text_chunk", convId, text: chunk });
      convStore.onChunk(convId);
    },
    onThinkingChunk(chunk) {
      server.sendToSubscribers(convId, { type: "thinking_chunk", convId, text: chunk });
      convStore.onChunk(convId);
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
    onContextUpdate(contextTokens) {
      server.sendToSubscribers(convId, { type: "context_update", convId, contextTokens });
    },
    onHeaders: ext.onHeaders,
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

    const endedAt = Date.now();

    conv.messages.push({
      role: "assistant",
      content: textContent,
      metadata: {
        startedAt,
        endedAt,
        model: conv.model,
        tokens: result.tokens,
      },
    });
    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      blocks: result.blocks,
      endedAt,
    });

    log("info", `orchestrator: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

    // Persist and notify sidebar
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });

  } catch (err) {
    if (!ac.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `orchestrator: stream error for ${convId}: ${msg}`);
      server.sendToSubscribers(convId, { type: "error", convId, message: msg });
    } else {
      log("info", `orchestrator: stream interrupted for ${convId}`);
    }
  } finally {
    convStore.clearActiveJob(convId);
    convStore.resetChunkCounter(convId);
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.broadcast({ type: "streaming_stopped", convId });
    ext.onComplete();
  }
}
