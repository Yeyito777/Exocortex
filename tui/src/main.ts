/**
 * Exocortex TUI — terminal client for exocortexd.
 *
 * Connects to the daemon via Unix socket, displays a conversational UI,
 * and forwards user input. All AI, auth, and streaming logic lives in
 * the daemon — this is purely a presentation layer.
 *
 * Usage: bun run src/main.ts
 */

import { spawn } from "child_process";
import { DaemonClient } from "./client";
import { parseInput, PasteBuffer, type KeyEvent, type MouseEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { clearPrompt } from "./promptstate";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { applyInlineCommands, type InlineCommandApplication } from "./inlineeffort";
import { advanceDeferredHistoryRender, hasDeferredHistoryRenderWork, render, invalidateHistoryRenderCache } from "./render";
import { preserveViewportAcrossResize } from "./chatscroll";
import { invalidateFrame } from "./frame";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste, enable_kitty_kbd, disable_kitty_kbd, enable_mouse, disable_mouse, set_cursor_color, reset_cursor_color } from "./terminal";
import { createInitialState, isStreaming, clearPendingAI, clearStreamingTailMessages, modelSupportsImages, openFolderInstructionsDocument, pushSystemMessage, renderFolderInstructionsDocument, resetDraftConversationState, resetNewConversationDefaults, resetToolOutputState } from "./state";
import { createMessageMetadata, createPendingAI, type ImageAttachment, type UserMessage } from "./messages";
import { loginPromptProviders } from "./providerselection";
import { handleEvent } from "./events";
import { CONV_SCOPED } from "./events/stream-sequence";
import {
  clearAllQueuedMessagesForConversation,
  confirmQueueMessage,
  cancelQueuePrompt,
  enqueueGlobalIdleMessage,
  hasDaemonQueuedMessageShadowsForConversation,
  hasGlobalIdleQueuedMessages,
  isGlobalIdleQueuedMessage,
  isNewConversationQueuedMessage,
  openQueuePrompt,
  peekGlobalIdleQueuedMessage,
  queuedMessageWaitStatus,
  removeLocalQueueEntry,
  removeNewConversationQueuedMessage,
  removeQueuedMessageByReference,
} from "./queue";
import { confirmEditMessage, cancelEditMessage } from "./editmessage";
import { generateTitle, PENDING_TITLE } from "./titlegen";
import { theme } from "./theme";
import { openTargetDetached } from "./openable";
import { msUntilNextElapsedSecond } from "./time";
import type { Event, QueueTiming } from "./protocol";
import { createVoiceInputController, type SubmittedVoiceTranscription, type VoiceInputController } from "./voiceinput";
import { editItemLooksLikePendingVoiceSubmission, pendingVoicePreviewTextsMatch, pendingVoiceSubmissionsMatch, removePendingVoiceEchoes } from "./pendingvoice";
import { startReplayConversation } from "./replay";
import { isConversationInSubagentsFolder, runStreamFinishedPing, shouldPingForBackgroundStreamCompletion, shouldPingForStreamStopped } from "./ping";
import { stripStartupLaunchEcho } from "./startupinput";
import { focusedConversationTasks } from "./activitypanel";

// ── State ───────────────────────────────────────────────────────────

const state = createInitialState();
const RECONNECT_DELAY_MS = 1000;
const STARTUP_PROFILE = process.env.EXOCORTEX_PROFILE_STARTUP === "1" || process.argv.includes("--profile-startup");
const STARTUP_INPUT_SANITIZE_MS = 1000;

type StartupProfileMark = { event: string; elapsedMs: number } & Record<string, unknown>;
const startupProfileMarks: StartupProfileMark[] = [];
let startupProfileConversationsLoaded = false;
let startupProfileReported = false;
let startupProfileConversationCount = 0;

function startupProfileMark(event: string, details: Record<string, unknown> = {}): void {
  if (!STARTUP_PROFILE || startupProfileReported) return;
  startupProfileMarks.push({ event, elapsedMs: Math.round(performance.now() * 1000) / 1000, ...details });
}

startupProfileMark("module_ready");

let running = true;
let daemon: DaemonClient;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let renderDueAt = 0;
let streamTickTimer: ReturnType<typeof setTimeout> | null = null;
let streamFinishedPingTimer: ReturnType<typeof setTimeout> | null = null;
let globalIdleQueuePumpTimer: ReturnType<typeof setTimeout> | null = null;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let deferredHistoryRenderTimer: ReturnType<typeof setTimeout> | null = null;
let lastPrewarmKey: string | null = null;
let lastPrewarmAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let terminalSetUp = false;
let voiceInput: VoiceInputController | null = null;
let pendingVoiceQueuePrompt = false;
let pendingNewConversationConvId: string | null = null;
let pendingLocalInterruptConvId: string | null = null;
let globalIdleQueueInFlight: { convId: string; observedStreaming: boolean } | null = null;
// Local-only user-message echoes whose audio jobs are still transcribing. They
// are intentionally withheld from the daemon until the TUI has final text.
const pendingVoiceSubmissions = new Set<SubmittedVoiceTranscription>();
const PREWARM_DEBOUNCE_MS = 700;
const PREWARM_COOLDOWN_MS = 30_000;
const GLOBAL_IDLE_QUEUE_PUMP_DELAY_MS = 120;

function generateClientConversationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function pendingAIHasVisibleContent(): boolean {
  return state.pendingAI?.blocks.some((block) => {
    if (block.type === "text" || block.type === "thinking") return block.text.trim().length > 0;
    return true;
  }) ?? false;
}

function showLocalPreContentInterrupt(convId: string): void {
  // If Ctrl+Q lands before any visible assistant content arrives, the daemon may
  // still be opening a websocket or waiting for the first provider event. Show
  // the terminal state immediately instead of leaving a metadata-only pending AI
  // bubble/spinner until the abort propagates through the transport.
  if (!state.pendingAI || pendingAIHasVisibleContent()) return;
  pendingLocalInterruptConvId = convId;
  clearStreamTick();
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  pushSystemMessage(state, "✗ Interrupted", theme.error);
}

function shouldIgnoreEventAfterLocalPreContentInterrupt(event: Event): boolean {
  if (pendingLocalInterruptConvId === null || !("convId" in event) || event.convId !== pendingLocalInterruptConvId) return false;
  switch (event.type) {
    case "streaming_started":
    case "block_start":
    case "text_chunk":
    case "thinking_chunk":
    case "streaming_sync":
    case "tool_call":
    case "tool_result":
    case "tokens_update":
    case "context_update":
    case "message_complete":
    case "stream_retry":
      return true;
    default:
      return false;
  }
}

// ── Render scheduling ───────────────────────────────────────────────

function maybeReportStartupProfile(finalRenderMs: number): void {
  if (!STARTUP_PROFILE || !startupProfileConversationsLoaded || startupProfileReported) return;
  startupProfileReported = true;
  startupProfileMarks.push({
    event: "ready_render_completed",
    elapsedMs: Math.round(performance.now() * 1000) / 1000,
    renderMs: Math.round(finalRenderMs * 1000) / 1000,
  });
  console.error(`[startup-profile] ${JSON.stringify({
    process: "tui",
    readyMs: Math.round(performance.now() * 1000) / 1000,
    conversationCount: startupProfileConversationCount,
    marks: startupProfileMarks,
  })}`);
  cleanup();
}

