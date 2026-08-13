/**
 * Exocortex TUI — terminal client for exocortexd.
 *
 * Connects to the daemon via Unix socket, displays a conversational UI,
 * and forwards user input. All AI, auth, and streaming logic lives in
 * the daemon — this is purely a presentation layer.
 *
 * Usage: bun run src/main.ts
 */

import { randomUUID } from "node:crypto";
import { DaemonClient } from "./client";
import { parseInput, PasteBuffer, type KeyEvent, type MouseEvent } from "./input";
import { TerminalClipboardClient, TerminalControlBuffer } from "./terminalclipboard";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { clearPrompt } from "./promptstate";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { applyInlineCommands, type InlineCommandApplication } from "./inlineeffort";
import { advanceDeferredHistoryRender, hasDeferredHistoryRenderWork, render, invalidateHistoryRenderCache } from "./render";
import { preserveViewportAcrossResize } from "./chatscroll";
import { invalidateFrame } from "./frame";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste, query_clipboard_paste_events, enable_clipboard_paste_events, disable_clipboard_paste_events, enable_kitty_kbd, disable_kitty_kbd, enable_mouse, disable_mouse, set_cursor_color, reset_cursor_color } from "./terminal";
import { createInitialState, isStreaming, clearPendingAI, clearStreamingTailMessages, focusPrompt, modelSupportsImages, openFolderInstructionsDocument, pushSystemMessage, renderFolderInstructionsDocument, resetDraftConversationState, resetHistoryPagination, resetNewConversationDefaults, resetToolOutputState } from "./state";
import { createMessageMetadata, createPendingAI, type ImageAttachment, type UserMessage } from "./messages";
import { loginPromptProviders } from "./providerselection";
import { handleEvent } from "./events";
import { CONV_SCOPED } from "./events/stream-sequence";
import {
  clearAllQueuedMessagesForConversation,
  confirmQueueMessage,
  cancelQueuePrompt,
  enqueueQueuedCommand,
  enqueueGlobalIdleMessage,
  openQueuePrompt,
  removeNewConversationQueuedMessage,
  removeQueuedMessageByReference,
} from "./queue";
import {
  applyOptimisticEditMessageUnwind,
  cancelEditMessage,
  classifyPendingEditMessageUnwindEvent,
  confirmEditMessage,
  type PendingEditMessageUnwind,
} from "./editmessage";
import { generateTitle, PENDING_TITLE } from "./titlegen";
import { theme } from "./theme";
import { openTargetDetached } from "./openable";
import { msUntilNextElapsedSecond } from "./time";
import type { DaemonShutdownMode, Event, QueueTiming } from "./protocol";
import { createVoiceInputController, type SubmittedVoiceTranscription, type VoiceInputController } from "./voiceinput";
import { editItemLooksLikePendingVoiceSubmission, pendingVoicePreviewTextsMatch, pendingVoiceSubmissionsMatch, removePendingVoiceEchoes } from "./pendingvoice";
import { startReplayConversation } from "./replay";
import { startManualCompaction } from "./compact";
import { runStreamFinishedPing, shouldPingForStreamCompletion } from "./ping";
import { stripStartupLaunchEcho } from "./startupinput";
import { focusedConversationTasks, msUntilTaskPanelEntryUpdate } from "./activitypanel";
import { beginOlderHistoryLoad, INITIAL_BUFFER_ADDITIONAL_TURNS, OLDER_HISTORY_PAGE_TURNS, shouldLoadOlderHistory } from "./historypagination";
import { PERFORMANCE_PROFILING_ENABLED } from "@exocortex/shared/performance-profiling";
import { log } from "./log";
import { CallMediaController } from "./call-media";
import { formatMicGainDb, loadMicGainDb, saveMicGainDb } from "./mic-gain";
import { applyTuiStartingState, availableStartingConversationId, captureTuiStartingState, loadTuiStartingState, saveTuiStartingState } from "./startingstate";
import { closeBtwSession, startBtwSession } from "./btw/controller";
import { formatConnectionLostNotice } from "./events/notices";

// ── State ───────────────────────────────────────────────────────────

