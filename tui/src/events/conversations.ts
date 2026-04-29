import type { Event } from "../protocol";
import { syncChosenProvider } from "../providerselection";
import { clearLocalQueue } from "../queue";
import {
  focusConversationById,
  rememberEnteredConversation,
  syncSelectedIndex,
  updateConversation,
  updateConversationList,
} from "../sidebar";
import type { RenderState } from "../state";
import {
  clearPendingAI,
  clearStreamingTailMessages,
  resetNewConversationDefaults,
  resetToolOutputState,
  setLoadedConversationToolOutputState,
} from "../state";
import { pushDisplayEntries } from "./display";
import { hydratePendingAIFromSnapshot } from "./pending-ai";
import { fallbackProvider } from "./provider";
import {
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
    if (providerOrModelChanged) state.contextTokens = null;
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
    state.sidebar.conversations.splice(idx, 1);
    syncSelectedIndex(state.sidebar);
  }
  // If this was the current conversation, clear the chat.
  if (state.convId === event.convId) {
    state.convId = null;
    state.messages = [];
    clearPendingAI(state);
    delete state.lastStreamSeqByConv[event.convId];
    state.contextTokens = null;
    resetToolOutputState(state);
    resetNewConversationDefaults(state);
  }
  clearLocalQueue(state, event.convId);
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
  const preserveLivePendingAI = previousConvId === event.convId && state.pendingAI !== null;
  const preservedPendingAIBlocks = preserveLivePendingAI
    ? subtractLoadedAssistantPrefix(state.pendingAI!.blocks, event.entries)
    : [];
  const preservedPendingAI = preserveLivePendingAI && preservedPendingAIBlocks.length > 0
    ? clonePendingAI({ blocks: preservedPendingAIBlocks, metadata: state.pendingAI!.metadata })
    : null;
  // Unsubscribe from old conversation before switching.
  if (previousConvId && previousConvId !== event.convId) {
    daemon.unsubscribe(previousConvId);
    delete state.lastStreamSeqByConv[previousConvId];
    // Clear stale queue shadows — the daemon owns the real queue and will drain
    // it regardless; we won't receive streaming_stopped after unsubscribing, so
    // clean up now.
    clearLocalQueue(state, previousConvId);
  }
  state.messages = [];
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  rememberEnteredConversation(state.sidebar, previousConvId, event.convId);
  state.convId = event.convId;
  focusConversationById(state.sidebar, event.convId);
  syncChosenProvider(state, event.provider ?? fallbackProvider(state));
  state.model = event.model ?? state.model;
  state.effort = event.effort ?? state.effort;
  state.fastMode = event.fastMode ?? state.fastMode;
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