function clearRenderTimer(): void {
  if (!renderTimer) return;
  clearTimeout(renderTimer);
  renderTimer = null;
  renderDueAt = 0;
}

function clearStreamTick(): void {
  if (!streamTickTimer) return;
  clearTimeout(streamTickTimer);
  streamTickTimer = null;
}

function clearPrewarmTimer(): void {
  if (!prewarmTimer) return;
  clearTimeout(prewarmTimer);
  prewarmTimer = null;
}

function clearDeferredHistoryRenderTimer(): void {
  if (!deferredHistoryRenderTimer) return;
  clearTimeout(deferredHistoryRenderTimer);
  deferredHistoryRenderTimer = null;
}

function scheduleDeferredHistoryRenderWork(): void {
  if (!hasDeferredHistoryRenderWork(state) || deferredHistoryRenderTimer) return;
  deferredHistoryRenderTimer = setTimeout(() => {
    deferredHistoryRenderTimer = null;
    if (!advanceDeferredHistoryRender(state)) return;
    performRender();
  }, 0);
}

function clearStreamFinishedPingTimer(): void {
  if (!streamFinishedPingTimer) return;
  clearTimeout(streamFinishedPingTimer);
  streamFinishedPingTimer = null;
}

function clearGlobalIdleQueuePumpTimer(): void {
  if (!globalIdleQueuePumpTimer) return;
  clearTimeout(globalIdleQueuePumpTimer);
  globalIdleQueuePumpTimer = null;
}

function isConversationStreaming(convId: string): boolean {
  if (convId === state.convId) return isStreaming(state);
  return state.sidebar.conversations.some((conversation) => conversation.id === convId && conversation.streaming);
}

function releaseBackgroundQueueSubscriptionIfIdle(convId: string): void {
  if (convId === state.convId) return;
  if (hasDaemonQueuedMessageShadowsForConversation(state, convId)) return;
  daemon.unsubscribe(convId);
}

function unsubscribeUnlessWaitingForQueuedMessages(convId: string): void {
  if (hasDaemonQueuedMessageShadowsForConversation(state, convId)) return;
  daemon.unsubscribe(convId);
}

function scheduleGlobalIdleQueuePump(delayMs = GLOBAL_IDLE_QUEUE_PUMP_DELAY_MS): void {
  if (!hasGlobalIdleQueuedMessages(state)) return;
  if (globalIdleQueuePumpTimer) return;
  globalIdleQueuePumpTimer = setTimeout(() => {
    globalIdleQueuePumpTimer = null;
    pumpGlobalIdleQueue();
  }, delayMs);
}

function pumpGlobalIdleQueue(): void {
  if (!daemon?.connected) return;
  if (globalIdleQueueInFlight) return;

  const next = peekGlobalIdleQueuedMessage(state);
  if (!next) return;

  const waitStatus = queuedMessageWaitStatus(state, next);
  if (waitStatus === "waiting") return;
  if (waitStatus === "missing-target") {
    removeQueuedMessageByReference(state, next);
    pushSystemMessage(state, "✗ Dropped queued message because its wait target no longer exists.", theme.error);
    scheduleGlobalIdleQueuePump();
    scheduleRender();
    return;
  }

  const targetStillKnown = next.convId === state.convId
    || state.sidebar.conversations.some((conversation) => conversation.id === next.convId);
  if (!targetStillKnown) {
    if (isNewConversationQueuedMessage(next)) {
      // Creation was requested when the draft was queued; wait for the daemon's
      // conversation_created/conversation_updated events before sending.
      scheduleGlobalIdleQueuePump();
      return;
    }
    removeQueuedMessageByReference(state, next);
    pushSystemMessage(state, "✗ Dropped queued message because its conversation no longer exists.", theme.error);
    scheduleGlobalIdleQueuePump();
    scheduleRender();
    return;
  }

  if (isConversationStreaming(next.convId) || hasDaemonQueuedMessageShadowsForConversation(state, next.convId)) return;

  if (next.convId === state.convId && !canSendImages(next.images)) {
    removeQueuedMessageByReference(state, next);
    scheduleGlobalIdleQueuePump();
    scheduleRender();
    return;
  }

  removeQueuedMessageByReference(state, next);

  const startedAt = Date.now();
  if (next.convId === state.convId) {
    if (!state.authByProvider[state.provider]) {
      sendDirectly(next.text, next.images, { startedAt });
      scheduleGlobalIdleQueuePump();
      return;
    }
    globalIdleQueueInFlight = { convId: next.convId, observedStreaming: false };
    sendDirectly(next.text, next.images, { startedAt });
  } else {
    globalIdleQueueInFlight = { convId: next.convId, observedStreaming: false };
    daemon.sendMessage(next.convId, next.text, startedAt, next.images);
    scheduleRender();
  }
}

function updateGlobalIdleQueueInFlightFromEvent(event: Event): void {
  const inFlight = globalIdleQueueInFlight;
  if (!inFlight) return;

  if (event.type === "streaming_started" && event.convId === inFlight.convId) {
    inFlight.observedStreaming = true;
    return;
  }

  if (event.type === "conversation_updated" && event.summary.id === inFlight.convId) {
    if (event.summary.streaming) {
      inFlight.observedStreaming = true;
      return;
    }
    if (inFlight.observedStreaming) {
      globalIdleQueueInFlight = null;
      scheduleGlobalIdleQueuePump();
    }
    return;
  }

  if (event.type === "streaming_stopped" && event.convId === inFlight.convId && inFlight.observedStreaming) {
    globalIdleQueueInFlight = null;
    scheduleGlobalIdleQueuePump();
    return;
  }

  if (event.type === "error" && event.convId === inFlight.convId) {
    globalIdleQueueInFlight = null;
    if (event.convId !== state.convId) {
      const title = state.sidebar.conversations.find((conversation) => conversation.id === event.convId)?.title || event.convId;
      pushSystemMessage(state, `✗ Queued send failed for ${title}: ${event.message}`, theme.error);
    }
    scheduleGlobalIdleQueuePump();
    return;
  }

  if (event.type === "conversation_deleted" && event.convId === inFlight.convId) {
    globalIdleQueueInFlight = null;
    scheduleGlobalIdleQueuePump();
  }
}

function removeBackgroundDaemonQueueShadowFromEvent(event: Event): void {
  if (event.type !== "user_message") return;
  if (event.convId === state.convId) return;
  removeLocalQueueEntry(state, event.convId, event.text);
  releaseBackgroundQueueSubscriptionIfIdle(event.convId);
  scheduleGlobalIdleQueuePump();
}

function isBackgroundConversationScopedEvent(event: Event): boolean {
  return CONV_SCOPED.has(event.type) && "convId" in event && event.convId !== state.convId;
}

