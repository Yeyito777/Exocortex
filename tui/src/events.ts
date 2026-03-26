/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { isStreaming, clearPendingAI } from "./state";
import { ensureCurrentBlock, createPendingAI, truncateToCompletedRounds } from "./messages";
import type { AIMessage, SystemMessage, ImageAttachment } from "./messages";
import { updateConversationList, updateConversation, syncSelectedIndex } from "./sidebar";
import { theme } from "./theme";
import { clearLocalQueue, removeLocalQueueEntry } from "./queue";
import type { Event, DisplayEntry } from "./protocol";

// ── Helpers ─────────────────────────────────────────────────────────

/** Map a semantic color name to the corresponding theme value. */
function themeColor(name: string | undefined): string {
  if (name === "error") return theme.error;
  if (name === "warning") return theme.warning;
  return theme.muted;
}

// ── Display entry → TUI message conversion ─────────────────────────

/**
 * Map daemon display entries to TUI message objects and push them
 * onto state.messages.  Used by both conversation_loaded and
 * history_updated — keeps the mapping in one place.
 */
function pushDisplayEntries(state: RenderState, entries: DisplayEntry[]): void {
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        state.messages.push({ role: "user", text: entry.text, images: entry.images, metadata: null });
        break;
      case "ai":
        state.messages.push({
          role: "assistant",
          blocks: entry.blocks,
          metadata: entry.metadata ?? null,
        });
        break;
      case "system":
        state.messages.push({ role: "system", text: entry.text, color: themeColor(entry.color), metadata: null });
        break;
    }
  }
}

// ── Daemon actions interface ────────────────────────────────────────
// Minimal interface so this file doesn't depend on DaemonClient.

export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void;
}

// ── Conversation-scoped events ─────────────────────────────────────
// These events are silently ignored when their convId doesn't match
// the active conversation.  Centralised here so each case doesn't
// need its own guard.

const CONV_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "message_complete", "streaming_stopped", "user_message", "system_message",
  "stream_retry", "history_updated",
]);

// ── Event handler ───────────────────────────────────────────────────

