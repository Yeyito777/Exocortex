/**
 * Daemon event handler.
 *
 * Top-level daemon-event orchestrator. Feature-specific event helpers live in
 * ./events/* modules, while this file keeps the global event flow and switch
 * routing visible in one place.
 */

import type { RenderState } from "./state";
import { clearPendingAI, clearStreamingTailMessages, pushSystemMessage, renderFolderInstructionsDocument, setCurrentConversationToolOutputAvailability, setFolderInstructionsDocumentText } from "./state";
import { theme } from "./theme";
import { censorKnownAuthEmails } from "./privacy";
import type { Event } from "./protocol";
import {
  handleConversationCreated,
  handleConversationDeleted,
  handleConversationLoaded,
  handleConversationMoved,
  handleConversationRestored,
  handleConversationsList,
  handleConversationUpdated,
} from "./events/conversations";
import {
  applyPreservedToolResultOutputs,
  captureAssistantDisplaySnapshot,
  collectDisplayedToolResultOutputs,
  logDiskSyncAppliedAssistantDiff,
  logDiskSyncAssistantDiff,
  preserveLocalAssistantExtensionAfterDiskSync,
} from "./events/disk-sync-diagnostics";
import { pushDisplayEntries } from "./events/display";
import { CONV_SCOPED, observeStreamSeq } from "./events/stream-sequence";
import {
  handleBlockStart,
  handleContextUpdate,
  handleMessageComplete,
  handleStreamRetry,
  handleStreamingStarted,
  handleStreamingStopped,
  handleStreamingSync,
  handleSystemMessage,
  handleTextChunk,
  handleThinkingChunk,
  handleTokensUpdate,
  handleToolCall,
  handleToolResult,
  handleUserMessage,
} from "./events/streaming";
import { handleToolOutputsLoaded } from "./events/tool-outputs";
import { handleToolsAvailable } from "./events/provider";
import type { DaemonActions } from "./events/types";

export type { DaemonActions } from "./events/types";