function scheduleStreamFinishedPing(completedConvId: string): void {
  if (isConversationInSubagentsFolder(completedConvId, state.sidebar.conversations, state.sidebar.folders)) return;
  clearStreamFinishedPingTimer();
  streamFinishedPingTimer = setTimeout(() => {
    streamFinishedPingTimer = null;
    // Re-check after the debounce in case sidebar folder state arrived or the
    // conversation moved while completion events were being reconciled.
    if (isConversationInSubagentsFolder(completedConvId, state.sidebar.conversations, state.sidebar.folders)) return;
    runStreamFinishedPing({
      completedConvId,
      activeConvId: state.convId,
      isCompletedConvStreaming: isConversationStreaming(completedConvId),
    });
  }, 200);
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

const FRAME_DELAY_MS = 16;
const STREAM_CHUNK_FRAME_DELAY_MS = 50;

function performRender(): void {
  const renderStartedAt = performance.now();
  render(state);
  const renderMs = performance.now() - renderStartedAt;
  resetStreamTick();
  maybeReportStartupProfile(renderMs);
  scheduleDeferredHistoryRenderWork();
}

function renderImmediately(): void {
  clearRenderTimer();
  performRender();
}

function renderAfterLocalUiMutation(): void {
  // IMPORTANT: do not replace this with scheduleRender(). Local keyboard/mouse
  // mutations (prompt edits, chat-history cursor/scroll, focus changes) must be
  // visible immediately. Waiting for the 16ms daemon/stream frame scheduler makes
  // chat-history navigation feel laggy and can reintroduce visible tty tearing.
  // Retained-frame diffing keeps these immediate local paints cheap.
  renderImmediately();
}

/** Schedule a render. Shorter-delay callers can pull an existing timer earlier. */
function scheduleRender(delayMs = FRAME_DELAY_MS): void {
  const dueAt = Date.now() + delayMs;
  if (renderTimer) {
    if (dueAt >= renderDueAt) return;
    clearTimeout(renderTimer);
  }

  renderDueAt = dueAt;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderDueAt = 0;
    performRender();
  }, Math.max(0, dueAt - Date.now()));
}

function renderDelayForEvent(event: Event): number {
  switch (event.type) {
    case "text_chunk":
    case "thinking_chunk":
    case "streaming_sync":
    case "tokens_update":
      return STREAM_CHUNK_FRAME_DELAY_MS;
    default:
      return FRAME_DELAY_MS;
  }
}