const savedStartingState = loadTuiStartingState();
const state = createInitialState();
if (savedStartingState) applyTuiStartingState(state, savedStartingState);
let pendingStartingState = savedStartingState;
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
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
let deferredHistoryRenderTimer: ReturnType<typeof setTimeout> | null = null;
let lastPrewarmKey: string | null = null;
let lastPrewarmAt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let eventLoopLagTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;
let reconnectNavigationTarget: string | null = null;
let terminalSetUp = false;
let terminalClipboardClient: TerminalClipboardClient | null = null;
let terminalControlBuffer: TerminalControlBuffer | null = null;
let voiceInput: VoiceInputController | null = null;
let callMedia: CallMediaController | null = null;
let pendingVoiceQueuePrompt = false;
let pendingNewConversationConvId: string | null = null;
let pendingLocalInterruptConvId: string | null = null;
let pendingEditMessageUnwind: PendingEditMessageUnwind | null = null;
// Local-only user-message echoes whose audio jobs are still transcribing. They
// are intentionally withheld from the daemon until the TUI has final text.
const pendingVoiceSubmissions = new Set<SubmittedVoiceTranscription>();
const PREWARM_DEBOUNCE_MS = 700;
const PREWARM_COOLDOWN_MS = 30_000;

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

function unsubscribeConversation(convId: string): void {
  daemon.unsubscribe(convId);
}

function isBackgroundConversationScopedEvent(event: Event): boolean {
  if (!CONV_SCOPED.has(event.type) || !("convId" in event)) return false;
  if (event.convId === state.convId) return false;
  return event.type !== "tool_policy" || event.convId !== state.pendingToolPolicyDraftId;
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

const FRAME_DELAY_MS = 16;
const STREAM_CHUNK_FRAME_DELAY_MS = 50;
const EVENT_LOOP_CHECK_INTERVAL_MS = 1_000;
const EVENT_LOOP_LAG_WARN_MS = 250;

function performRender(): number {
  const renderStartedAt = performance.now();
  render(state);
  const renderMs = performance.now() - renderStartedAt;
  if (PERFORMANCE_PROFILING_ENABLED && renderMs >= 100) {
    log("warn", `perf: tui_slow_render ${JSON.stringify({
      convId: state.convId,
      renderMs,
      messages: state.messages.length,
      pendingAI: state.pendingAI !== null,
      scrollOffset: state.scrollOffset,
      historyFocus: state.panelFocus === "chat" && state.chatFocus === "history",
      showToolOutput: state.showToolOutput,
    })}`);
  }
  resetStreamTick();
  maybeReportStartupProfile(renderMs);
  scheduleDeferredHistoryRenderWork();
  return renderMs;
}

function renderImmediately(): number {
  clearRenderTimer();
  return performRender();
}

function renderAfterLocalUiMutation(): number {
  // IMPORTANT: do not replace this with scheduleRender(). Local keyboard/mouse
  // mutations (prompt edits, chat-history cursor/scroll, focus changes) must be
  // visible immediately. Waiting for the 16ms daemon/stream frame scheduler makes
  // chat-history navigation feel laggy and can reintroduce visible tty tearing.
  // Retained-frame diffing keeps these immediate local paints cheap.
  return renderImmediately();
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
    case "btw_text_chunk":
    case "btw_thinking_chunk":
    case "btw_content":
      return STREAM_CHUNK_FRAME_DELAY_MS;
    default:
      return FRAME_DELAY_MS;
  }
}

/** Re-render active stream/task durations on the next exact second boundary. */
function resetStreamTick(): void {
  clearStreamTick();
  if (state.contextCompactionStartedAt != null || state.historyLoadingOlder) {
    streamTickTimer = setTimeout(scheduleRender, 80);
    return;
  }
  const tickDelays: number[] = [];
  const startedAt = state.pendingAI?.metadata?.startedAt;
  if (isStreaming(state) && typeof startedAt === "number") {
    tickDelays.push(msUntilNextElapsedSecond(startedAt));
  }
  for (const task of focusedConversationTasks(state)) {
    const delay = msUntilTaskPanelEntryUpdate(task);
    if (delay !== null) tickDelays.push(delay);
  }
  if (tickDelays.length > 0) {
    streamTickTimer = setTimeout(scheduleRender, Math.min(...tickDelays));
  }
}

function requestOlderHistory(turns: number, requestSource: "initial-backfill" | "viewport" = "viewport"): boolean {
  const request = beginOlderHistoryLoad(state, turns);
  if (!request) return false;
  state.historyLoadingRequestId = daemon.loadConversationHistory(
    request.convId,
    request.beforeEntryIndex,
    request.turns,
    requestSource,
  );
  return true;
}

