import { log } from "../log";
import type { Event } from "../protocol";
import { syncChosenProvider } from "../providerselection";
import { clearAllQueuedMessagesForConversation, clearLocalQueue, hasDaemonQueuedMessageShadowsForConversation } from "../queue";
import {
  focusConversationById,
  rememberEnteredConversation,
  syncSelectedIndex,
  updateConversation,
  updateConversationList,
} from "../sidebar";
import { focusTargetAfterRemovingSidebarItems } from "../sidebar/removal";
import { focusSidebarItem } from "../sidebar/selection";
import type { RenderState } from "../state";
import {
  clearPendingAI,
  clearStreamingTailMessages,
  resetNewConversationDefaults,
  resetToolOutputState,
  setLoadedConversationToolOutputState,
} from "../state";
import {
  applyPreservedToolResultOutputs,
  captureAssistantDisplaySnapshot,
  collectDisplayedToolResultOutputs,
  logDiskSyncAppliedAssistantDiff,
  logDiskSyncAssistantDiff,
  preserveLocalAssistantExtensionAfterDiskSync,
} from "./disk-sync-diagnostics";
import { pushDisplayEntries } from "./display";
import { hydratePendingAIFromSnapshot } from "./pending-ai";
import { fallbackProvider } from "./provider";
import {
  blockStats,
  clonePendingAI,
  findSnapshotAlignment,
  logStreamingRepair,
  mergeSnapshotBlocksPreservingLocalDetails,
  subtractLoadedAssistantPrefix,
} from "./streaming-snapshot";
import type { DaemonActions } from "./types";

export function handleConversationCreated(
  event: Extract<Event, { type: "conversation_created" }>,
  state: RenderState,
  daemon: DaemonActions,
): void {
  rememberEnteredConversation(state.sidebar, state.convId, event.convId);
  state.folderInstructionsDoc = null;
  state.convId = event.convId;
  syncChosenProvider(state, event.provider ?? fallbackProvider(state));
  state.model = event.model ?? state.model;
  state.effort = event.effort ?? state.effort;
  state.fastMode = event.fastMode ?? state.fastMode;
  state.goal = event.goal ?? null;
  daemon.subscribe(event.convId);

  if (state.pendingSystemInstructions !== null) {
    daemon.setSystemInstructions(event.convId, state.pendingSystemInstructions);
    state.pendingSystemInstructions = null;
  }

  // If we had a pending message, send it now.
  if (state.pendingSend.active && (state.pendingSend.text || state.pendingSend.images) && state.pendingAI) {
    daemon.sendMessage(event.convId, state.pendingSend.text, state.pendingAI.metadata!.startedAt, state.pendingSend.images);
    state.pendingSend.text = "";
    state.pendingSend.images = undefined;
    state.pendingSend.active = false;
  }
}

export function handleConversationsList(event: Extract<Event, { type: "conversations_list" }>, state: RenderState): void {
  updateConversationList(state.sidebar, event.conversations, event.folders ?? []);
}

export function handleConversationUpdated(event: Extract<Event, { type: "conversation_updated" }>, state: RenderState): void {
  const summary = event.summary;
  if (!summary) return;

  updateConversation(state.sidebar, summary);
  // Sync provider/model/effort if this is the active conversation.
  if (summary.id === state.convId) {
    const nextProvider = summary.provider ?? fallbackProvider(state);
    const nextModel = summary.model ?? state.model;
    const providerOrModelChanged = nextProvider !== state.provider || nextModel !== state.model;
    syncChosenProvider(state, nextProvider);
    state.model = nextModel;
    state.effort = summary.effort ?? state.effort;
    state.fastMode = summary.fastMode ?? state.fastMode;
    state.goal = summary.goal ?? null;
    if (providerOrModelChanged && state.contextTokens !== 0) state.contextTokens = null;
  }
}

export function handleConversationRestored(event: Extract<Event, { type: "conversation_restored" }>, state: RenderState): void {
  const summary = event.summary;
  if (!summary) return;

  updateConversation(state.sidebar, summary);
  // Select the restored conversation in the sidebar.
  focusConversationById(state.sidebar, summary.id);
  syncSelectedIndex(state.sidebar);
}