/** Re-render active stream/task durations on the next exact second boundary. */
function resetStreamTick(): void {
  clearStreamTick();
  if (state.contextCompactionStartedAt != null) {
    streamTickTimer = setTimeout(scheduleRender, 80);
    return;
  }
  const tickDelays: number[] = [];
  const startedAt = state.pendingAI?.metadata?.startedAt;
  if (isStreaming(state) && typeof startedAt === "number") {
    tickDelays.push(msUntilNextElapsedSecond(startedAt));
  }
  for (const task of focusedConversationTasks(state)) {
    if (Number.isFinite(task.startedAt)) tickDelays.push(msUntilNextElapsedSecond(task.startedAt));
  }
  if (tickDelays.length > 0) {
    streamTickTimer = setTimeout(scheduleRender, Math.min(...tickDelays));
  }
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function onDaemonEvent(event: Event): void {
  if (event.type === "conversation_created" && event.convId === pendingNewConversationConvId) {
    if (state.pendingQueuedDraftConvId === event.convId) state.pendingQueuedDraftConvId = null;
    pendingNewConversationConvId = null;
  } else if (event.type === "error" && event.convId === pendingNewConversationConvId) {
    removeNewConversationQueuedMessage(state, event.convId);
    if (state.pendingQueuedDraftConvId === event.convId) state.pendingQueuedDraftConvId = null;
    pendingNewConversationConvId = null;
  }

  if (event.type === "system_message" && event.convId === pendingLocalInterruptConvId && event.text === "✗ Interrupted") {
    return;
  }
  if (shouldIgnoreEventAfterLocalPreContentInterrupt(event)) return;

  if (event.type === "conversation_loaded") clearDeferredHistoryRenderTimer();

  if (event.type === "conversations_list") {
    startupProfileMark("conversations_list_received", { conversationCount: event.conversations.length });
  }

  if (isBackgroundConversationScopedEvent(event)) {
    removeBackgroundDaemonQueueShadowFromEvent(event);
    updateGlobalIdleQueueInFlightFromEvent(event);
    scheduleGlobalIdleQueuePump();
    return;
  }

  const activeConvIdBeforeEvent = state.convId;
  const wasUpdatedConversationStreaming = event.type === "conversation_updated"
    ? state.sidebar.conversations.find((c) => c.id === event.summary.id)?.streaming ?? false
    : false;

  invalidateHistoryRenderCache(state);
  handleEvent(event, state, daemon);
  removeBackgroundDaemonQueueShadowFromEvent(event);
  updateGlobalIdleQueueInFlightFromEvent(event);
  reattachVisiblePendingVoiceSubmissions();

  if (event.type === "conversations_list") {
    startupProfileConversationCount = event.conversations.length;
    startupProfileConversationsLoaded = true;
    startupProfileMark("conversations_list_handled", { conversationCount: state.sidebar.conversations.length });
  }

  // The daemon auto-generates titles after the first user message is appended.
  if (event.type === "conversation_created" && state.pendingGenerateTitleOnCreate) {
    state.pendingGenerateTitleOnCreate = false;
  }

  // Clear stream tick on active-conversation streaming_stopped. This TUI may
  // also stay temporarily subscribed to background conversations with queued
  // shadows; their scoped stop events must not disturb active stream timers.
  if (event.type === "streaming_stopped") {
    if (event.convId === state.convId) clearStreamTick();
    if (event.convId === pendingLocalInterruptConvId) pendingLocalInterruptConvId = null;
    if (shouldPingForStreamStopped(event.reason)) scheduleStreamFinishedPing(event.convId);
    // Queue shadows are NOT cleared here — the daemon drains one queued
    // message at a time and re-queues the rest. Each consumed message
    // triggers a user_message event, whose handler in events.ts removes
    // the corresponding shadow individually.
  }

  // When the user navigates away from a streaming conversation, this TUI
  // unsubscribes from that conversation and will not receive its scoped
  // streaming_stopped event. The sidebar still receives conversation_updated;
  // use its streaming true→false transition as the completion signal for
  // background conversations.
  if (event.type === "conversation_updated" && shouldPingForBackgroundStreamCompletion({
    updatedConvId: event.summary.id,
    wasStreaming: wasUpdatedConversationStreaming,
    isStreaming: event.summary.streaming,
    activeConvIdBeforeUpdate: activeConvIdBeforeEvent,
    streamStopReason: event.streamStopReason,
  })) {
    scheduleStreamFinishedPing(event.summary.id);
  }

  if (maybeFlushPendingAuthQueue()) {
    scheduleGlobalIdleQueuePump();
    return;
  }

  if (event.type === "streaming_started" && event.convId === state.convId && event.snapshotKind !== "heartbeat") {
    renderImmediately();
    scheduleGlobalIdleQueuePump();
    return;
  }

  scheduleGlobalIdleQueuePump();
  scheduleRender(renderDelayForEvent(event));
}

// ── Input handling ──────────────────────────────────────────────────

function enqueuePendingAuthMessage(messageText: string, images?: ImageAttachment[], echoStartedAt = Date.now()): void {
  state.pendingAuthQueue.push({ text: messageText, images, echoStartedAt });
  state.messages.push({
    role: "user",
    text: messageText,
    images,
    metadata: createMessageMetadata(echoStartedAt, state.model),
  });
}

function removeMessageByReference(message: UserMessage): void {
  const idx = state.messages.indexOf(message);
  if (idx !== -1) state.messages.splice(idx, 1);
}

function isPendingVoiceVisible(submission: SubmittedVoiceTranscription): boolean {
  return submission.convId ? submission.convId === state.convId : state.convId === null;
}

function reattachVisiblePendingVoiceSubmissions(): void {
  for (const submission of pendingVoiceSubmissions) {
    if (!isPendingVoiceVisible(submission)) continue;
    if (submission.queuedMessage) {
      if (!state.queuedMessages.includes(submission.queuedMessage)) state.queuedMessages.push(submission.queuedMessage);
      continue;
    }
    if (!state.messages.includes(submission.message)) state.messages.push(submission.message);
    if (!state.voiceMessage || state.voiceMessage.message === submission.message) {
      state.voiceMessage = { message: submission.message, phase: "transcribing", frameIndex: 0 };
    }
  }
}

function removePendingVoiceEcho(
  submission: SubmittedVoiceTranscription,
  aliases: Parameters<typeof removePendingVoiceEchoes>[2] = {},
): void {
  removePendingVoiceEchoes(state, submission, aliases);
}

function deletePendingVoiceSubmissionAliases(target: SubmittedVoiceTranscription): void {
  for (const submission of [...pendingVoiceSubmissions]) {
    if (pendingVoiceSubmissionsMatch(submission, target)) pendingVoiceSubmissions.delete(submission);
  }
}

function selectedEditItemLooksLikePendingVoice(): boolean {
  const selectedEditItem = state.editMessagePrompt?.items[state.editMessagePrompt.selection] ?? null;
  if (!selectedEditItem) return false;
  for (const submission of pendingVoiceSubmissions) {
    if (editItemLooksLikePendingVoiceSubmission(selectedEditItem, submission)) return true;
  }
  return pendingVoicePreviewTextsMatch(selectedEditItem.text, state.voiceMessage?.message.text);
}

function removePendingAuthEcho(echoStartedAt: number): void {
  const idx = state.messages.findIndex((message) => (
    message.role === "user"
    && message.metadata?.startedAt === echoStartedAt
  ));
  if (idx !== -1) state.messages.splice(idx, 1);
}

function maybeFlushPendingAuthQueue(): boolean {
  if (state.pendingAuthQueue.length === 0) return false;
  if (isStreaming(state)) return false;
  if (!state.authByProvider[state.provider]) return false;

  const next = state.pendingAuthQueue.shift();
  if (!next) return false;
  removePendingAuthEcho(next.echoStartedAt);
  sendDirectly(next.text, next.images);
  return true;
}

function showLoginRequiredPrompt(): void {
  const options = loginPromptProviders(state)
    .map((provider) => `  /login ${provider}`)
    .join("\n");
  const msg = [
    state.hasChosenProvider ? `You're not authenticated for ${state.provider}.` : "You're not authenticated.",
    state.pendingAuthQueue.length > 0 ? "Sign in to send the queued message:" : "Sign in with:",
    options,
  ].join("\n");

  pushSystemMessage(state, msg);
}

function canSendImages(images?: ImageAttachment[]): boolean {
  if (!images?.length) return true;
  if (modelSupportsImages(state)) return true;
  pushSystemMessage(state, `✗ Image inputs are not supported by ${state.provider}/${state.model}. Remove the attachment or switch to a vision-capable model.`, theme.error);
  return false;
}

function startNewConversation(): void {
  const wasFolderInstructionsDoc = state.folderInstructionsDoc !== null;
  pendingNewConversationConvId = null;
  if (state.convId) {
    unsubscribeUnlessWaitingForQueuedMessages(state.convId);
  }
  resetDraftConversationState(state);
  if (wasFolderInstructionsDoc) {
    clearPrompt(state);
    state.pendingImages = [];
  }
}

function syncInlineCommandChanges(result: InlineCommandApplication, convId = state.convId): void {
  if (!convId) return;
  for (const effort of result.efforts) {
    daemon.setEffort(convId, effort);
  }
  for (const enabled of result.fastModes) {
    daemon.setFastMode(convId, enabled);
  }
}

function hasInlineCommandChanges(result: InlineCommandApplication): boolean {
  return result.efforts.length > 0 || result.fastModes.length > 0;
}

function hasNonWhitespaceText(text: string): boolean {
  return /\S/.test(text);
}

function handleSubmit(): void {
  let text = state.inputBuffer.trim();
  const hasImages = state.pendingImages.length > 0;

  if (state.folderInstructionsDoc) {
    if (!hasImages && text === "/new") {
      startNewConversation();
      return;
    }
    state.folderInstructionsDoc.text = text;
    state.folderInstructionsDoc.savedText = text;
    state.folderInstructionsDoc.loading = false;
    daemon.setFolderInstructions(state.folderInstructionsDoc.folderId, text);
    renderFolderInstructionsDocument(state, text);
    clearPrompt(state);
    return;
  }

  if (!text && !hasImages) return;

  // Slash commands (only when no images attached — pure text commands)
  if (text && !hasImages) {
    const cmdResult = tryCommand(text, state);
    if (cmdResult) {
      switch (cmdResult.type) {
        case "quit":
          running = false;
          return;
        case "new_conversation":
          startNewConversation();
          break;
        case "create_conversation_for_instructions":
          if (state.convId) unsubscribeUnlessWaitingForQueuedMessages(state.convId);
          state.convId = null;
          state.contextTokens = 0;
          resetNewConversationDefaults(state);
          state.pendingSystemInstructions = cmdResult.text;
          state.pendingGenerateTitleOnCreate = false;
          daemon.createConversation(state.provider, state.model, "", state.effort, state.fastMode, undefined, state.sidebar.currentFolderId);
          break;
        case "replay_requested":
          if (startReplayConversation(state, daemon)) {
            renderImmediately();
            return;
          }
          break;
        case "model_changed":
          if (state.convId) daemon.setModel(state.convId, cmdResult.provider, cmdResult.model);
          break;
        case "trim_requested":
          if (state.convId) daemon.trimConversation(state.convId, cmdResult.mode, cmdResult.count);
          break;
        case "effort_changed":
          if (state.convId) daemon.setEffort(state.convId, cmdResult.effort);
          break;
        case "fast_mode_changed":
          if (state.convId) daemon.setFastMode(state.convId, cmdResult.enabled);
          break;
        case "goal":
          clearPrompt(state);
          state.pendingImages = [];
          state.scrollOffset = 0;
          if (state.convId) {
            daemon.setGoal(state.convId, cmdResult.action, cmdResult.objective, cmdResult.pausable, cmdResult.completable);
          } else if (cmdResult.action === "set" && cmdResult.objective?.trim()) {
            const objective = cmdResult.objective.trim();
            daemon.createConversation(
              state.provider,
              state.model,
              undefined,
              state.effort,
              state.fastMode,
              undefined,
              state.sidebar.currentFolderId,
              objective,
              undefined,
              cmdResult.pausable,
              cmdResult.completable,
            );
          } else {
            pushSystemMessage(state, "Create or open a conversation before using /goal.", theme.warning);
          }
          break;
        case "rename_conversation":
          if (state.convId) daemon.renameConversation(state.convId, cmdResult.title);
          break;
        case "generate_title":
          if (state.convId) generateTitle(state.convId, state, daemon, scheduleRender);
          break;
        case "theme_changed":
          // Re-emit the cursor color escape for the new theme
          if (theme.cursorColor) {
            process.stdout.write(set_cursor_color(theme.cursorColor));
          }
          break;
        case "get_system_prompt":
          daemon.getSystemPrompt(state.convId ?? undefined);
          break;
        case "set_system_instructions":
          if (state.convId) daemon.setSystemInstructions(state.convId, cmdResult.text);
          break;
        case "login":
          daemon.login(cmdResult.provider ?? state.provider, cmdResult.apiKey, cmdResult.action, cmdResult.target);
          break;
        case "account":
          daemon.account(cmdResult.provider ?? "openai", cmdResult.target);
          break;
        case "logout":
          daemon.logout(cmdResult.provider ?? state.provider);
          break;
        case "handled":
          break;
      }
      scheduleRender();
      return;
    }
  }

  const inlineCommands = applyInlineCommands(text, state);
  if (hasInlineCommandChanges(inlineCommands) || inlineCommands.queue) {
    syncInlineCommandChanges(inlineCommands);
    text = inlineCommands.text.trim();
    if (inlineCommands.queue) {
      const images = hasImages ? [...state.pendingImages] : undefined;
      if (!text && !images?.length) {
        pushSystemMessage(state, "Nothing to queue.", theme.warning);
        clearPrompt(state);
        state.pendingImages = [];
        state.scrollOffset = 0;
        scheduleRender();
        return;
      }
      if (!canSendImages(images)) {
        scheduleRender();
        return;
      }

      const messageText = expandMacros(text);
      const queueingDraftConversation = !state.convId;
      const convId = state.convId ?? generateClientConversationId();
      const folderId = state.sidebar.currentFolderId;
      const waitTarget = inlineCommands.queue;
      enqueueGlobalIdleMessage(state, convId, messageText, images, queueingDraftConversation ? {
        target: "new-conversation",
        provider: state.provider,
        model: state.model,
        effort: state.effort,
        fastMode: state.fastMode,
        folderId,
        waitTarget,
      } : {
        waitTarget,
      });
      if (queueingDraftConversation) {
        pendingNewConversationConvId = convId;
        state.pendingQueuedDraftConvId = convId;
        daemon.createConversation(
          state.provider,
          state.model,
          PENDING_TITLE,
          state.effort,
          state.fastMode,
          undefined,
          folderId,
          undefined,
          convId,
          undefined,
          undefined,
          messageText,
        );
      }
      clearPrompt(state);
      state.pendingImages = [];
      state.scrollOffset = 0;
      scheduleGlobalIdleQueuePump();
      scheduleRender();
      return;
    }
    if (!text && !hasImages) {
      clearPrompt(state);
      state.scrollOffset = 0;
      scheduleRender();
      return;
    }
  }

  if (isStreaming(state)) {
    // Macro expansion happens only if the user confirms the modal. Inline
    // commands are the exception: they have already run and been stripped so
    // the queued send honors the selected settings.
    openQueuePrompt(state, text);
    scheduleRender();
    return;
  }

  // Regular message — expand macros before sending
  const messageText = expandMacros(text);

  const images = hasImages ? [...state.pendingImages] : undefined;
  if (!canSendImages(images)) {
    scheduleRender();
    return;
  }

  if (!state.authByProvider[state.provider]) {
    clearPrompt(state);
    state.pendingImages = [];
    state.scrollOffset = 0;
    enqueuePendingAuthMessage(messageText, images);
    showLoginRequiredPrompt();
    scheduleRender();
    return;
  }

  clearPrompt(state);
  state.pendingImages = [];
  state.scrollOffset = 0;
  sendDirectly(messageText, images);
}

function openPendingVoiceQueuePrompt(previewText: string): void {
  pendingVoiceQueuePrompt = true;
  openQueuePrompt(state, previewText);
}

function confirmPendingVoiceQueuePrompt(): boolean {
  if (!pendingVoiceQueuePrompt || !state.queuePrompt) return false;

  const timing = state.queuePrompt.selection;
  const images = state.queuePrompt.images;
  state.queuePrompt = null;
  pendingVoiceQueuePrompt = false;

  if (voiceInput?.submitActiveTranscription({ queueTiming: timing })) {
    scheduleRender();
    return true;
  }

  // The transcription may have completed while the queue modal was open. In
  // that case the prompt now contains plain text; confirm it through the normal
  // queued-message path using the timing the user selected.
  const inlineCommands = applyInlineCommands(state.inputBuffer.trim(), state);
  syncInlineCommandChanges(inlineCommands);
  const messageText = expandMacros(inlineCommands.text.trim());
  if (!messageText && !images?.length) {
    clearPrompt(state);
    state.pendingImages = [];
    scheduleRender();
    return true;
  }

  if (state.convId && isStreaming(state)) {
    state.queuedMessages.push({ convId: state.convId, text: messageText, timing, images });
    clearPrompt(state);
    state.pendingImages = [];
    daemon.queueMessage(state.convId, messageText, timing, images);
  } else {
    clearPrompt(state);
    state.pendingImages = [];
    sendDirectly(messageText, images);
  }
  scheduleRender();
  return true;
}

function cancelPendingVoiceQueuePrompt(): boolean {
  if (!pendingVoiceQueuePrompt) return false;
  state.queuePrompt = null;
  pendingVoiceQueuePrompt = false;
  scheduleRender();
  return true;
}

function maybeScheduleOpenAIPrewarm(inputBefore: string): void {
  const convId = state.convId;
  if (!convId || state.provider !== "openai" || isStreaming(state) || state.folderInstructionsDoc) return;
  if (!daemon.connected || !state.authByProvider.openai) return;

  const beforeWasEmpty = !hasNonWhitespaceText(inputBefore);
  const nowHasInput = hasNonWhitespaceText(state.inputBuffer) || state.pendingImages.length > 0;
  if (!beforeWasEmpty || !nowHasInput) return;

  const key = `${convId}:${state.model}:${state.effort}:${state.fastMode ? "fast" : "normal"}`;
  const now = Date.now();
  if (lastPrewarmKey === key && now - lastPrewarmAt < PREWARM_COOLDOWN_MS) return;

  clearPrewarmTimer();
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    if (!running || !daemon.connected || state.convId !== convId || state.provider !== "openai" || isStreaming(state)) return;
    lastPrewarmKey = key;
    lastPrewarmAt = Date.now();
    daemon.prewarmConversation(convId);
  }, PREWARM_DEBOUNCE_MS);
  (prewarmTimer as { unref?: () => void }).unref?.();
}