function maybeRequestOlderHistory(): void {
  if (shouldLoadOlderHistory(state)) requestOlderHistory(OLDER_HISTORY_PAGE_TURNS);
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function onDaemonEvent(event: Event): void {
  const eventStartedAt = PERFORMANCE_PROFILING_ENABLED ? performance.now() : 0;
  callMedia?.handleEvent(event);
  if (pendingEditMessageUnwind) {
    const pending = pendingEditMessageUnwind;
    const unwindEvent = classifyPendingEditMessageUnwindEvent(pending, event);
    if (unwindEvent === "ignore") return;
    if (unwindEvent === "complete") {
      pendingEditMessageUnwind = null;
      if (pendingLocalInterruptConvId === pending.convId) pendingLocalInterruptConvId = null;
      // A replay receipt proves the cut committed, but newer turns may have been
      // appended before reconnect. Its original suffix boundary cannot reconcile
      // that transcript, so load the current canonical window.
      if (event.type === "conversation_unwound"
          && event.status === "already_applied"
          && state.convId === pending.convId) {
        daemon.loadConversation(pending.convId);
      }
      // The targeted event patches the sidebar everywhere but mutates transcript
      // state only when this conversation is still open, so it cannot navigate
      // back to a conversation the user left during abort cleanup.
    } else if (unwindEvent === "failed") {
      pendingEditMessageUnwind = null;
      // The local transcript was only an optimistic projection. Restore the
      // daemon's untouched canonical history when validation or abort cleanup
      // made the durable unwind fail.
      if (state.convId === pending.convId) daemon.loadConversation(pending.convId);
    }
  }
  if (event.type === "conversation_loaded" && event.convId === reconnectNavigationTarget) {
    reconnectNavigationTarget = null;
  } else if (event.type === "error" && event.convId === reconnectNavigationTarget) {
    // A conversation selected while disconnected may have been deleted before
    // reconnect. Restore the previously active socket subscription instead of
    // leaving this TUI detached from every conversation.
    reconnectNavigationTarget = null;
    if (state.convId && state.convId !== event.convId) daemon.loadConversation(state.convId);
  }

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
    return;
  }

  const activeConvIdBeforeEvent = state.convId;
  const wasUpdatedConversationStreaming = event.type === "conversation_updated"
    ? state.sidebar.conversations.find((c) => c.id === event.summary.id)?.streaming ?? false
    : false;

  invalidateHistoryRenderCache(state);
  handleEvent(event, state, daemon);
  reattachVisiblePendingVoiceSubmissions();
  if (PERFORMANCE_PROFILING_ENABLED && event.type === "tool_outputs_loaded") {
    const applyMs = performance.now() - eventStartedAt;
    log(applyMs >= 100 ? "warn" : "info", `perf: tool_outputs tui_applied ${JSON.stringify({
      reqId: event.reqId ?? null,
      convId: event.convId,
      outputs: event.outputs.length,
      applyMs,
      accepted: event.convId === state.convId,
      expanded: state.showToolOutput,
      historyLines: state.historyLines.length,
    })}`);
  }
  if (PERFORMANCE_PROFILING_ENABLED && event.type === "conversation_history_loaded") {
    const applyMs = performance.now() - eventStartedAt;
    log(applyMs >= 100 ? "warn" : "info", `perf: conversation_history tui_applied ${JSON.stringify({
      reqId: event.reqId ?? null,
      convId: event.convId,
      requestSource: event.requestSource ?? null,
      applyMs,
      entries: event.entries.length,
      historyTotalEntries: event.historyTotalEntries,
      accepted: event.convId === state.convId,
    })}`);
  }

  if (event.type === "conversations_list") {
    startupProfileConversationCount = event.conversations.length;
    startupProfileConversationsLoaded = true;
    startupProfileMark("conversations_list_handled", { conversationCount: state.sidebar.conversations.length });
    if (pendingStartingState) {
      const startingState = pendingStartingState;
      pendingStartingState = null;
      const convId = availableStartingConversationId(startingState, event.conversations);
      if (convId && state.convId === convId) daemon.loadConversation(convId);
    }
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
    // Queue shadows are NOT cleared here — the daemon drains one queued
    // message at a time and re-queues the rest. Each consumed message
    // triggers a user_message event, whose handler in events.ts removes
    // the corresponding shadow individually.
  }

  // A streaming true→false summary is the daemon's authoritative signal that
  // the entire turn chain settled. Queued and goal-continuation handoffs remain
  // streaming=true, so the notification can run immediately without a debounce.
  if (event.type === "conversation_updated" && shouldPingForStreamCompletion({
    updatedConvId: event.summary.id,
    wasStreaming: wasUpdatedConversationStreaming,
    isStreaming: event.summary.streaming,
    streamStopReason: event.streamStopReason,
  })) {
    // Paint green before focus detection or sound setup can do synchronous I/O.
    renderImmediately();
    runStreamFinishedPing({
      completedConvId: event.summary.id,
      activeConvId: activeConvIdBeforeEvent,
      isCompletedConvStreaming: event.summary.streaming,
      notificationsMuted: event.summary.notificationsMuted === true,
    });
  }

  if (maybeFlushPendingAuthQueue()) {
    return;
  }

  if (event.type === "streaming_started" && event.convId === state.convId && event.snapshotKind !== "heartbeat") {
    renderImmediately();
    return;
  }

  if (event.type === "conversation_loaded") {
    // Paint the five-turn opening window before beginning the silent expansion
    // to the normal fifteen-turn in-chat buffer.
    const applyMs = PERFORMANCE_PROFILING_ENABLED ? performance.now() - eventStartedAt : 0;
    const renderMs = renderImmediately();
    if (PERFORMANCE_PROFILING_ENABLED) {
      const totalMs = performance.now() - eventStartedAt;
      log(totalMs >= 250 ? "warn" : "info", `perf: conversation_open tui_applied ${JSON.stringify({
        reqId: event.reqId ?? null,
        convId: event.convId,
        applyMs,
        renderMs,
        totalMs,
        entries: event.entries.length,
        historyTotalEntries: event.historyTotalEntries ?? null,
      })}`);
    }
    if (requestOlderHistory(INITIAL_BUFFER_ADDITIONAL_TURNS, "initial-backfill")) scheduleRender(0);
    return;
  }

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

function attachTerminalClipboardImage(image: ImageAttachment): void {
  if (!modelSupportsImages(state)) {
    log("warn", `tui: terminal clipboard image paste failed: image inputs are not supported by ${state.provider}/${state.model}`);
    pushSystemMessage(state, `✗ Image inputs are not supported by ${state.provider}/${state.model}. Switch to a vision-capable model to paste images.`, theme.error);
    scheduleRender();
    return;
  }

  const inputBefore = state.inputBuffer;
  state.pendingImages.push(image);
  focusPrompt(state);
  maybeScheduleOpenAIPrewarm(inputBefore);
  renderAfterLocalUiMutation();
}

function ensurePendingToolPolicyDraftId(): string {
  state.pendingToolPolicyDraftId ??= generateClientConversationId();
  return state.pendingToolPolicyDraftId;
}

function abandonPendingToolPolicyDraft(): void {
  const draftId = state.pendingToolPolicyDraftId;
  if (draftId) daemon.clearDraftToolPolicy(draftId);
  state.pendingToolPolicyDraftId = null;
  if (!state.convId) state.activeToolPolicy = null;
}

function startNewConversation(): void {
  const wasFolderInstructionsDoc = state.folderInstructionsDoc !== null;
  pendingNewConversationConvId = null;
  if (state.convId) {
    unsubscribeConversation(state.convId);
  }
  abandonPendingToolPolicyDraft();
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

  // Do not race a newly edited message against the daemon's durable unwind.
  // The prompt remains editable and intact; the canonical response normally
  // arrives well before the user finishes editing.
  if (pendingEditMessageUnwind?.convId === state.convId) {
    pushSystemMessage(state, "Finishing conversation rewind; submit again in a moment.", theme.warning);
    scheduleRender();
    return;
  }

  // Slash commands (only when no images attached — pure text commands)
  if (text && !hasImages) {
    const cmdResult = tryCommand(text, state);
    if (cmdResult) {
      if (cmdResult.queue && cmdResult.queuedCommand) {
        syncInlineCommandChanges({
          text: "",
          efforts: cmdResult.efforts ?? [],
          fastModes: cmdResult.fastModes ?? [],
          queue: cmdResult.queue,
        });
        enqueueQueuedCommand(state, daemon, cmdResult.queuedCommand, cmdResult.queue);
        scheduleRender();
        return;
      }
      switch (cmdResult.type) {
        case "quit":
          running = false;
          return;
        case "new_conversation":
          startNewConversation();
          break;
        case "create_conversation_for_instructions":
          if (state.convId) unsubscribeConversation(state.convId);
          state.convId = null;
          state.btw = null;
          resetHistoryPagination(state);
          state.contextTokens = 0;
          resetNewConversationDefaults(state);
          state.pendingSystemInstructions = cmdResult.text;
          state.pendingGenerateTitleOnCreate = false;
          {
            const draftId = state.pendingToolPolicyDraftId ?? undefined;
            daemon.createConversation(
              state.provider, state.model, "", state.effort, state.fastMode,
              undefined, state.draftFolderId, undefined, draftId,
              undefined, undefined, undefined, undefined, draftId,
            );
          }
          break;
        case "replay_requested":
          if (startReplayConversation(state, daemon)) {
            renderImmediately();
            return;
          }
          break;
        case "compact_requested":
          if (startManualCompaction(state, daemon)) {
            renderImmediately();
            return;
          }
          break;
        case "btw_requested":
          startBtwSession(state, daemon, cmdResult.query);
          break;
        case "btw_close_requested":
          closeBtwSession(state, daemon);
          break;
        case "call_requested":
          if (state.convId) {
            daemon.startCall(state.convId, cmdResult.voice);
          } else {
            const draftId = state.pendingToolPolicyDraftId ?? undefined;
            daemon.createConversationForCall(
              state.provider,
              state.model,
              state.effort,
              state.fastMode,
              state.draftFolderId,
              cmdResult.voice,
              draftId,
              draftId,
            );
          }
          break;
        case "hangup_requested":
          if (state.convId) {
            const callId = callMedia?.callIdForConversation(state.convId);
            if (callId) daemon.stopCall(state.convId, callId);
            else pushSystemMessage(state, "No local TUI call is active for this conversation.");
          }
          break;
        case "mic_gain_changed": {
          callMedia?.setMicGainDb(cmdResult.gainDb);
          try {
            const gainDb = saveMicGainDb(cmdResult.gainDb);
            pushSystemMessage(state, `Microphone gain set to ${formatMicGainDb(gainDb)}.`);
          } catch (error) {
            pushSystemMessage(
              state,
              `Microphone gain changed for this TUI session, but saving failed: ${error instanceof Error ? error.message : String(error)}`,
              theme.warning,
            );
          }
          break;
        }
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
            const draftId = state.pendingToolPolicyDraftId ?? undefined;
            daemon.createConversation(
              state.provider,
              state.model,
              undefined,
              state.effort,
              state.fastMode,
              undefined,
              state.draftFolderId,
              objective,
              draftId,
              cmdResult.pausable,
              cmdResult.completable,
              undefined,
              undefined,
              draftId,
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
        case "tool_policy":
          if (state.convId) {
            if (cmdResult.mutation) daemon.setToolPolicy(state.convId, cmdResult.mutation);
            else daemon.getToolPolicy(state.convId);
          } else {
            const draftId = ensurePendingToolPolicyDraftId();
            if (cmdResult.mutation) daemon.setDraftToolPolicy(draftId, cmdResult.mutation);
            else daemon.getDraftToolPolicy(draftId);
          }
          break;
        case "set_system_instructions":
          if (state.convId) daemon.setSystemInstructions(state.convId, cmdResult.text);
          break;
        case "login":
          daemon.login(cmdResult.provider ?? state.provider, cmdResult.apiKey, cmdResult.action, cmdResult.target, cmdResult.method);
          break;
        case "account":
          daemon.account(cmdResult.provider ?? "openai", cmdResult.target);
          break;
        case "usage_reset_requested":
          daemon.consumeUsageReset(cmdResult.provider);
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
      const draftToolPolicyId = queueingDraftConversation ? state.pendingToolPolicyDraftId ?? undefined : undefined;
      const convId = state.convId ?? draftToolPolicyId ?? generateClientConversationId();
      const folderId = state.draftFolderId;
      const waitTarget = inlineCommands.queue;
      const queued = enqueueGlobalIdleMessage(state, convId, messageText, images, queueingDraftConversation ? {
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
      }
      daemon.queueMessage(convId, messageText, "message-end", images, {
        queueId: queued.id,
        source: "global-idle",
        target: queued.target ?? "conversation",
        provider: queued.provider,
        model: queued.model,
        effort: queued.effort,
        fastMode: queued.fastMode,
        folderId: queued.folderId,
        waitTarget: queued.waitTarget,
        draftToolPolicyId,
      });
      clearPrompt(state);
      state.pendingImages = [];
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
    enqueuePendingAuthMessage(messageText, images);
    showLoginRequiredPrompt();
    scheduleRender();
    return;
  }

  clearPrompt(state);
  state.pendingImages = [];
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
    const queueId = randomUUID();
    state.queuedMessages.push({ id: queueId, optimistic: true, convId: state.convId, text: messageText, timing, images, source: "daemon", createdAt: Date.now() });
    clearPrompt(state);
    state.pendingImages = [];
    daemon.queueMessage(state.convId, messageText, timing, images, { queueId });
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
    const draftToolPolicyId = state.pendingToolPolicyDraftId ?? undefined;
    const convId = options.convId ?? draftToolPolicyId ?? generateClientConversationId();
    pendingNewConversationConvId = convId;
    state.pendingSend.active = false;
    state.pendingSend.text = "";
    state.pendingSend.images = undefined;
    state.pendingGenerateTitleOnCreate = false;
    daemon.createConversation(
      state.provider, state.model, PENDING_TITLE, state.effort, state.fastMode,
      { text: messageText, startedAt, images },
      options.folderId === undefined ? state.draftFolderId : options.folderId,
      undefined, convId, undefined, undefined, undefined, undefined, draftToolPolicyId,
    );
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
    folderId: state.convId ? state.sidebar.currentFolderId : state.draftFolderId,
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
        const queueId = submission.queuedMessage.id ?? randomUUID();
        submission.queuedMessage.id = queueId;
        submission.queuedMessage.optimistic = true;
        submission.queuedMessage.source = "daemon";
        submission.queuedMessage.createdAt ??= Date.now();
        daemon.queueMessage(submission.convId, messageText, submission.queuedMessage.timing, submission.images, { queueId });
      }
    }
    scheduleRender();
    return;
  }

  const visible = isPendingVoiceVisible(submission);
  const targetStreaming = submission.wasStreaming || (visible && isStreaming(state));
  if (submission.convId && targetStreaming) {
    removePendingVoiceEcho(submission);
    const queueId = randomUUID();
    if (visible) {
      state.queuedMessages.push({ id: queueId, optimistic: true, convId: submission.convId, text: messageText, timing: "message-end", images: submission.images, source: "daemon", createdAt: Date.now() });
    }
    daemon.queueMessage(submission.convId, messageText, "message-end", submission.images, { queueId });
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
    if (er.queuedMessage) {
      removeQueuedMessageByReference(state, er.queuedMessage);
      if (er.queuedMessage.id) {
        state.pendingQueueRemovalIds.add(er.queuedMessage.id);
        daemon.unqueueMessage(er.queuedMessage.id);
      }
    }
  } else if (er.action === "edit_sent" && state.convId) {
    const convId = state.convId;
    const optimisticallyUnwound = applyOptimisticEditMessageUnwind(state, er.userMessageIndex);
    if (optimisticallyUnwound) {
      clearStreamTick();
      pendingLocalInterruptConvId = null;
      invalidateHistoryRenderCache(state);
    }
    // The daemon's unwindTo handles abort internally if streaming,
    // waits for the stream to stop, then truncates.
    const reqId = daemon.unwindConversation(convId, er.userMessageIndex, er.expectedStartedAt, er.targetFingerprint);
    if (optimisticallyUnwound) pendingEditMessageUnwind = { convId, reqId };
  } else if (er.action === "edit_instructions") {
    // Text is placed in prompt as "/instructions <text>" — user edits and submits
    // through the normal slash command flow. Nothing else to do here.
  }
}

function requestDaemonRestart(): void {
  // Do not add a local lifecycle message here. The daemon records any interrupted
  // turn as "Daemon restarted" and announces the planned shutdown so the generic
  // connection-loss notice can be suppressed.
  daemon.restartDaemon();
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
        sendDirectly(qr.text, qr.images);
      } else if (qr.action === "queue") {
        daemon.queueMessage(qr.convId, qr.text, qr.timing, qr.images, { queueId: qr.queueId });
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
    case "btw_close":
      closeBtwSession(state, daemon);
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
          // Bind Ctrl+Q to the stream visible at keypress time. The current turn
          // can finish and start a queued successor before this command reaches
          // the daemon; that successor must not inherit the stale interrupt.
          const expectedStartedAt = state.pendingAI?.metadata?.startedAt;
          showLocalPreContentInterrupt(convId);
          daemon.abort(convId, expectedStartedAt);
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
      {
        const reqId = daemon.loadConversation(result.convId);
        const renderMs = renderAfterLocalUiMutation();
        if (PERFORMANCE_PROFILING_ENABLED && renderMs >= 100) {
          log("warn", `perf: conversation_open tui_request_render ${JSON.stringify({ reqId, convId: result.convId, renderMs, input: "keyboard" })}`);
        }
      }
      return;
    case "open_folder_instructions":
      if (state.convId) unsubscribeConversation(state.convId);
      openFolderInstructionsDocument(state, result.folderId);
      daemon.loadFolderInstructions(result.folderId);
      break;
    case "load_tool_outputs":
      daemon.loadToolOutputs(result.convId, result.toolCallIds);
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
        state.draftFolderId = state.sidebar.currentFolderId;
        state.messages = [];
        clearPendingAI(state);
        state.contextTokens = 0;
        state.goal = null;
        state.btw = null;
        resetToolOutputState(state);
        resetHistoryPagination(state);
        resetNewConversationDefaults(state);
      }
      break;
    case "delete_conversations": {
      daemon.deleteConversations(result.convIds);
      for (const convId of result.convIds) clearAllQueuedMessagesForConversation(state, convId);
      if (state.convId && result.convIds.includes(state.convId)) {
        state.convId = null;
        state.draftFolderId = state.sidebar.currentFolderId;
        state.messages = [];
        clearPendingAI(state);
        state.contextTokens = 0;
        state.goal = null;
        state.btw = null;
        resetToolOutputState(state);
        resetHistoryPagination(state);
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
    case "mute_conversation":
      daemon.muteConversation(result.convId, result.muted);
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
    case "mute_folder":
      daemon.muteFolder(result.folderId, result.muted);
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

  maybeRequestOlderHistory();
  renderAfterLocalUiMutation();
}

function handleMouse(ev: MouseEvent): void {
  if (voiceInput?.isBlockingMouse()) return;

  // Motion events: only render if something visual changed (focus switch, drag selection)
  if (ev.action === "motion") {
    const prevFocus = state.panelFocus;
    const prevSidebarItem = state.sidebar.selectedItem;
    const prevCursorRow = state.historyCursor.row;
    const prevCursorCol = state.historyCursor.col;
    handleMouseEvent(ev, state);
    if (state.panelFocus !== prevFocus
        || state.sidebar.selectedItem !== prevSidebarItem
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
      {
        const reqId = daemon.loadConversation(result.convId);
        const renderMs = renderAfterLocalUiMutation();
        if (PERFORMANCE_PROFILING_ENABLED && renderMs >= 100) {
          log("warn", `perf: conversation_open tui_request_render ${JSON.stringify({ reqId, convId: result.convId, renderMs, input: "mouse" })}`);
        }
      }
      return;
    case "open_folder_instructions":
      if (state.convId) unsubscribeConversation(state.convId);
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

  maybeRequestOlderHistory();
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

function restoreDaemonSessionAfterReconnect(conversationWillReload: boolean): void {
  pushSystemMessage(state, "✓ Reconnected to daemon.", "success");

  // Always refresh daemon-derived top-level state. A replayed load/unwind for
  // the active conversation provides the canonical reload itself; other queued
  // commands still need a load to restore this new socket's subscription.
  daemon.ping();
  if (!conversationWillReload && state.convId) daemon.loadConversation(state.convId);
}

async function reconnectToDaemon(): Promise<void> {
  if (!running || reconnecting) return;
  reconnecting = true;

  try {
    const { replayedCommands } = await daemon.connect();
    const replayedNavigation = [...replayedCommands].reverse().find((command) => command.type === "load_conversation");
    reconnectNavigationTarget = replayedNavigation?.type === "load_conversation" ? replayedNavigation.convId : null;
    const conversationWillReload = replayedCommands.some((command) =>
      // Any queued navigation load is newer than the conversation that was
      // active when reconnect began. Do not race it with a stale automatic load.
      command.type === "load_conversation"
      || (command.type === "unwind_conversation" && command.convId === state.convId)
    );
    reconnecting = false;
    clearReconnectTimer();
    restoreDaemonSessionAfterReconnect(conversationWillReload);
    scheduleRender();
  } catch {
    if (!running) {
      reconnecting = false;
      return;
    }
    scheduleReconnectAttempt();
    scheduleRender();
    return;
  }
}

function handleDaemonConnectionLost(shutdownMode: DaemonShutdownMode | null): void {
  voiceInput?.cleanup();
  callMedia?.stop();
  // The client retains an ambiguous unwind with its operation UUID and replays
  // it after reconnect. Keep the optimistic gate until that correlated result;
  // the normal reconnect load may still reveal the canonical state meanwhile.
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  clearStreamTick();
  clearPrewarmTimer();
  state.historyLoadingOlder = false;
  state.historyLoadingStartedAt = null;
  state.historyLoadingRequestId = null;
  const notice = formatConnectionLostNotice(shutdownMode);
  if (notice) pushSystemMessage(state, notice, theme.error);
  scheduleRender();
  void reconnectToDaemon();
}

// ── Terminal setup ──────────────────────────────────────────────────

function setupTerminal(): void {
  const cursorColorSeq = theme.cursorColor ? set_cursor_color(theme.cursorColor) : '';
  process.stdout.write(enter_alt + hide_cursor + enable_bracketed_paste + query_clipboard_paste_events + enable_clipboard_paste_events + enable_kitty_kbd + enable_mouse + cursorColorSeq);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalSetUp = true;
}

function startEventLoopLagMonitor(): void {
  if (!PERFORMANCE_PROFILING_ENABLED || eventLoopLagTimer) return;
  let expectedAt = performance.now() + EVENT_LOOP_CHECK_INTERVAL_MS;
  eventLoopLagTimer = setInterval(() => {
    const now = performance.now();
    const lagMs = Math.max(0, now - expectedAt);
    expectedAt = now + EVENT_LOOP_CHECK_INTERVAL_MS;
    if (lagMs < EVENT_LOOP_LAG_WARN_MS) return;
    const memory = process.memoryUsage();
    log("warn", `perf: tui_event_loop_lag ${JSON.stringify({
      lagMs,
      convId: state.convId,
      messages: state.messages.length,
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    })}`);
  }, EVENT_LOOP_CHECK_INTERVAL_MS);
  eventLoopLagTimer.unref?.();
  log("info", "perf: performance profiling enabled");
}

function restoreTerminal(): void {
  if (!terminalSetUp) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const cursorResetSeq = theme.cursorColor ? reset_cursor_color : '';
  process.stdout.write(disable_mouse + disable_kitty_kbd + disable_clipboard_paste_events + disable_bracketed_paste + show_cursor + cursorResetSeq + leave_alt);
  terminalSetUp = false;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  startupProfileMark("main_begin");
  daemon = new DaemonClient(onDaemonEvent);
  daemon.onConnectionLost(handleDaemonConnectionLost);
  callMedia = new CallMediaController(daemon, {
    micGainDb: loadMicGainDb(),
    onError: message => {
      pushSystemMessage(state, `✗ ${message}`, theme.error);
      scheduleRender();
    },
  });
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

  // Buffer stdin across terminal-control and bracketed-paste chunk boundaries.
  // OSC 5522 responses can be split at any byte boundary by SSH, while large
  // text pastes must remain one event so embedded newlines never submit early.
  const pasteBuffer = new PasteBuffer(processInput);
  let shouldStripStartupLaunchEcho = true;
  const startupInputSanitizeUntil = Date.now() + STARTUP_INPUT_SANITIZE_MS;
  terminalClipboardClient = new TerminalClipboardClient({
    write: sequence => process.stdout.write(sequence),
    onImage: attachTerminalClipboardImage,
    onText: text => handleKey({ type: "paste", text }),
    onError: message => log("warn", `tui: terminal clipboard protocol failed: ${message}`),
  });
  terminalControlBuffer = new TerminalControlBuffer(
    data => {
      if (shouldStripStartupLaunchEcho) {
        shouldStripStartupLaunchEcho = false;
        if (Date.now() <= startupInputSanitizeUntil) {
          data = stripStartupLaunchEcho(data);
          if (data.length === 0) return;
        }
      }
      const ready = pasteBuffer.feed(Buffer.from(data));
      if (ready !== null) processInput(ready);
    },
    sequence => terminalClipboardClient?.handleControlSequence(sequence),
  );

  function processInput(str: string): void {
    if (!running) return;
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

  process.stdin.on("data", (data: Buffer) => terminalControlBuffer?.feed(data));

  startEventLoopLagMonitor();
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
}

function cleanup(): void {
  running = false;
  persistStartingStateOnce();
  clearRenderTimer();
  clearStreamTick();
  clearPrewarmTimer();
  clearReconnectTimer();
  if (eventLoopLagTimer) {
    clearInterval(eventLoopLagTimer);
    eventLoopLagTimer = null;
  }
  voiceInput?.cleanup();
  callMedia?.stop();
  terminalControlBuffer?.dispose();
  terminalControlBuffer = null;
  terminalClipboardClient?.dispose();
  terminalClipboardClient = null;
  daemon?.disconnect();
  restoreTerminal();
  process.exit(0);
}

let startingStatePersisted = false;

function persistStartingStateOnce(): void {
  if (startingStatePersisted) return;
  try {
    saveTuiStartingState(captureTuiStartingState(state));
    startingStatePersisted = true;
  } catch (error) {
    try {
      log("error", `tui: failed to save starting state: ${(error as Error).message}`);
    } catch {
      // Saving state must never prevent terminal restoration during shutdown.
    }
  }
}

process.on("exit", () => {
  persistStartingStateOnce();
  restoreTerminal();
});
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);

main().catch((err) => {
  restoreTerminal();
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
