/**
 * Exocortex TUI — terminal client for exocortexd.
 *
 * Connects to the daemon via Unix socket, displays a conversational UI,
 * and forwards user input. All AI, auth, and streaming logic lives in
 * the daemon — this is purely a presentation layer.
 *
 * Usage: bun run src/main.ts
 */

import { DaemonClient } from "./client";
import { parseInput, PasteBuffer, type KeyEvent, type MouseEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { clearPrompt } from "./promptstate";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { render, invalidateHistoryRenderCache } from "./render";
import { preserveViewportAcrossResize } from "./chatscroll";
import { invalidateFrame } from "./frame";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste, enable_kitty_kbd, disable_kitty_kbd, enable_mouse, disable_mouse, set_cursor_color, reset_cursor_color } from "./terminal";
import { createInitialState, isStreaming, clearPendingAI, clearStreamingTailMessages, modelSupportsImages, pushSystemMessage, resetToolOutputState } from "./state";
import { createMessageMetadata, createPendingAI, type ImageAttachment } from "./messages";
import { loginPromptProviders } from "./providerselection";
import { handleEvent } from "./events";
import { openQueuePrompt, confirmQueueMessage, cancelQueuePrompt, clearLocalQueue, removeLocalQueueEntry } from "./queue";
import { confirmEditMessage, cancelEditMessage } from "./editmessage";
import { generateTitle } from "./titlegen";
import { theme } from "./theme";
import { openTargetDetached } from "./openable";
import { msUntilNextElapsedSecond } from "./time";
import type { Event } from "./protocol";
import { createVoiceInputController, type VoiceInputController } from "./voiceinput";

// ── State ───────────────────────────────────────────────────────────

const state = createInitialState();
const RECONNECT_DELAY_MS = 1000;
const STARTUP_PROFILE = process.env.EXOCORTEX_PROFILE_STARTUP === "1" || process.argv.includes("--profile-startup");

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
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnecting = false;
let terminalSetUp = false;
let voiceInput: VoiceInputController | null = null;

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