interface SendDirectlyOptions {
  startedAt?: number;
  echoMessage?: UserMessage;
  /** Override folder for a newly-created conversation. */
  folderId?: string | null;
  /** Reserved client id for a newly-created conversation. */
  convId?: string;
}

/** Send a message immediately (no streaming in progress). */
function sendDirectly(messageText: string, images?: ImageAttachment[], options: SendDirectlyOptions = {}): void {
  if (!canSendImages(images)) {
    scheduleRender();
    return;
  }
  if (!state.authByProvider[state.provider]) {
    if (options.echoMessage && typeof options.startedAt === "number") {
      state.pendingAuthQueue.push({ text: messageText, images, echoStartedAt: options.startedAt });
    } else {
      enqueuePendingAuthMessage(messageText, images);
    }
    showLoginRequiredPrompt();
    scheduleRender();
    return;
  }

  const startedAt = options.startedAt ?? Date.now();
  if (options.echoMessage) {
    options.echoMessage.text = messageText;
    options.echoMessage.images = images;
    options.echoMessage.metadata = createMessageMetadata(startedAt, state.model, { endedAt: startedAt });
  } else {
    state.messages.push({
      role: "user",
      text: messageText,
      images,
      metadata: createMessageMetadata(startedAt, state.model, { endedAt: startedAt }),
    });
  }
  state.pendingAI = createPendingAI(startedAt, state.model);

  if (!state.convId) {
    const convId = options.convId ?? generateClientConversationId();
    pendingNewConversationConvId = convId;
    state.pendingSend.active = false;
    state.pendingSend.text = "";
    state.pendingSend.images = undefined;
    state.pendingGenerateTitleOnCreate = false;
    daemon.createConversation(state.provider, state.model, PENDING_TITLE, state.effort, state.fastMode, {
      text: messageText,
      startedAt,
      images,
    }, options.folderId ?? state.sidebar.currentFolderId, undefined, convId);
  } else {
    daemon.sendMessage(state.convId, messageText, startedAt, images);
  }

  scheduleRender();
}