export function handleConversationDeleted(event: Extract<Event, { type: "conversation_deleted" }>, state: RenderState): void {
  // Remove from sidebar (in case another client deleted it).
  const idx = state.sidebar.conversations.findIndex(c => c.id === event.convId);
  if (idx !== -1) {
    const selectedWasDeleted = state.sidebar.selectedItem?.type === "conversation" && state.sidebar.selectedItem.id === event.convId;
    const focusTarget = selectedWasDeleted
      ? focusTargetAfterRemovingSidebarItems(state.sidebar, [{ type: "conversation", id: event.convId }])
      : null;
    state.sidebar.conversations.splice(idx, 1);
    if (selectedWasDeleted) focusSidebarItem(state.sidebar, focusTarget);
    else syncSelectedIndex(state.sidebar);
  }
  // If this was the current conversation, clear the chat.
  if (state.convId === event.convId) {
    state.convId = null;
    state.messages = [];
    clearPendingAI(state);
    delete state.lastStreamSeqByConv[event.convId];
    state.contextTokens = 0;
    state.goal = null;
    resetToolOutputState(state);
    resetNewConversationDefaults(state);
  }
  clearAllQueuedMessagesForConversation(state, event.convId);
}

export function handleConversationMoved(event: Extract<Event, { type: "conversation_moved" }>, state: RenderState): void {
  updateConversationList(state.sidebar, event.conversations, event.folders ?? state.sidebar.folders);
}

