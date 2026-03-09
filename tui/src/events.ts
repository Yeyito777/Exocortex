/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { isStreaming } from "./state";
import { ensureCurrentBlock, createPendingAI, sortConversations } from "./messages";
import type { SystemMessage } from "./messages";
import { updateConversationList, updateConversation, syncSelectedIndex } from "./sidebar";
import { theme } from "./theme";
import type { Event } from "./protocol";

// ── Daemon actions interface ────────────────────────────────────────
// Minimal interface so this file doesn't depend on DaemonClient.

export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number): void;
}

// ── Event handler ───────────────────────────────────────────────────

export function handleEvent(
  event: Event,
  state: RenderState,
  daemon: DaemonActions,
): void {
  switch (event.type) {
    case "conversation_created": {
      state.convId = event.convId;
      state.model = event.model;
      daemon.subscribe(event.convId);

      // If we had a pending message, send it now
      if (state.pendingSend.active && state.pendingSend.text && state.pendingAI) {
        daemon.sendMessage(event.convId, state.pendingSend.text, state.pendingAI.metadata.startedAt);
        state.pendingSend.text = "";
        state.pendingSend.active = false;
      }
      break;
    }

    case "streaming_started": {
      if (event.convId !== state.convId) break;
      // Late-joining client: create pendingAI so future chunks are captured.
      // Original client already has pendingAI from handleSubmit.
      if (!state.pendingAI) {
        state.pendingAI = createPendingAI(event.startedAt, event.model);
      }
      // Populate with accumulated blocks from daemon (late-join catch-up)
      if (event.blocks && event.blocks.length > 0 && state.pendingAI.blocks.length === 0) {
        state.pendingAI.blocks = [...event.blocks];
      }
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
        // Use the daemon's canonical data — catches anything a late-joining
        // client missed during streaming.
        state.pendingAI.blocks = event.blocks;
        state.pendingAI.metadata.endedAt = event.endedAt;
        state.pendingAI.metadata.tokens = event.tokens;
        state.messages.push(state.pendingAI);
        state.pendingAI = null;
      }
      break;
    }

    case "streaming_stopped": {
      if (event.convId !== state.convId) break;
      // On normal completion, message_complete already finalized pendingAI.
      // On abort/error, pendingAI is still live — finalize with persisted blocks.
      if (state.pendingAI) {
        if (event.persistedBlocks !== undefined) {
          state.pendingAI.blocks = event.persistedBlocks;
        }
        if (state.pendingAI.blocks.length > 0) {
          state.pendingAI.metadata.endedAt ??= Date.now();
          state.messages.push(state.pendingAI);
        }
        state.pendingAI = null;
      }

      // Flush system messages that arrived during streaming (after the AI message)
      for (const msg of state.systemMessageBuffer) {
        state.messages.push(msg);
      }
      state.systemMessageBuffer = [];
      break;
    }

    case "error": {
      // Only show errors for the current conversation (or unscoped errors)
      if (event.convId && event.convId !== state.convId) break;
      const sysMsg: SystemMessage = { role: "system", text: `✗ ${event.message}`, color: theme.error, metadata: null };
      if (isStreaming(state)) {
        state.systemMessageBuffer.push(sysMsg);
      } else {
        state.messages.push(sysMsg);
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

    case "conversation_restored": {
      updateConversation(state.sidebar, event.summary);
      // Select the restored conversation in the sidebar
      state.sidebar.selectedId = event.summary.id;
      syncSelectedIndex(state.sidebar);
      break;
    }

    case "conversation_deleted": {
      // Remove from sidebar (in case another client deleted it)
      const idx = state.sidebar.conversations.findIndex(c => c.id === event.convId);
      if (idx !== -1) {
        state.sidebar.conversations.splice(idx, 1);
        syncSelectedIndex(state.sidebar);
      }
      // If this was the current conversation, clear the chat
      if (state.convId === event.convId) {
        state.convId = null;
        state.messages = [];
        state.pendingAI = null;
        state.contextTokens = null;
      }
      break;
    }

    case "conversation_marked": {
      const conv = state.sidebar.conversations.find(c => c.id === event.convId);
      if (conv) conv.marked = event.marked;
      break;
    }

    case "conversation_pinned": {
      const conv = state.sidebar.conversations.find(c => c.id === event.convId);
      if (conv) {
        conv.pinned = event.pinned;
        sortConversations(state.sidebar.conversations);
        syncSelectedIndex(state.sidebar);
      }
      break;
    }

    case "conversation_moved": {
      updateConversationList(state.sidebar, event.conversations);
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

      // Entries arrive in display order — just map to TUI message types
      for (const entry of event.entries) {
        switch (entry.type) {
          case "user":
            state.messages.push({ role: "user", text: entry.text, metadata: null });
            break;
          case "ai":
            state.messages.push({
              role: "assistant",
              blocks: entry.blocks,
              metadata: entry.metadata ?? { startedAt: 0, endedAt: 0, model: event.model, tokens: 0 },
            });
            break;
          case "system": {
            const color = entry.color === "error" ? theme.error : entry.color === "warning" ? theme.warning : theme.muted;
            state.messages.push({ role: "system", text: entry.text, color, metadata: null });
            break;
          }
        }
      }
      break;
    }

    case "stream_retry": {
      if (event.convId !== state.convId) break;
      // Transient stream error → clear partial blocks so the retry starts fresh
      if (state.pendingAI) {
        state.pendingAI.blocks = [];
      }
      // Show retry message immediately (not buffered like system_message during streaming)
      state.messages.push({
        role: "system",
        text: `⟳ ${event.errorMessage} — retrying in ${event.delaySec}s (${event.attempt}/${event.maxAttempts})…`,
        color: theme.warning,
        metadata: null,
      });
      break;
    }

    case "user_message": {
      if (event.convId !== state.convId) break;
      state.messages.push({ role: "user", text: event.text, metadata: null });
      break;
    }

    case "system_message": {
      if (event.convId !== state.convId) break;
      const color = event.color === "error" ? theme.error : event.color === "warning" ? theme.warning : theme.muted;
      const sysMsg: SystemMessage = { role: "system", text: event.text, color, metadata: null };
      if (isStreaming(state)) {
        // Buffer during streaming so it appears after the AI message
        state.systemMessageBuffer.push(sysMsg);
      } else {
        state.messages.push(sysMsg);
      }
      break;
    }

    case "tools_available": {
      state.toolRegistry = event.tools;
      break;
    }

    case "ack":
    case "pong":
      break;
  }
}