function submitPendingVoiceTranscription(
  placeholderText: string,
  options: { queueTiming?: QueueTiming } = {},
): SubmittedVoiceTranscription | null {
  const images = state.pendingImages.length > 0 ? [...state.pendingImages] : undefined;
  if (!canSendImages(images)) {
    scheduleRender();
    return null;
  }

  const startedAt = Date.now();
  const message: UserMessage = {
    role: "user",
    text: placeholderText,
    images,
    metadata: createMessageMetadata(startedAt, state.model),
  };
  const queueTiming = options.queueTiming ?? (state.convId && isStreaming(state) ? "message-end" : undefined);
  const queuedMessage = queueTiming && state.convId
    ? { convId: state.convId, text: placeholderText, timing: queueTiming, images }
    : undefined;
  if (queuedMessage) {
    state.queuedMessages.push(queuedMessage);
  } else {
    state.messages.push(message);
    state.voiceMessage = { message, phase: "transcribing", frameIndex: 0 };
  }
  clearPrompt(state);
  state.pendingImages = [];
  state.scrollOffset = 0;
  const submission: SubmittedVoiceTranscription = {
    message,
    queuedMessage,
    startedAt,
    images,
    convId: state.convId,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    folderId: state.sidebar.currentFolderId,
    wasStreaming: isStreaming(state),
  };
  pendingVoiceSubmissions.add(submission);
  invalidateHistoryRenderCache(state);
  scheduleRender();
  return submission;
}

function completePendingVoiceTranscription(submission: SubmittedVoiceTranscription, finalText: string): void {
  const inlineCommands = applyInlineCommands(finalText.trim(), state);
  syncInlineCommandChanges(inlineCommands, submission.convId ?? state.convId);
  if (inlineCommands.efforts.length > 0) submission.effort = state.effort;
  if (inlineCommands.fastModes.length > 0) submission.fastMode = state.fastMode;
  const messageText = expandMacros(inlineCommands.text.trim());
  const hasImages = !!submission.images?.length;
  pendingVoiceSubmissions.delete(submission);

  if (!messageText && !hasImages) {
    removePendingVoiceEcho(submission);
    invalidateHistoryRenderCache(state);
    scheduleRender();
    return;
  }

  submission.message.text = messageText;
  submission.message.images = submission.images;
  submission.message.metadata = createMessageMetadata(submission.startedAt, submission.model, { endedAt: submission.startedAt });
  if (state.voiceMessage?.message === submission.message) state.voiceMessage = null;
  invalidateHistoryRenderCache(state);

  if (submission.queuedMessage) {
    submission.queuedMessage.text = messageText;
    submission.queuedMessage.images = submission.images;
    if (submission.convId) {
      const visible = isPendingVoiceVisible(submission);
      if (visible && !isStreaming(state)) {
        removePendingVoiceEcho(submission);
        state.messages.push(submission.message);
        state.pendingAI = createPendingAI(submission.startedAt, submission.model);
        daemon.sendMessage(submission.convId, messageText, submission.startedAt, submission.images);
      } else {
        daemon.queueMessage(submission.convId, messageText, submission.queuedMessage.timing, submission.images);
      }
    }
    scheduleRender();
    return;
  }

  const visible = isPendingVoiceVisible(submission);
  const targetStreaming = submission.wasStreaming || (visible && isStreaming(state));
  if (submission.convId && targetStreaming) {
    removePendingVoiceEcho(submission);
    if (visible) {
      state.queuedMessages.push({ convId: submission.convId, text: messageText, timing: "message-end", images: submission.images });
    }
    daemon.queueMessage(submission.convId, messageText, "message-end", submission.images);
    scheduleRender();
    return;
  }

  if (submission.convId) {
    if (visible) {
      state.pendingAI = createPendingAI(submission.startedAt, submission.model);
    }
    daemon.sendMessage(submission.convId, messageText, submission.startedAt, submission.images);
    scheduleRender();
    return;
  }

  if (state.convId === null) {
    if (targetStreaming) {
      removePendingVoiceEcho(submission);
      sendDirectly(messageText, submission.images);
    } else {
      sendDirectly(messageText, submission.images, {
        startedAt: submission.startedAt,
        echoMessage: submission.message,
      });
    }
    scheduleRender();
    return;
  }

  daemon.createConversation(submission.provider, submission.model, PENDING_TITLE, submission.effort, submission.fastMode, {
    text: messageText,
    startedAt: submission.startedAt,
    images: submission.images,
  }, submission.folderId);
  scheduleRender();
}

function failPendingVoiceTranscription(submission: SubmittedVoiceTranscription, message: string): void {
  pendingVoiceSubmissions.delete(submission);
  removePendingVoiceEcho(submission);
  pushSystemMessage(state, `✗ ${message}`, theme.error);
  invalidateHistoryRenderCache(state);
  scheduleRender();
}

