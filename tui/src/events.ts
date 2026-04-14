/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { clearPendingAI, clearStreamingTailMessages, pushSystemMessage, resolveSystemMessageColor, resetToolOutputState, setCurrentConversationToolOutputAvailability, setLoadedConversationToolOutputState } from "./state";
import { preserveViewportAcrossHistoryMutation, toggleToolOutputPreservingViewport } from "./chatscroll";
import { DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER, ensureCurrentBlock, createMessageMetadata, createPendingAI, normalizeEffortForModel, truncateToCompletedRounds, splitPendingAI, replacePendingStreamingTail } from "./messages";
import type { ImageAttachment } from "./messages";
import { syncChosenProvider } from "./providerselection";
import {
  focusConversationById,
  rememberEnteredConversation,
  updateConversationList,
  updateConversation,
  syncSelectedIndex,
} from "./sidebar";
import { theme } from "./theme";
import { clearLocalQueue, removeLocalQueueEntry } from "./queue";
import type { Event, DisplayEntry, SystemMessageEvent } from "./protocol";

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
        state.messages.push({ role: "user", text: entry.text, images: entry.images, metadata: entry.metadata ?? null });
        break;
      case "ai":
        state.messages.push({
          role: "assistant",
          blocks: entry.blocks,
          metadata: entry.metadata ?? null,
        });
        break;
      case "system":
        state.messages.push({ role: "system", text: entry.text, color: resolveSystemMessageColor(entry.color), metadata: null });
        break;
      case "system_instructions":
        state.messages.push({ role: "system_instructions", text: entry.text, metadata: null });
        break;
    }
  }
}


function applyToolOutputs(state: RenderState, outputs: Array<{ toolCallId: string; output: string }>): void {
  const byId = new Map(outputs.map((item) => [item.toolCallId, item.output]));
  const applyToBlocks = (blocks: Array<{ type: string; toolCallId?: string; output?: string }>) => {
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.toolCallId) continue;
      const next = byId.get(block.toolCallId);
      if (next !== undefined) block.output = next;
    }
  };

  for (const msg of state.messages) {
    if (msg.role === "assistant") applyToBlocks(msg.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
  }
  if (state.pendingAI) applyToBlocks(state.pendingAI.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
}

function fallbackProvider(state: RenderState): RenderState["provider"] {
  return state.providerRegistry[0]?.id ?? state.provider ?? DEFAULT_PROVIDER_ID;
}

function syncModelEffortSelection(state: RenderState): void {
  const provider = state.providerRegistry.find((candidate) => candidate.id === state.provider);
  const model = provider?.models.find((candidate) => candidate.id === state.model) ?? null;
  state.effort = normalizeEffortForModel(model, state.effort);
}

function pushInlineSystemNotice(
  state: RenderState,
  text: string,
  color: string | undefined,
  reconcileOnStop = false,
): void {
  if (state.pendingAI) {
    const finalized = splitPendingAI(state.pendingAI);
    if (finalized) {
      if (reconcileOnStop) finalized.metadata = state.pendingAI.metadata ? { ...state.pendingAI.metadata } : null;
      state.messages.push(finalized);
      if (reconcileOnStop) state.pendingAICommittedIndex = state.messages.length - 1;
    }
  }
  state.messages.push({ role: "system", text, color: resolveSystemMessageColor(color), metadata: null });
}

function shouldReconcileInlineSystemNoticeOnStop(event: SystemMessageEvent): boolean {
  // The daemon currently uses `system_message` both for durable stream
  // failures (timeouts, interrupts, hard errors) and for ordinary notices.
  // Only the durable failure class should claim the pending assistant slot
  // and get its final blocks reconciled when streaming_stopped arrives.
  return event.color === "error" || event.text.startsWith("✗");
}

// ── Daemon actions interface ────────────────────────────────────────
// Minimal interface so this file doesn't depend on DaemonClient.

export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void;
  setSystemInstructions(convId: string, text: string): void;
  loadToolOutputs(convId: string): void;
}

// ── Conversation-scoped events ─────────────────────────────────────
// These events are silently ignored when their convId doesn't match
// the active conversation.  Centralised here so each case doesn't
// need its own guard.