export function handleEvent(
  event: Event,
  state: RenderState,
  daemon: DaemonActions,
): void {
  // Early exit for conversation-scoped events targeting a different conversation.
  if (CONV_SCOPED.has(event.type) && "convId" in event && event.convId !== state.convId) return;

  observeStreamSeq(event, state);

  switch (event.type) {
    case "conversation_created":
      handleConversationCreated(event, state, daemon);
      break;

    case "streaming_started":
      handleStreamingStarted(event, state);
      break;

    case "block_start":
      handleBlockStart(event, state);
      break;

    case "text_chunk":
      handleTextChunk(event, state);
      break;

    case "thinking_chunk":
      handleThinkingChunk(event, state);
      break;

    case "streaming_sync":
      handleStreamingSync(event, state);
      break;

    case "tool_call":
      handleToolCall(event, state);
      break;

    case "tool_result":
      handleToolResult(event, state);
      break;

    case "tokens_update":
      handleTokensUpdate(event, state);
      break;

    case "context_update":
      handleContextUpdate(event, state);
      break;

    case "message_complete":
      handleMessageComplete(event, state);
      break;

    case "streaming_stopped":
      handleStreamingStopped(event, state);
      break;

    case "error":
      // Only show errors for the current conversation (or unscoped errors).
      if (event.convId && event.convId !== state.convId) break;
      if (event.convId === state.convId && state.pendingAI && state.pendingAI.blocks.length === 0) clearPendingAI(state);
      pushSystemMessage(state, `✗ ${event.message}`, theme.error);
      break;

    case "usage_update":
      state.usageByProvider[event.provider] = event.usage;
      break;

    case "token_stats":
      state.tokenStats = event.stats;
      break;

    case "conversations_list":
      handleConversationsList(event, state);
      break;

    case "conversation_updated":
      handleConversationUpdated(event, state);
      break;

    case "goal_updated":
      state.goal = event.goal ?? null;
      if (event.message) pushSystemMessage(state, event.message, theme.muted);
      break;

    case "conversation_restored":
      handleConversationRestored(event, state);
      break;

    case "conversation_deleted":
      handleConversationDeleted(event, state);
      break;

    case "conversation_marked": {
      const conv = state.sidebar.conversations.find(c => c.id === event.convId);
      if (conv) conv.marked = event.marked;
      break;
    }

    case "conversation_moved":
      handleConversationMoved(event, state);
      break;

    case "conversation_loaded":
      handleConversationLoaded(event, state, daemon);
      break;

    case "stream_retry":
      handleStreamRetry(event, state);
      break;

    case "user_message":
      handleUserMessage(event, state);
      break;

    case "system_message":
      handleSystemMessage(event, state);
      break;

    case "tools_available":
      handleToolsAvailable(event, state);
      break;

    case "history_updated": {
      // Context tool modified historical messages — replace committed messages
      // but preserve pendingAI (the active streaming response). Flush buffered
      // system messages — they reference pre-modification state.
      const beforeApply = captureAssistantDisplaySnapshot(state);
      const previousShowToolOutput = state.showToolOutput;
      const previousToolOutputsLoaded = state.toolOutputsLoaded;
      const shouldPreserveCompactToolOutputs = !event.toolOutputsIncluded
        && (state.showToolOutput || state.toolOutputsLoaded);
      const preservedToolOutputs = shouldPreserveCompactToolOutputs
        ? collectDisplayedToolResultOutputs(state)
        : new Map();
      logDiskSyncAssistantDiff("history_updated", event.convId, state, {
        entries: event.entries,
        pendingAI: state.pendingAI,
        toolOutputsIncluded: event.toolOutputsIncluded,
      });
      state.messages = [];
      clearStreamingTailMessages(state);
      state.contextTokens = event.contextTokens;
      setCurrentConversationToolOutputAvailability(state, event.toolOutputsIncluded);
      pushDisplayEntries(state, event.entries);
      const preservedToolOutputResult = !event.toolOutputsIncluded && preservedToolOutputs.size > 0
        ? applyPreservedToolResultOutputs(state, preservedToolOutputs)
        : { patchedOutputs: 0, patchedToolNames: 0 };
      if (!event.toolOutputsIncluded && preservedToolOutputResult.patchedOutputs > 0) {
        state.toolOutputsLoaded = previousToolOutputsLoaded || state.toolOutputsLoaded;
        state.showToolOutput = previousShowToolOutput || state.showToolOutput;
        state.toolOutputsLoading = false;
        state.showToolOutputAfterLoad = false;
      }
      const preservedAssistantExtensionResult = preserveLocalAssistantExtensionAfterDiskSync(
        "history_updated",
        event.convId,
        beforeApply,
        state,
      );
      logDiskSyncAppliedAssistantDiff("history_updated", event.convId, beforeApply, state, {
        preservedToolOutputs: preservedToolOutputResult.patchedOutputs,
        preservedToolNames: preservedToolOutputResult.patchedToolNames,
        preservedAssistantExtensionBlocks: preservedAssistantExtensionResult.preservedBlocks,
        assistantBlocksBeforeDiskSync: preservedAssistantExtensionResult.beforeBlocks,
        assistantBlocksAfterDiskSync: preservedAssistantExtensionResult.afterBlocks,
        assistantBlocksAfterPreserve: preservedAssistantExtensionResult.mergedBlocks,
      });
      if (state.showToolOutput && !state.toolOutputsLoaded && state.convId) {
        state.toolOutputsLoading = true;
        daemon.loadToolOutputs(state.convId);
      }
      break;
    }

    case "tool_outputs_loaded":
      handleToolOutputsLoaded(state, event.outputs);
      break;

    case "auth_status":
      if (event.message) {
        pushSystemMessage(state, censorKnownAuthEmails(state, event.message), theme.muted);
      }
      if (event.openUrl) {
        try {
          Bun.spawn(["xdg-open", event.openUrl], { stdout: "ignore", stderr: "ignore" }).unref();
        } catch {
          pushSystemMessage(state, "Could not automatically open a browser. Paste this URL into a browser instead:", theme.warning);
          pushSystemMessage(state, event.openUrl, theme.muted);
        }
      }
      break;

    case "system_prompt":
      pushSystemMessage(state, event.systemPrompt);
      break;

    case "system_instructions_updated":
      // No-op — the daemon sends history_updated which rebuilds everything.
      break;

    case "folder_instructions_loaded":
      setFolderInstructionsDocumentText(state, event.folderId, event.text);
      break;

    case "folder_instructions_updated":
      if (state.folderInstructionsDoc?.folderId === event.folderId) {
        const doc = state.folderInstructionsDoc;
        const changedRemotely = doc.text !== event.text;
        doc.text = event.text;
        doc.savedText = event.text;
        doc.loading = false;
        if (changedRemotely) renderFolderInstructionsDocument(state, event.text);
      }
      break;

    case "llm_complete_result":
    case "ack":
    case "pong":
      break;
  }
}