function recallSelectedPendingVoiceTranscription(): boolean {
  const selectedEditItem = state.editMessagePrompt?.items[state.editMessagePrompt.selection] ?? null;
  if (!selectedEditItem) return false;
  const selectedMessage = selectedEditItem?.sourceMessage ?? selectedEditItem?.message;
  const recalledVoiceSubmission = selectedEditItem?.queuedMessage
    ? voiceInput?.recallSubmittedTranscription(selectedEditItem.queuedMessage, selectedEditItem.text) ?? null
    : selectedMessage
      ? voiceInput?.recallSubmittedTranscription(selectedMessage, selectedEditItem.text) ?? null
      : voiceInput?.recallSubmittedTranscription(null, selectedEditItem.text) ?? null;
  if (!recalledVoiceSubmission) return false;

  // This is a recall, not a historical edit/unwind.  The transcription job now
  // belongs to the prompt again, so remove every chat/queue echo and prevent any
  // daemon event from reattaching it while the transcript is still in flight.
  state.editMessagePrompt = null;
  deletePendingVoiceSubmissionAliases(recalledVoiceSubmission);
  removePendingVoiceEcho(recalledVoiceSubmission, {
    message: selectedEditItem?.message,
    sourceMessage: selectedEditItem?.sourceMessage,
    queuedMessage: selectedEditItem?.queuedMessage,
  });
  if (selectedEditItem?.message && selectedEditItem.message !== recalledVoiceSubmission.message) {
    removeMessageByReference(selectedEditItem.message);
  }
  if (selectedEditItem?.sourceMessage && selectedEditItem.sourceMessage !== recalledVoiceSubmission.message) {
    removeMessageByReference(selectedEditItem.sourceMessage);
  }
  if (selectedEditItem?.queuedMessage && selectedEditItem.queuedMessage !== recalledVoiceSubmission.queuedMessage) {
    const idx = state.queuedMessages.indexOf(selectedEditItem.queuedMessage);
    if (idx !== -1) state.queuedMessages.splice(idx, 1);
  }
  invalidateHistoryRenderCache(state);
  scheduleRender();
  return true;
}

function confirmSelectedEditMessage(): void {
  if (recallSelectedPendingVoiceTranscription()) return;
  if (selectedEditItemLooksLikePendingVoice()) {
    state.editMessagePrompt = null;
    pushSystemMessage(state, "✗ Voice transcription is still running but could not be recalled. The pending message was left untouched.", theme.warning);
    scheduleRender();
    return;
  }

  const er = confirmEditMessage(state);
  if (er.action === "edit_queued") {
    if (er.queuedMessage && isGlobalIdleQueuedMessage(er.queuedMessage)) {
      removeQueuedMessageByReference(state, er.queuedMessage);
      scheduleGlobalIdleQueuePump();
    } else if (state.convId) {
      removeLocalQueueEntry(state, state.convId, er.text);
      daemon.unqueueMessage(state.convId, er.text);
    }
  } else if (er.action === "edit_sent" && state.convId) {
    // The daemon's unwindTo handles abort internally if streaming,
    // waits for the stream to stop, then truncates.
    daemon.unwindConversation(state.convId, er.userMessageIndex);
  } else if (er.action === "edit_instructions") {
    // Text is placed in prompt as "/instructions <text>" — user edits and submits
    // through the normal slash command flow. Nothing else to do here.
  }
}

function requestDaemonRestart(): void {
  const child = spawn("exocortexd", ["restart"], {
    detached: true,
    stdio: "ignore",
  });
  let childErrorReported = false;
  child.once("error", (err) => {
    childErrorReported = true;
    pushSystemMessage(state, `✗ Failed to request daemon restart: ${err.message}`, theme.error);
    scheduleRender();
  });
  child.once("exit", (code, signal) => {
    if (code === 0 || childErrorReported) return;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    pushSystemMessage(state, `✗ exocortexd restart failed (${detail}).`, theme.error);
    scheduleRender();
  });
  child.unref();
}

function handleKey(key: KeyEvent): void {
  const inputBefore = state.inputBuffer;
  const voicePromptBufferBefore = state.voicePromptJobs.length > 0 || state.voicePrompt?.phase === "transcribing"
    ? state.inputBuffer
    : null;
  if (voiceInput?.handleKey(key)) return;
  if (key.event === "release") return;

  const result = handleFocusedKey(key, state, renderAfterLocalUiMutation);
  if (voicePromptBufferBefore !== null) {
    voiceInput?.syncPromptEdit(voicePromptBufferBefore);
  }
  maybeScheduleOpenAIPrewarm(inputBefore);

  switch (result.type) {
    case "submit":
      handleSubmit();
      return;
    case "queue_confirm": {
      if (confirmPendingVoiceQueuePrompt()) break;
      const qr = confirmQueueMessage(state);
      if (qr.action === "send_direct") {
        clearPrompt(state);
        state.scrollOffset = 0;
        sendDirectly(qr.text, qr.images);
      } else if (qr.action === "queue") {
        daemon.queueMessage(qr.convId, qr.text, qr.timing, qr.images);
      }
      break;
    }
    case "queue_cancel":
      if (cancelPendingVoiceQueuePrompt()) break;
      cancelQueuePrompt(state);
      break;
    case "edit_message_confirm": {
      confirmSelectedEditMessage();
      break;
    }
    case "edit_message_cancel":
      cancelEditMessage(state);
      break;
    case "open_target":
      openTargetDetached(result.target);
      break;
    case "quit":
      running = false;
      break;
    case "abort":
      if (isStreaming(state)) {
        const convId = state.convId ?? pendingNewConversationConvId;
        if (convId) {
          showLocalPreContentInterrupt(convId);
          daemon.abort(convId);
        }
      }
      break;
    case "background_tool":
      if (isStreaming(state) && state.convId) daemon.backgroundTool(state.convId);
      break;
    case "restart_daemon":
      requestDaemonRestart();
      break;
    case "load_conversation":
      state.folderInstructionsDoc = null;
      daemon.loadConversation(result.convId);
      break;
    case "open_folder_instructions":
      if (state.convId) unsubscribeUnlessWaitingForQueuedMessages(state.convId);
      openFolderInstructionsDocument(state, result.folderId);
      daemon.loadFolderInstructions(result.folderId);
      break;
    case "load_tool_outputs":
      daemon.loadToolOutputs(result.convId);
      break;
    case "new_conversation":
      startNewConversation();
      break;
    case "delete_conversation":
      daemon.deleteConversation(result.convId);
      clearAllQueuedMessagesForConversation(state, result.convId);
      // If deleting the current conversation, clear the chat
      if (state.convId === result.convId) {
        state.convId = null;
        state.messages = [];
        clearPendingAI(state);
        state.contextTokens = 0;
        state.goal = null;
        resetToolOutputState(state);
        resetNewConversationDefaults(state);
      }
      break;
    case "delete_conversations": {
      daemon.deleteConversations(result.convIds);
      for (const convId of result.convIds) clearAllQueuedMessagesForConversation(state, convId);
      if (state.convId && result.convIds.includes(state.convId)) {
        state.convId = null;
        state.messages = [];
        clearPendingAI(state);
        state.contextTokens = 0;
        state.goal = null;
        resetToolOutputState(state);
      }
      break;
    }
    case "delete_folder":
      daemon.deleteFolder(result.folderId, result.mode);
      break;
    case "undo_delete":
      daemon.undoDelete();
      break;
    case "redo_delete":
      daemon.redoDelete();
      break;
    case "mark_conversation":
      daemon.markConversation(result.convId, result.marked);
      break;
    case "rename_conversation":
      daemon.renameConversation(result.convId, result.title);
      break;
    case "pin_conversation":
      daemon.pinConversation(result.convId, result.pinned);
      break;
    case "pin_folder":
      daemon.pinFolder(result.folderId, result.pinned);
      break;
    case "pin_sidebar_items":
      daemon.pinSidebarItems(result.pins);
      break;
    case "move_conversation":
      daemon.moveConversation(result.convId, result.direction);
      break;
    case "move_sidebar_item":
      daemon.moveSidebarItem(result.item, result.direction);
      break;
    case "move_sidebar_items":
      daemon.moveSidebarItems(result.items, result.parentId, result.before, { preservePinned: result.preservePinned, placement: result.placement });
      break;
    case "clone_conversation":
      daemon.cloneConversation(result.convId);
      break;
    case "create_folder":
      daemon.createFolder(result.name, result.parentId, result.items);
      break;
    case "rename_folder":
      daemon.renameFolder(result.folderId, result.name);
      break;
    case "handled":
      break;
  }

  renderAfterLocalUiMutation();
}