export function handleEvent(
  event: Event,
  state: RenderState,
  daemon: DaemonActions,
): void {
  // Early exit for conversation-scoped events targeting a different conversation
  if (CONV_SCOPED.has(event.type) && "convId" in event && event.convId !== state.convId) return;

  switch (event.type) {
    case "conversation_created": {
      state.convId = event.convId;
      state.model = event.model;
      daemon.subscribe(event.convId);

      // If we had a pending message, send it now
      if (state.pendingSend.active && (state.pendingSend.text || state.pendingSend.images) && state.pendingAI) {
        daemon.sendMessage(event.convId, state.pendingSend.text, state.pendingAI.metadata!.startedAt, state.pendingSend.images);
        state.pendingSend.text = "";
        state.pendingSend.images = undefined;
        state.pendingSend.active = false;
      }
      break;
    }

    case "streaming_started": {
      // Late-joining client: create pendingAI so future chunks are captured.
      // Original client already has pendingAI from handleSubmit.
      if (!state.pendingAI) {
        state.pendingAI = createPendingAI(event.startedAt, event.model);
      }
      // Populate with accumulated blocks from daemon (late-join catch-up)
      if (event.blocks && event.blocks.length > 0 && state.pendingAI.blocks.length === 0) {
        state.pendingAI.blocks = [...event.blocks];
      }
      // Restore accumulated token count for late-joining clients
      if (event.tokens && state.pendingAI.metadata!.tokens === 0) {
        state.pendingAI.metadata!.tokens = event.tokens;
      }
      break;
    }

    case "block_start": {
      if (state.pendingAI) {
        state.pendingAI.blocks.push({ type: event.blockType, text: "" });
      }
      break;
    }

    case "text_chunk": {
      if (state.pendingAI) {
        const block = ensureCurrentBlock(state.pendingAI, "text");
        if (block.type === "text") block.text += event.text;
      }
      break;
    }

    case "thinking_chunk": {
      if (state.pendingAI) {
        const block = ensureCurrentBlock(state.pendingAI, "thinking");
        if (block.type === "thinking") block.text += event.text;
      }
      break;
    }

    case "tool_call": {
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
      if (state.pendingAI) {
        state.pendingAI.metadata!.tokens = event.tokens;
      }
      break;
    }

    case "context_update": {
      state.contextTokens = event.contextTokens;
      break;
    }

    case "message_complete": {
      if (state.pendingAI) {
        // Use the daemon's canonical blocks — catches anything a late-joining
        // client missed during streaming.
        state.pendingAI.blocks = event.blocks;
        state.pendingAI.metadata!.endedAt = event.endedAt;
        state.pendingAI.metadata!.tokens = event.tokens;
        state.messages.push(state.pendingAI);
        clearPendingAI(state);
      }
      break;
    }

    case "streaming_stopped": {
      // On normal completion, message_complete already finalized pendingAI.
      // On abort/error, pendingAI is still live — finalize with persisted blocks.
      if (state.pendingAI) {
        if (event.persistedBlocks !== undefined) {
          state.pendingAI.blocks = event.persistedBlocks;
        }
        if (state.pendingAI.blocks.length > 0) {
          state.pendingAI.metadata!.endedAt ??= Date.now();
          state.messages.push(state.pendingAI);
        }
      }
      clearPendingAI(state);

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
      // Sync effort if this is the active conversation (may have changed from another client)
      if (event.summary.id === state.convId) {
        state.effort = event.summary.effort;
      }
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
        clearPendingAI(state);
        state.contextTokens = null;
      }
      clearLocalQueue(state, event.convId);
      break;
    }

    case "conversation_marked": {
      const conv = state.sidebar.conversations.find(c => c.id === event.convId);
      if (conv) conv.marked = event.marked;
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
        // Clear stale queue shadows — the daemon owns the real queue
        // and will drain it regardless; we won't receive streaming_stopped
        // after unsubscribing, so clean up now.
        clearLocalQueue(state, state.convId);
      }
      state.messages = [];
      clearPendingAI(state);
      state.convId = event.convId;
      state.model = event.model;
      state.effort = event.effort;
      state.scrollOffset = 0;
      state.contextTokens = event.contextTokens;

      // Entries arrive in display order — just map to TUI message types
      pushDisplayEntries(state, event.entries);

      // Rebuild local queue shadows from daemon state
      clearLocalQueue(state, event.convId);
      if (event.queuedMessages && event.queuedMessages.length > 0) {
        for (const qm of event.queuedMessages) {
          state.queuedMessages.push({ convId: event.convId, text: qm.text, timing: qm.timing });
        }
      }
      break;
    }

    case "stream_retry": {
      // Transient stream error → clear only partial blocks from the current
      // streaming round. Blocks from completed rounds are preserved.
      if (state.pendingAI) truncateToCompletedRounds(state.pendingAI);
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
      // During streaming: split pendingAI so the user message appears
      // inline between tool rounds (after completed blocks, before new ones).
      // This is purely for visual correctness during streaming — after
      // completion, history_updated rebuilds from canonical daemon state.
      if (state.pendingAI && state.pendingAI.blocks.length > 0) {
        const finalized: AIMessage = {
          role: "assistant",
          blocks: [...state.pendingAI.blocks],
          metadata: null,
        };
        state.messages.push(finalized);
        state.pendingAI = createPendingAI(
          state.pendingAI.metadata!.startedAt,
          state.pendingAI.metadata!.model,
        );
      }

      state.messages.push({ role: "user", text: event.text, images: event.images, metadata: null });

      // Remove matching local shadow — the daemon already injected it
      removeLocalQueueEntry(state, event.convId, event.text);

      state.scrollOffset = 0;
      break;
    }

    case "system_message": {
      const sysMsg: SystemMessage = { role: "system", text: event.text, color: themeColor(event.color), metadata: null };
      if (isStreaming(state)) {
        state.systemMessageBuffer.push(sysMsg);
      } else {
        state.messages.push(sysMsg);
      }
      break;
    }

    case "tools_available": {
      state.toolRegistry = event.tools;
      state.externalToolStyles = event.externalToolStyles ?? [];
      break;
    }

    case "history_updated": {
      // Context tool modified historical messages — replace committed messages
      // but preserve pendingAI (the active streaming response).
      // Flush buffered system messages — they reference pre-modification state.
      state.messages = [];
      state.systemMessageBuffer = [];
      state.contextTokens = event.contextTokens;
      pushDisplayEntries(state, event.entries);
      break;
    }

    case "auth_status": {
      state.messages.push({ role: "system", text: event.message, color: theme.muted, metadata: null });
      if (event.openUrl) {
        Bun.spawn(["xdg-open", event.openUrl], { stdout: "ignore", stderr: "ignore" }).unref();
      }
      break;
    }

    case "system_prompt": {
      state.messages.push({ role: "system", text: event.systemPrompt, metadata: null });
      break;
    }

    case "llm_complete_result":
    case "ack":
    case "pong":
      break;
  }
}
