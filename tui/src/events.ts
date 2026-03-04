/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { isStreaming } from "./state";
import { createPendingAI, ensureCurrentBlock } from "./messages";
import { updateConversationList, updateConversation } from "./sidebar";
import { theme } from "./theme";
import type { Event } from "./protocol";
import type { AIMessage } from "./messages";

// ── Daemon actions interface ────────────────────────────────────────
// Minimal interface so this file doesn't depend on DaemonClient.

export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number): void;
}

// ── Pending state for conversation creation flow ────────────────────

export interface PendingSend {
  active: boolean;
  text: string;
}

// ── Pending errors buffer ───────────────────────────────────────────

export interface ErrorBuffer {
  errors: string[];
}

// ── Event handler ───────────────────────────────────────────────────

export function handleEvent(
  event: Event,
  state: RenderState,
  daemon: DaemonActions,
  pendingSend: PendingSend,
  errorBuffer: ErrorBuffer,
): void {
  switch (event.type) {
    case "conversation_created": {
      state.convId = event.convId;
      state.model = event.model;
      daemon.subscribe(event.convId);

      // If we had a pending message, send it now
      if (pendingSend.active && pendingSend.text && state.pendingAI) {
        daemon.sendMessage(event.convId, pendingSend.text, state.pendingAI.metadata.startedAt);
        pendingSend.text = "";
        pendingSend.active = false;
      }
      break;
    }

    case "streaming_started": {
      if (event.convId !== state.convId) break;
      state.scrollOffset = 0;
      break;
    }

    case "block_start": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        state.pendingAI.blocks.push({ type: event.blockType, text: "" });
      }
      break;
    }

    case "text_chunk": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        const block = ensureCurrentBlock(state.pendingAI, "text");
        if (block.type === "text") block.text += event.text;
      }
      state.scrollOffset = 0;
      break;
    }

    case "thinking_chunk": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        const block = ensureCurrentBlock(state.pendingAI, "thinking");
        if (block.type === "thinking") block.text += event.text;
      }
      break;
    }

    case "tool_call": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        state.pendingAI.blocks.push({
          type: "tool_call",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          input: event.input,
          summary: event.summary,
        });
      }
      break;
    }

    case "tool_result": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        state.pendingAI.blocks.push({
          type: "tool_result",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: event.output,
          isError: event.isError,
        });
      }
      break;
    }

    case "tokens_update": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        state.pendingAI.metadata.tokens = event.tokens;
      }
      break;
    }

    case "context_update": {
      if (event.convId !== state.convId) break;
      state.contextTokens = event.contextTokens;
      break;
    }

    case "message_complete": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI) {
        state.pendingAI.metadata.endedAt = event.endedAt;
        state.messages.push(state.pendingAI);
        state.pendingAI = null;
      }
      break;
    }

    case "streaming_stopped": {
      if (event.convId !== state.convId) break;
      const wasInterrupted = state.pendingAI !== null;
      if (state.pendingAI && state.pendingAI.blocks.length > 0) {
        state.pendingAI.metadata.endedAt ??= Date.now();
        state.messages.push(state.pendingAI);
      }
      state.pendingAI = null;

      // Flush errors that arrived during streaming (after the AI message)
      for (const msg of errorBuffer.errors) {
        state.messages.push({ role: "system", text: `✗ ${msg}`, color: theme.error, metadata: null });
      }
      errorBuffer.errors = [];

      if (wasInterrupted) {
        state.messages.push({ role: "system", text: "✗ Interrupted", color: theme.error, metadata: null });
      }
      break;
    }

    case "error": {
      if (isStreaming(state)) {
        errorBuffer.errors.push(event.message);
      } else {
        state.messages.push({ role: "system", text: `✗ ${event.message}`, color: theme.error, metadata: null });
      }
      break;
    }

    case "usage_update": {
      state.usage = event.usage;
      break;
    }

    case "conversations_list": {
      updateConversationList(state.sidebar, event.conversations);
      break;
    }

    case "conversation_updated": {
      updateConversation(state.sidebar, event.summary);
      break;
    }

    case "conversation_loaded": {
      // Unsubscribe from old conversation before switching
      if (state.convId && state.convId !== event.convId) {
        daemon.unsubscribe(state.convId);
      }
      state.messages = [];
      state.pendingAI = null;
      state.convId = event.convId;
      state.model = event.model;
      state.scrollOffset = 0;
      state.contextTokens = event.contextTokens;

      const totalPairs = Math.max(event.userMessages.length, event.aiMessages.length);
      let userIdx = 0;
      let aiIdx = 0;
      for (let i = 0; i < totalPairs; i++) {
        if (userIdx < event.userMessages.length) {
          state.messages.push({ role: "user", text: event.userMessages[userIdx], metadata: null });
          userIdx++;
        }
        if (aiIdx < event.aiMessages.length) {
          const loaded = event.aiMessages[aiIdx];
          const aiMsg: AIMessage = {
            role: "assistant",
            blocks: loaded.blocks,
            metadata: loaded.metadata ?? { startedAt: 0, endedAt: 0, model: event.model, tokens: 0 },
          };
          state.messages.push(aiMsg);
          aiIdx++;
        }
      }
      break;
    }

    case "ack":
    case "pong":
      break;
  }
}