/** During streaming, re-render on the next exact elapsed-second boundary. */
function resetStreamTick(): void {
  clearStreamTick();
  const startedAt = state.pendingAI?.metadata?.startedAt;
  if (isStreaming(state) && typeof startedAt === "number") {
    streamTickTimer = setTimeout(scheduleRender, msUntilNextElapsedSecond(startedAt));
  }
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function onDaemonEvent(event: Event): void {
  if (event.type === "conversations_list") {
    startupProfileMark("conversations_list_received", { conversationCount: event.conversations.length });
  }

  invalidateHistoryRenderCache(state);
  handleEvent(event, state, daemon);

  if (event.type === "conversations_list") {
    startupProfileConversationCount = event.conversations.length;
    startupProfileConversationsLoaded = true;
    startupProfileMark("conversations_list_handled", { conversationCount: state.sidebar.conversations.length });
  }

  // The daemon auto-generates titles after the first user message is appended.
  if (event.type === "conversation_created" && state.pendingGenerateTitleOnCreate) {
    state.pendingGenerateTitleOnCreate = false;
  }

  // Clear stream tick on streaming_stopped
  if (event.type === "streaming_stopped") {
    clearStreamTick();
    // Queue shadows are NOT cleared here — the daemon drains one queued
    // message at a time and re-queues the rest. Each consumed message
    // triggers a user_message event, whose handler in events.ts removes
    // the corresponding shadow individually.
  }

  if (maybeFlushPendingAuthQueue()) return;

  scheduleRender(renderDelayForEvent(event));
}

// ── Input handling ──────────────────────────────────────────────────

function enqueuePendingAuthMessage(messageText: string, images?: ImageAttachment[]): void {
  const echoStartedAt = Date.now();
  state.pendingAuthQueue.push({ text: messageText, images, echoStartedAt });
  state.messages.push({
    role: "user",
    text: messageText,
    images,
    metadata: createMessageMetadata(echoStartedAt, state.model),
  });
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

function handleSubmit(): void {
  const text = state.inputBuffer.trim();
  const hasImages = state.pendingImages.length > 0;
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
          if (state.convId) daemon.unsubscribe(state.convId);
          state.convId = null;
          break;
        case "create_conversation_for_instructions":
          if (state.convId) daemon.unsubscribe(state.convId);
          state.convId = null;
          state.pendingSystemInstructions = cmdResult.text;
          state.pendingGenerateTitleOnCreate = false;
          daemon.createConversation(state.provider, state.model, "", state.effort);
          break;
        case "replay_requested":
          if (state.convId) daemon.replayConversation(state.convId, Date.now());
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
          daemon.login(cmdResult.provider ?? state.provider, cmdResult.apiKey);
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

  if (isStreaming(state)) {
    // Keep the queue prompt text exactly as typed. Macro expansion happens only
    // if the user confirms the modal; canceling should restore the original
    // promptline contents.
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

/** Send a message immediately (no streaming in progress). */
function sendDirectly(messageText: string, images?: ImageAttachment[]): void {
  if (!canSendImages(images)) {
    scheduleRender();
    return;
  }
  if (!state.authByProvider[state.provider]) {
    enqueuePendingAuthMessage(messageText, images);
    showLoginRequiredPrompt();
    scheduleRender();
    return;
  }

  const startedAt = Date.now();
  state.messages.push({
    role: "user",
    text: messageText,
    images,
    metadata: createMessageMetadata(startedAt, state.model, { endedAt: startedAt }),
  });
  state.pendingAI = createPendingAI(startedAt, state.model);

  if (!state.convId) {
    state.pendingSend.active = true;
    state.pendingSend.text = messageText;
    state.pendingSend.images = images;
    state.pendingGenerateTitleOnCreate = true;
    daemon.createConversation(state.provider, state.model, "", state.effort, state.fastMode);
  } else {
    daemon.sendMessage(state.convId, messageText, startedAt, images);
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  if (voiceInput?.handleKey(key)) return;

  const result = handleFocusedKey(key, state);

  switch (result.type) {
    case "submit":
      handleSubmit();
      return;
    case "queue_confirm": {
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
      cancelQueuePrompt(state);
      break;
    case "edit_message_confirm": {
      const er = confirmEditMessage(state);
      if (er.action === "edit_queued") {
        if (state.convId) {
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
      if (isStreaming(state) && state.convId) daemon.abort(state.convId);
      break;
    case "load_conversation":
      daemon.loadConversation(result.convId);
      break;
    case "load_tool_outputs":
      daemon.loadToolOutputs(result.convId);
      break;
    case "new_conversation":
      if (state.convId) {
        daemon.unsubscribe(state.convId);
        clearLocalQueue(state, state.convId);
      }
      state.convId = null;
      state.messages = [];
      clearPendingAI(state);
      clearStreamingTailMessages(state);
      state.contextTokens = null;
      resetToolOutputState(state);
      state.pendingSystemInstructions = null;
      state.pendingGenerateTitleOnCreate = false;
      break;
    case "delete_conversation":
      daemon.deleteConversation(result.convId);
      clearLocalQueue(state, result.convId);
      // If deleting the current conversation, clear the chat
      if (state.convId === result.convId) {
        state.convId = null;
        state.messages = [];
        clearPendingAI(state);
        state.contextTokens = null;
        resetToolOutputState(state);
      }
      break;
    case "undo_delete":
      daemon.undoDelete();
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
    case "move_conversation":
      daemon.moveConversation(result.convId, result.direction);
      break;
    case "clone_conversation":
      daemon.cloneConversation(result.convId);
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
      daemon.loadConversation(result.convId);
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
  voiceInput = createVoiceInputController(state, daemon, scheduleRender);
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
    const ready = pasteBuffer.feed(data);
    if (ready !== null) processInput(ready);
  });
}

function cleanup(): void {
  running = false;
  clearRenderTimer();
  clearStreamTick();
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