function handleMouse(ev: MouseEvent): void {
  if (voiceInput?.isBlockingMouse()) return;

  // Motion events: only render if something visual changed (focus switch, drag selection)
  if (ev.action === "motion") {
    const prevFocus = state.panelFocus;
    const prevCursorRow = state.historyCursor.row;
    const prevCursorCol = state.historyCursor.col;
    handleMouseEvent(ev, state);
    if (state.panelFocus !== prevFocus
        || state.historyCursor.row !== prevCursorRow
        || state.historyCursor.col !== prevCursorCol) {
      renderAfterLocalUiMutation();
    }
    return;
  }

  const result = handleMouseEvent(ev, state);

  switch (result.type) {
    case "load_conversation":
      state.folderInstructionsDoc = null;
      daemon.loadConversation(result.convId);
      break;
    case "open_folder_instructions":
      if (state.convId) unsubscribeUnlessWaitingForQueuedMessages(state.convId);
      openFolderInstructionsDocument(state, result.folderId);
      daemon.loadFolderInstructions(result.folderId);
      break;
    case "edit_message_confirm":
      confirmSelectedEditMessage();
      break;
    case "handled":
      break;
    // Mouse events don't trigger most actions — ignore other result types
    default:
      break;
  }

  renderAfterLocalUiMutation();
}

function scheduleReconnectAttempt(): void {
  if (!running || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    void reconnectToDaemon();
  }, RECONNECT_DELAY_MS);
}

function restoreDaemonSessionAfterReconnect(hadPendingCommands: boolean): void {
  pushSystemMessage(state, "✓ Reconnected to daemon.", "success");

  // Always refresh daemon-derived top-level state. If commands were queued while
  // disconnected, let those replayed commands drive any conversation-specific
  // reloads to avoid issuing duplicate loads.
  daemon.ping();
  if (!hadPendingCommands && state.convId) daemon.loadConversation(state.convId);
  scheduleGlobalIdleQueuePump();
}

async function reconnectToDaemon(): Promise<void> {
  if (!running || reconnecting) return;
  reconnecting = true;
  const hadPendingCommands = daemon.hasPendingCommands;

  try {
    await daemon.connect();
  } catch {
    if (!running) {
      reconnecting = false;
      return;
    }
    scheduleReconnectAttempt();
    scheduleRender();
    return;
  }

  reconnecting = false;
  clearReconnectTimer();
  restoreDaemonSessionAfterReconnect(hadPendingCommands);
  scheduleRender();
}

function handleDaemonConnectionLost(): void {
  voiceInput?.cleanup();
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  clearStreamTick();
  clearStreamFinishedPingTimer();
  clearGlobalIdleQueuePumpTimer();
  clearPrewarmTimer();
  pushSystemMessage(state, "✗ Lost connection to daemon.", theme.error);
  scheduleRender();
  void reconnectToDaemon();
}

// ── Terminal setup ──────────────────────────────────────────────────

function setupTerminal(): void {
  const cursorColorSeq = theme.cursorColor ? set_cursor_color(theme.cursorColor) : '';
  process.stdout.write(enter_alt + hide_cursor + enable_bracketed_paste + enable_kitty_kbd + enable_mouse + cursorColorSeq);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalSetUp = true;
}

function restoreTerminal(): void {
  if (!terminalSetUp) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const cursorResetSeq = theme.cursorColor ? reset_cursor_color : '';
  process.stdout.write(disable_mouse + disable_kitty_kbd + disable_bracketed_paste + show_cursor + cursorResetSeq + leave_alt);
  terminalSetUp = false;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  startupProfileMark("main_begin");
  daemon = new DaemonClient(onDaemonEvent);
  daemon.onConnectionLost(handleDaemonConnectionLost);
  voiceInput = createVoiceInputController(state, daemon, scheduleRender, {
    submitPendingTranscription: submitPendingVoiceTranscription,
    completePendingTranscription: completePendingVoiceTranscription,
    failPendingTranscription: failPendingVoiceTranscription,
    recallPendingTranscription: deletePendingVoiceSubmissionAliases,
    shouldQueuePendingTranscription: () => !!state.convId && isStreaming(state),
    openPendingTranscriptionQueuePrompt: openPendingVoiceQueuePrompt,
    invalidateHistory: () => invalidateHistoryRenderCache(state),
  });
  try {
    await daemon.connect();
    startupProfileMark("daemon_connected");
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Request initial usage data from daemon
  daemon.ping();
  startupProfileMark("ping_sent");

  setupTerminal();
  startupProfileMark("terminal_setup_done");

  process.stdout.on("resize", () => {
    preserveViewportAcrossResize(
      state,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );
    invalidateFrame(state);
    // Resize/expose repaints should not wait for the normal frame throttle:
    // the terminal may have just revealed stale cells from the previous window
    // geometry, so repaint the invalidated full frame immediately.
    renderImmediately();
  });

  const initialRenderStartedAt = performance.now();
  render(state);
  startupProfileMark("initial_render_done", { renderMs: Math.round((performance.now() - initialRenderStartedAt) * 1000) / 1000 });

  // Buffer stdin across bracketed-paste chunk boundaries so large pastes
  // aren't split into individual keystrokes (which turns newlines into submits).
  const pasteBuffer = new PasteBuffer(processInput);
  let shouldStripStartupLaunchEcho = true;
  const startupInputSanitizeUntil = Date.now() + STARTUP_INPUT_SANITIZE_MS;

  function processInput(str: string): void {
    const events = parseInput(str);
    for (const ev of events) {
      if (ev.type === "mouse") {
        handleMouse(ev);
      } else {
        handleKey(ev);
      }
      if (!running) break;
    }
    if (!running) cleanup();
  }

  process.stdin.on("data", (data: Buffer) => {
    if (shouldStripStartupLaunchEcho) {
      shouldStripStartupLaunchEcho = false;
      if (Date.now() <= startupInputSanitizeUntil) {
        data = Buffer.from(stripStartupLaunchEcho(data.toString("utf8")), "utf8");
        if (data.length === 0) return;
      }
    }
    const ready = pasteBuffer.feed(data);
    if (ready !== null) processInput(ready);
  });
}

function cleanup(): void {
  running = false;
  clearRenderTimer();
  clearStreamTick();
  clearStreamFinishedPingTimer();
  clearGlobalIdleQueuePumpTimer();
  clearPrewarmTimer();
  clearReconnectTimer();
  voiceInput?.cleanup();
  daemon?.disconnect();
  restoreTerminal();
  process.exit(0);
}

process.on("exit", () => restoreTerminal());
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

main().catch((err) => {
  restoreTerminal();
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