export function handleConversationLoaded(
  event: Extract<Event, { type: "conversation_loaded" }>,
  state: RenderState,
  daemon: DaemonActions,
): void {
  const previousConvId = state.convId;
  const sameConversation = previousConvId === event.convId;
  const beforeApply = sameConversation ? captureAssistantDisplaySnapshot(state) : null;
  const previousShowToolOutput = state.showToolOutput;
  const previousToolOutputsLoaded = state.toolOutputsLoaded;
  const shouldPreserveCompactToolOutputs = sameConversation
    && !event.toolOutputsIncluded
    && (state.showToolOutput || state.toolOutputsLoaded);
  const preservedToolOutputs = shouldPreserveCompactToolOutputs
    ? collectDisplayedToolResultOutputs(state)
    : new Map();

  logDiskSyncAssistantDiff("conversation_loaded", event.convId, state, {
    entries: event.entries,
    pendingAI: event.pendingAI ?? null,
    toolOutputsIncluded: event.toolOutputsIncluded,
  });
  const preserveLivePendingAI = sameConversation && state.pendingAI !== null;
  const preservedPendingAIBlocks = preserveLivePendingAI
    ? subtractLoadedAssistantPrefix(state.pendingAI!.blocks, event.entries)
    : [];
  const preservedPendingAI = preserveLivePendingAI && preservedPendingAIBlocks.length > 0
    ? clonePendingAI({ blocks: preservedPendingAIBlocks, metadata: state.pendingAI!.metadata })
    : null;
  if (sameConversation && (preserveLivePendingAI || event.pendingAI)) {
    log("info", `tui: conversation load pending preservation ${JSON.stringify({
      convId: event.convId,
      hadLocalPendingAI: preserveLivePendingAI,
      eventHasPendingAI: Boolean(event.pendingAI),
      localPending: state.pendingAI ? blockStats(state.pendingAI.blocks) : null,
      eventPending: event.pendingAI ? blockStats(event.pendingAI.blocks) : null,
      preservedPending: preservedPendingAI ? blockStats(preservedPendingAI.blocks) : null,
    })}`);
  }
  // Unsubscribe from old conversation before switching unless it still has
  // local daemon-queue shadows. In that case, keep the subscription just long
  // enough to hear the background user_message events that remove those shadows,
  // so TUI-only /queue can wait for queued turns in other conversations exactly.
  if (previousConvId && previousConvId !== event.convId) {
    if (!hasDaemonQueuedMessageShadowsForConversation(state, previousConvId)) {
      daemon.unsubscribe(previousConvId);
    }
    delete state.lastStreamSeqByConv[previousConvId];
  }
  state.messages = [];
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  rememberEnteredConversation(state.sidebar, previousConvId, event.convId);
  state.folderInstructionsDoc = null;
  state.convId = event.convId;
  if (sameConversation) {
    // Same-conversation loads are used for silent rehydration after daemon
    // reconnects (and other refreshes). Do not move the sidebar into the
    // conversation's folder in that case; the user may be browsing elsewhere in
    // the Conversations menu. Still reconcile the selected index in case the
    // sidebar list/order changed while disconnected.
    syncSelectedIndex(state.sidebar);
  } else {
    focusConversationById(state.sidebar, event.convId);
  }
  syncChosenProvider(state, event.provider ?? fallbackProvider(state));
  state.model = event.model ?? state.model;
  state.effort = event.effort ?? state.effort;
  state.fastMode = event.fastMode ?? state.fastMode;
  state.goal = event.goal ?? null;
  state.scrollOffset = 0;
  state.contextTokens = event.contextTokens;
  setLoadedConversationToolOutputState(state, event.toolOutputsIncluded);

  // Entries arrive in display order — just map to TUI message types.
  pushDisplayEntries(state, event.entries);

  if (preservedPendingAI) {
    const alignment = event.pendingAI
      ? findSnapshotAlignment(preservedPendingAI.blocks, event.pendingAI.blocks)
      : null;
    if (event.pendingAI && alignment?.strictlyNewer) {
      // Same-conversation reloads usually preserve local live state to avoid
      // clobbering newer chunks with an older snapshot. However, the daemon
      // snapshot may contain blocks this TUI missed while it was unfocused or
      // between load and subscribe. In that compatible-extension case, adopt
      // the daemon's fuller snapshot while preserving any full local tool output
      // omitted from the compact snapshot.
      const mergedBlocks = mergeSnapshotBlocksPreservingLocalDetails(preservedPendingAI.blocks, event.pendingAI.blocks, alignment);
      logStreamingRepair(
        "conversation_loaded",
        event.convId,
        preservedPendingAI.blocks,
        event.pendingAI.blocks,
        mergedBlocks,
        alignment,
        preservedPendingAI.metadata?.tokens,
        event.pendingAI.metadata?.tokens,
        false,
      );
      hydratePendingAIFromSnapshot(state, {
        ...event.pendingAI,
        blocks: mergedBlocks,
      });
    } else {
      state.pendingAI = preservedPendingAI;
      state.pendingAIHydratedFromSnapshot = false;
    }
  } else if (event.pendingAI) {
    hydratePendingAIFromSnapshot(state, event.pendingAI);
  }

  const preservedToolOutputResult = !event.toolOutputsIncluded && preservedToolOutputs.size > 0
    ? applyPreservedToolResultOutputs(state, preservedToolOutputs)
    : { patchedOutputs: 0, patchedToolNames: 0 };
  if (sameConversation && !event.toolOutputsIncluded && preservedToolOutputResult.patchedOutputs > 0) {
    state.toolOutputsLoaded = previousToolOutputsLoaded || state.toolOutputsLoaded;
    state.showToolOutput = previousShowToolOutput || state.showToolOutput;
    state.toolOutputsLoading = false;
    state.showToolOutputAfterLoad = false;
    log("info", `tui: preserved compact disk-sync tool outputs ${JSON.stringify({
      source: "conversation_loaded",
      convId: event.convId,
      patchedOutputs: preservedToolOutputResult.patchedOutputs,
      patchedToolNames: preservedToolOutputResult.patchedToolNames,
      restoredShowToolOutput: state.showToolOutput,
      restoredToolOutputsLoaded: state.toolOutputsLoaded,
    })}`);
  }

  const preservedAssistantExtensionResult = sameConversation
    ? preserveLocalAssistantExtensionAfterDiskSync("conversation_loaded", event.convId, beforeApply, state)
    : { preservedBlocks: 0, beforeBlocks: 0, afterBlocks: 0, mergedBlocks: 0 };

  logDiskSyncAppliedAssistantDiff("conversation_loaded", event.convId, beforeApply, state, {
    preservedToolOutputs: preservedToolOutputResult.patchedOutputs,
    preservedToolNames: preservedToolOutputResult.patchedToolNames,
    preservedAssistantExtensionBlocks: preservedAssistantExtensionResult.preservedBlocks,
    assistantBlocksBeforeDiskSync: preservedAssistantExtensionResult.beforeBlocks,
    assistantBlocksAfterDiskSync: preservedAssistantExtensionResult.afterBlocks,
    assistantBlocksAfterPreserve: preservedAssistantExtensionResult.mergedBlocks,
  });

  // Rebuild local queue shadows from daemon state.
  clearLocalQueue(state, event.convId);
  if (event.queuedMessages && event.queuedMessages.length > 0) {
    for (const qm of event.queuedMessages) {
      state.queuedMessages.push({
        convId: event.convId, text: qm.text, timing: qm.timing,
        ...(qm.images?.length ? { images: qm.images } : {}),
      });
    }
  }
}