const CONV_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk", "streaming_sync",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "message_complete", "streaming_stopped", "user_message", "system_message",
  "stream_retry", "history_updated", "tool_outputs_loaded",
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
      rememberEnteredConversation(state.sidebar, state.convId, event.convId);
      state.convId = event.convId;
      syncChosenProvider(state, event.provider ?? fallbackProvider(state));
      state.model = event.model ?? state.model;
      state.effort = event.effort ?? state.effort;
      state.fastMode = event.fastMode ?? state.fastMode;
      daemon.subscribe(event.convId);

      if (state.pendingSystemInstructions !== null) {
        daemon.setSystemInstructions(event.convId, state.pendingSystemInstructions);
        state.pendingSystemInstructions = null;
      }

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
        syncChosenProvider(state, event.provider ?? fallbackProvider(state));
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

    case "streaming_sync": {
      if (state.pendingAI) replacePendingStreamingTail(state.pendingAI, event.blocks);
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
        const committedIndex = state.pendingAICommittedIndex;
        if (committedIndex !== null) {
          const committed = state.messages[committedIndex];
          if (committed?.role === "assistant") {
            if (event.persistedBlocks !== undefined) committed.blocks = event.persistedBlocks;
            if (state.pendingAI.metadata) {
              committed.metadata = {
                ...state.pendingAI.metadata,
                endedAt: state.pendingAI.metadata.endedAt ?? Date.now(),
              };
            }
          }
        } else {
          if (event.persistedBlocks !== undefined) {
            state.pendingAI.blocks = event.persistedBlocks;
          }
          if (state.pendingAI.blocks.length > 0) {
            state.pendingAI.metadata!.endedAt ??= Date.now();
            state.messages.push(state.pendingAI);
          }
        }
      }
      clearPendingAI(state);

      // Flush user-invoked notices that were intentionally kept in the live tail.
      for (const msg of state.streamingTailMessages) {
        state.messages.push(msg);
      }
      clearStreamingTailMessages(state);
      break;
    }

    case "error": {
      // Only show errors for the current conversation (or unscoped errors)
      if (event.convId && event.convId !== state.convId) break;
      pushSystemMessage(state, `✗ ${event.message}`, theme.error);
      break;
    }

    case "usage_update": {
      state.usageByProvider[event.provider] = event.usage;
      break;
    }

    case "conversations_list": {
      updateConversationList(state.sidebar, event.conversations);
      break;
    }

    case "conversation_updated": {
      updateConversation(state.sidebar, event.summary);
      // Sync provider/model/effort if this is the active conversation
      if (event.summary.id === state.convId) {
        const nextProvider = event.summary.provider ?? fallbackProvider(state);
        const nextModel = event.summary.model ?? state.model;
        const providerOrModelChanged = nextProvider !== state.provider || nextModel !== state.model;
        syncChosenProvider(state, nextProvider);
        state.model = nextModel;
        state.effort = event.summary.effort ?? state.effort;
        state.fastMode = event.summary.fastMode ?? state.fastMode;
        if (providerOrModelChanged) state.contextTokens = null;
      }
      break;
    }

    case "conversation_restored": {
      updateConversation(state.sidebar, event.summary);
      // Select the restored conversation in the sidebar
      focusConversationById(state.sidebar, event.summary.id);
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
        resetToolOutputState(state);
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
      clearStreamingTailMessages(state);
      rememberEnteredConversation(state.sidebar, state.convId, event.convId);
      state.convId = event.convId;
      focusConversationById(state.sidebar, event.convId);
      syncChosenProvider(state, event.provider ?? fallbackProvider(state));
      state.model = event.model ?? state.model;
      state.effort = event.effort ?? state.effort;
      state.fastMode = event.fastMode ?? state.fastMode;
      state.scrollOffset = 0;
      state.contextTokens = event.contextTokens;
      setLoadedConversationToolOutputState(state, event.toolOutputsIncluded);

      // Entries arrive in display order — just map to TUI message types
      pushDisplayEntries(state, event.entries);

      // Rebuild local queue shadows from daemon state
      clearLocalQueue(state, event.convId);
      if (event.queuedMessages && event.queuedMessages.length > 0) {
        for (const qm of event.queuedMessages) {
          state.queuedMessages.push({
            convId: event.convId, text: qm.text, timing: qm.timing,
            ...(qm.images?.length ? { images: qm.images } : {}),
          });
        }
      }
      break;
    }

    case "stream_retry": {
      // Transient stream error mid-stream. Split pendingAI so completed rounds
      // stay committed, then insert the retry notice inline before the next
      // attempt continues streaming.
      if (state.pendingAI) {
        truncateToCompletedRounds(state.pendingAI);
        const finalized = splitPendingAI(state.pendingAI);
        if (finalized) state.messages.push(finalized);
      }
      pushInlineSystemNotice(
        state,
        `⟳ ${event.errorMessage} — retrying in ${event.delaySec}s (${event.attempt}/${event.maxAttempts})…`,
        theme.warning,
      );
      break;
    }

    case "user_message": {
      // During streaming: split pendingAI so the user message appears
      // inline between tool rounds (after completed blocks, before new ones).
      // This is purely for visual correctness during streaming — after
      // completion, history_updated rebuilds from canonical daemon state.
      if (state.pendingAI) {
        const finalized = splitPendingAI(state.pendingAI);
        if (finalized) state.messages.push(finalized);
      }

      state.messages.push({
        role: "user",
        text: event.text,
        images: event.images,
        metadata: typeof event.startedAt === "number"
          ? createMessageMetadata(event.startedAt, state.model, { endedAt: event.startedAt })
          : null,
      });

      // Remove matching local shadow — the daemon already injected it
      removeLocalQueueEntry(state, event.convId, event.text);

      state.scrollOffset = 0;
      break;
    }

    case "system_message": {
      pushInlineSystemNotice(state, event.text, event.color, shouldReconcileInlineSystemNoticeOnStop(event));
      break;
    }

    case "tools_available": {
      if (Array.isArray(event.providers)) {
        state.providerRegistry = event.providers;
      }
      state.toolRegistry = Array.isArray(event.tools) ? event.tools : [];
      if (event.authByProvider) {
        state.authByProvider = event.authByProvider;
      }
      if (event.authInfoByProvider) {
        state.authInfoByProvider = event.authInfoByProvider;
      }
      state.externalToolStyles = event.externalToolStyles ?? [];
      const registry = state.providerRegistry ?? [];

      let provider = registry.find((p) => p.id === state.provider) ?? null;
      if (!state.hasChosenProvider) {
        const authenticated = registry.filter((candidate) => state.authByProvider[candidate.id]);
        if (authenticated.length === 1) {
          provider = authenticated[0];
          syncChosenProvider(state, provider.id);
          state.model = provider.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER[provider.id];
        }
      }

      if (provider && state.hasChosenProvider) {
        const allowsCustomModels = provider.allowsCustomModels;
        if (!provider.models.some((m) => m.id === state.model) && !allowsCustomModels) {
          state.model = provider.defaultModel;
        }
        syncModelEffortSelection(state);
      }
      break;
    }

    case "history_updated": {
      // Context tool modified historical messages — replace committed messages
      // but preserve pendingAI (the active streaming response).
      // Flush buffered system messages — they reference pre-modification state.
      state.messages = [];
      clearStreamingTailMessages(state);
      state.contextTokens = event.contextTokens;
      setCurrentConversationToolOutputAvailability(state, event.toolOutputsIncluded);
      pushDisplayEntries(state, event.entries);
      if (state.showToolOutput && !state.toolOutputsLoaded && state.convId) {
        state.toolOutputsLoading = true;
        daemon.loadToolOutputs(state.convId);
      }
      break;
    }

    case "tool_outputs_loaded": {
      const apply = () => applyToolOutputs(state, event.outputs);
      if (state.showToolOutput) preserveViewportAcrossHistoryMutation(state, apply);
      else apply();
      state.toolOutputsLoaded = true;
      state.toolOutputsLoading = false;
      if (state.showToolOutputAfterLoad && !state.showToolOutput) {
        state.showToolOutputAfterLoad = false;
        toggleToolOutputPreservingViewport(state);
      }
      break;
    }

    case "auth_status": {
      if (event.message) {
        pushSystemMessage(state, event.message, theme.muted);
      }
      if (event.openUrl) {
        Bun.spawn(["xdg-open", event.openUrl], { stdout: "ignore", stderr: "ignore" }).unref();
      }
      break;
    }

    case "system_prompt": {
      pushSystemMessage(state, event.systemPrompt);
      break;
    }

    case "system_instructions_updated":
      // No-op — the daemon sends history_updated which rebuilds everything.
      break;

    case "llm_complete_result":
    case "ack":
    case "pong":
      break;
  }
}
