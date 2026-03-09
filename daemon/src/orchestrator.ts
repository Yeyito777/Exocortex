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
import { runAgentLoop, type AgentCallbacks, type AgentState } from "./agent";
import { buildSystemPrompt } from "./system";
import { getToolDefs, buildExecutor, summarizeTool } from "./tools/registry";
import * as convStore from "./conversations";
import type { DaemonServer, ConnectedClient } from "./server";
import type { StoredMessage } from "./messages";

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
  conv.updatedAt = Date.now();
  convStore.bumpToTop(convId);

  // Notify other subscribers about the user message (sender already added it locally)
  server.sendToSubscribersExcept(convId, { type: "user_message", convId, text }, client);

  const ac = new AbortController();
  convStore.setActiveJob(convId, ac, startedAt);
  convStore.initStreamingBlocks(convId);

  // Broadcast sidebar update (user message preview + streaming indicator)
  server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });
  server.sendToSubscribers(convId, { type: "streaming_started", convId, model: conv.model, startedAt });

  // System messages are persisted but never sent to the AI
  const apiMessages = conv.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

  // Agent state for abort recovery — the agent populates completedMessages
  // after each full round. partialContent tracks the in-flight round only
  // (cleared via onRoundComplete between rounds).
  const agentState: AgentState = { completedMessages: [], completedBlocks: [], tokens: 0 };
  const partialContent: import("./messages").ApiContentBlock[] = [];
  /** Blocks that survived persistence on abort/error — sent to TUI so it can trim display. */
  let abortPersistedBlocks: import("./messages").Block[] | undefined;

  const callbacks: AgentCallbacks = {
    onBlockStart(blockType) {
      server.sendToSubscribers(convId, { type: "block_start", convId, blockType });
      if (blockType === "text") {
        partialContent.push({ type: "text", text: "" });
      } else if (blockType === "thinking") {
        partialContent.push({ type: "thinking", thinking: "", signature: "" });
      }
      // Track for late-joining clients
      convStore.pushStreamingBlock(convId, { type: blockType, text: "" });
      convStore.markDirty(convId);
      convStore.flush(convId);
      convStore.resetChunkCounter(convId);
    },
    onTextChunk(chunk) {
      server.sendToSubscribers(convId, { type: "text_chunk", convId, text: chunk });
      const last = partialContent[partialContent.length - 1];
      if (last?.type === "text") last.text += chunk;
      convStore.appendToStreamingBlock(convId, "text", chunk);
      convStore.onChunk(convId);
    },
    onThinkingChunk(chunk) {
      server.sendToSubscribers(convId, { type: "thinking_chunk", convId, text: chunk });
      const last = partialContent[partialContent.length - 1];
      if (last?.type === "thinking") last.thinking += chunk;
      convStore.appendToStreamingBlock(convId, "thinking", chunk);
      convStore.onChunk(convId);
    },
    onSignature(signature) {
      for (let i = partialContent.length - 1; i >= 0; i--) {
        if (partialContent[i].type === "thinking") {
          (partialContent[i] as { type: "thinking"; thinking: string; signature: string }).signature = signature;
          break;
        }
      }
    },
    onToolCall(block) {
      server.sendToSubscribers(convId, {
        type: "tool_call", convId,
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
        summary: block.summary,
      });
      convStore.pushStreamingBlock(convId, {
        type: "tool_call",
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
      convStore.pushStreamingBlock(convId, {
        type: "tool_result",
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
      conv.lastContextTokens = contextTokens;
      server.sendToSubscribers(convId, { type: "context_update", convId, contextTokens });
    },
    onHeaders: ext.onHeaders,
    onRetry(attempt, maxAttempts, errorMessage, delaySec) {
      // Transient stream error → clear partial state so the retry starts clean
      partialContent.length = 0;
      convStore.initStreamingBlocks(convId);
      // Persist as system message (survives reload) + send live event (clears TUI blocks immediately)
      const sysText = `⟳ ${errorMessage} — retrying in ${delaySec}s (${attempt}/${maxAttempts})…`;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      convStore.markDirty(convId);
      server.sendToSubscribers(convId, { type: "stream_retry", convId, attempt, maxAttempts, errorMessage, delaySec });
    },
    onRoundComplete() {
      // Clear partial content — completed rounds are tracked via agentState.completedMessages.
      // Without this, partialContent accumulates across rounds and abort would double-persist.
      partialContent.length = 0;
    },
  };

  try {
    const result = await runAgentLoop(apiMessages, conv.model, callbacks, {
      system: buildSystemPrompt(),
      signal: ac.signal,
      tools: getToolDefs(),
      executor: buildExecutor(),
      summarizer: (name, input) => {
        const s = summarizeTool(name, input);
        return s.detail || s.label;
      },
      state: agentState,
    });

    const endedAt = Date.now();

    // Convert ApiMessage[] → StoredMessage[], stamp metadata on last assistant
    const storedMessages: StoredMessage[] = result.newMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: null,
    }));
    const lastAssistant = [...storedMessages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      lastAssistant.metadata = {
        startedAt,
        endedAt,
        model: conv.model,
        tokens: result.tokens,
      };
    }

    // Push the actual conversation messages — preserves the full
    // multi-turn structure (assistant → user[tool_result] → assistant → ...)
    conv.messages.push(...storedMessages);
    conv.updatedAt = Date.now();
    convStore.bumpToTop(convId);

    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      blocks: result.blocks,
      endedAt,
      tokens: result.tokens,
    });

    log("info", `orchestrator: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

    // Mark unread if no client is viewing this conversation
    if (!server.hasSubscribers(convId)) {
      convStore.markUnread(convId);
    }

    // Persist and notify sidebar
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });

  } catch (err) {
    const isAbort = ac.signal.aborted;

    if (!isAbort) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `orchestrator: stream error for ${convId}: ${msg}`);
      server.sendToSubscribers(convId, { type: "error", convId, message: msg });
    } else {
      log("info", `orchestrator: stream interrupted for ${convId}`);
    }

    // Persist completed rounds from the agent (full tool-use exchanges).
    if (agentState.completedMessages.length > 0) {
      const stored: StoredMessage[] = agentState.completedMessages.map(m => ({
        role: m.role,
        content: m.content,
        metadata: null,
      }));
      // Stamp metadata on the last completed assistant — mirrors the success path.
      // Without this, when a tool round completed before abort took effect,
      // onRoundComplete cleared partialContent and metadata would be lost.
      const lastAssistant = [...stored].reverse().find(m => m.role === "assistant");
      if (lastAssistant) {
        lastAssistant.metadata = {
          startedAt,
          endedAt: Date.now(),
          model: conv.model,
          tokens: agentState.tokens,
        };
      }
      conv.messages.push(...stored);
    }

    // Persist the in-flight partial response (current round's streamed content).
    // Strip thinking blocks with missing signatures — API rejects them on replay.
    const safeContent = partialContent.filter(b => {
      if (b.type === "thinking") return b.signature && b.signature.length > 0;
      return true;
    });
    const hasContent = safeContent.some(b =>
      (b.type === "text" && b.text) || (b.type === "thinking" && b.thinking)
    );
    // Convert safe content to display blocks for the TUI.
    // Start with blocks from fully completed rounds (already persisted via
    // completedMessages above), then append any salvageable in-flight content.
    const partialBlocks: import("./messages").Block[] = safeContent
      .filter(b => (b.type === "text" && b.text) || (b.type === "thinking" && b.thinking))
      .map(b => {
        if (b.type === "thinking") return { type: "thinking" as const, text: b.thinking };
        if (b.type === "text") return { type: "text" as const, text: b.text };
        return { type: "text" as const, text: "" };
      });
    abortPersistedBlocks = [...agentState.completedBlocks, ...partialBlocks];

    if (hasContent) {
      conv.messages.push({
        role: "assistant",
        content: safeContent,
        metadata: {
          startedAt,
          endedAt: Date.now(),
          model: conv.model,
          tokens: agentState.tokens,
        },
      });
    }

    // Persist and broadcast system message
    if (isAbort) {
      const sysText = "✗ Interrupted";
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: sysText, color: "error" });
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sysText = `✗ ${errMsg}`;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: sysText, color: "error" });
    }
  } finally {
    convStore.clearActiveJob(convId);
    convStore.clearStreamingBlocks(convId);
    convStore.resetChunkCounter(convId);
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.sendToSubscribers(convId, { type: "streaming_stopped", convId, persistedBlocks: abortPersistedBlocks });
    // Broadcast updated summary (streaming=false, possibly unread=true)
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });
    ext.onComplete();
  }
}
