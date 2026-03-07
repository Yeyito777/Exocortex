/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { isStreaming } from "./state";
import { ensureCurrentBlock } from "./messages";
import type { SystemMessage } from "./messages";
import { updateConversationList, updateConversation, syncSelectedIndex } from "./sidebar";
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
        state.pendingAI.metadata.endedAt = event.endedAt;
        state.messages.push(state.pendingAI);
        state.pendingAI = null;
      }
      break;
    }

    case "streaming_stopped": {
      if (event.convId !== state.convId) break;
      if (state.pendingAI && state.pendingAI.blocks.length > 0) {
        state.pendingAI.metadata.endedAt ??= Date.now();
        state.messages.push(state.pendingAI);
      }
      state.pendingAI = null;

      // Flush system messages that arrived during streaming (after the AI message)
      for (const msg of state.systemMessageBuffer) {
        state.messages.push(msg);
      }
      state.systemMessageBuffer = [];
      break;
    }

    case "error": {
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
        // Unpin bumps updatedAt so it sorts to top of unpinned
        if (!event.pinned && conv.pinned) conv.updatedAt = Date.now();
        conv.pinned = event.pinned;
        // Re-sort: pinned first, then by updatedAt desc
        state.sidebar.conversations.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        syncSelectedIndex(state.sidebar);
      }
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

      // Build interleaved message list: user, AI, and system messages in order
      const sysMap = new Map<number, typeof event.systemMessages>();
      for (const sm of event.systemMessages) {
        const list = sysMap.get(sm.afterIndex) ?? [];
        list.push(sm);
        sysMap.set(sm.afterIndex, list);
      }

      // Insert system messages that appear before any user/AI messages
      for (const sm of sysMap.get(0) ?? []) {
        const color = sm.color === "error" ? theme.error : theme.muted;
        state.messages.push({ role: "system", text: sm.text, color, metadata: null });
      }

      let displayIdx = 0;
      const totalPairs = Math.max(event.userMessages.length, event.aiMessages.length);
      let userIdx = 0;
      let aiIdx = 0;
      for (let i = 0; i < totalPairs; i++) {
        if (userIdx < event.userMessages.length) {
          state.messages.push({ role: "user", text: event.userMessages[userIdx], metadata: null });
          userIdx++;
          displayIdx++;
          for (const sm of sysMap.get(displayIdx) ?? []) {
            const color = sm.color === "error" ? theme.error : theme.muted;
            state.messages.push({ role: "system", text: sm.text, color, metadata: null });
          }
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
          displayIdx++;
          for (const sm of sysMap.get(displayIdx) ?? []) {
            const color = sm.color === "error" ? theme.error : theme.muted;
            state.messages.push({ role: "system", text: sm.text, color, metadata: null });
          }
        }
      }
      break;
    }

    case "system_message": {
      if (event.convId !== state.convId) break;
      const color = event.color === "error" ? theme.error : theme.muted;
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
