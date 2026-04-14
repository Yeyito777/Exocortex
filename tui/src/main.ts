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
import { parseInput, PasteBuffer, type KeyEvent, type MouseEvent, type InputEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { clearPrompt } from "./promptstate";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { render } from "./render";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste, enable_kitty_kbd, disable_kitty_kbd, enable_mouse, disable_mouse, set_cursor_color, reset_cursor_color } from "./terminal";
import { createInitialState, isStreaming, clearPendingAI, clearStreamingTailMessages, modelSupportsImages, pushSystemMessage, resetToolOutputState } from "./state";
import { createMessageMetadata, createPendingAI, type ImageAttachment } from "./messages";
import { loginPromptProviders } from "./providerselection";
import { handleEvent } from "./events";
import { confirmQueueMessage, cancelQueuePrompt, clearLocalQueue, removeLocalQueueEntry } from "./queue";
import { confirmEditMessage, cancelEditMessage } from "./editmessage";
import { generateTitle, PENDING_TITLE } from "./titlegen";
import { theme } from "./theme";
import { msUntilNextElapsedSecond } from "./time";
import type { Event } from "./protocol";
import { pushUndo } from "./undo";
import { VoiceRecorder, insertVoiceTranscript } from "./voice";

// ── State ───────────────────────────────────────────────────────────

const state = createInitialState();
let running = true;
let daemon: DaemonClient;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let streamTickTimer: ReturnType<typeof setTimeout> | null = null;
let terminalSetUp = false;

const VOICE_RECORDING_REPEAT_INITIAL_GRACE_MS = 1000;
const VOICE_RECORDING_REPEAT_IDLE_TIMEOUT_MS = 250;
const VOICE_SPINNER_INTERVAL_MS = 80;
const VOICE_MIN_RECORDING_MS = 1000;

const voiceSession = {
  animationTimer: null as ReturnType<typeof setInterval> | null,
  recorder: null as VoiceRecorder | null,
  recordingStartedAt: 0,
  lastSpaceRepeatAt: 0,
  insertionPos: 0,
  prefixText: "",
};

// ── Render scheduling ───────────────────────────────────────────────

function clearRenderTimer(): void {
  if (!renderTimer) return;
  clearTimeout(renderTimer);
  renderTimer = null;
}

function clearStreamTick(): void {
  if (!streamTickTimer) return;
  clearTimeout(streamTickTimer);
  streamTickTimer = null;
}

/** Schedule a render on the next frame. Resets the live stream timer. */
function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
    resetStreamTick();
  }, 16);
}

/** During streaming, re-render on the next exact elapsed-second boundary. */
function resetStreamTick(): void {
  clearStreamTick();
  const startedAt = state.pendingAI?.metadata?.startedAt;
  if (isStreaming(state) && typeof startedAt === "number") {
    streamTickTimer = setTimeout(scheduleRender, msUntilNextElapsedSecond(startedAt));
  }
}

function isVoicePromptFocused(): boolean {
  return state.panelFocus === "chat"
    && state.chatFocus === "prompt"
    && state.vim.mode === "normal"
    && !state.queuePrompt
    && !state.editMessagePrompt
    && !state.search?.barOpen;
}

function isVoicePassthroughKey(key: KeyEvent): boolean {
  return key.type === "ctrl-c";
}

function stopVoiceAnimation(): void {
  if (!voiceSession.animationTimer) return;
  clearInterval(voiceSession.animationTimer);
  voiceSession.animationTimer = null;
}

function resetVoiceOverlay(): void {
  state.voicePrompt = null;
  stopVoiceAnimation();
  voiceSession.insertionPos = 0;
  voiceSession.prefixText = "";
  voiceSession.recordingStartedAt = 0;
  voiceSession.lastSpaceRepeatAt = 0;
}

function deriveVoicePrefixText(insertionPos: number): string {
  if (insertionPos <= 0) return "";
  const prevChar = state.inputBuffer[insertionPos - 1];
  return /\s/.test(prevChar) ? "" : " ";
}

function maybeStopVoiceRecordingFromIdle(): void {
  if (!voiceSession.recorder || state.voicePrompt?.phase !== "recording") return;
  const now = Date.now();
  if (now - voiceSession.recordingStartedAt < VOICE_RECORDING_REPEAT_INITIAL_GRACE_MS) return;
  if (now - voiceSession.lastSpaceRepeatAt < VOICE_RECORDING_REPEAT_IDLE_TIMEOUT_MS) return;
  void stopVoiceRecordingAndTranscribe();
}

function startVoiceAnimation(): void {
  if (voiceSession.animationTimer) return;
  voiceSession.animationTimer = setInterval(() => {
    if (!state.voicePrompt) {
      stopVoiceAnimation();
      return;
    }
    state.voicePrompt.frameIndex = (state.voicePrompt.frameIndex + 1) % 10;
    maybeStopVoiceRecordingFromIdle();
    scheduleRender();
  }, VOICE_SPINNER_INTERVAL_MS);
}

async function startVoiceRecording(insertionPos: number): Promise<void> {
  if (voiceSession.recorder || state.voicePrompt?.phase === "transcribing") return;

  try {
    voiceSession.recorder = VoiceRecorder.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ ${message}`, theme.error);
    scheduleRender();
    return;
  }

  voiceSession.insertionPos = insertionPos;
  voiceSession.prefixText = deriveVoicePrefixText(insertionPos);
  voiceSession.recordingStartedAt = Date.now();
  voiceSession.lastSpaceRepeatAt = voiceSession.recordingStartedAt;
  state.autocomplete = null;
  state.voicePrompt = {
    phase: "recording",
    frameIndex: 0,
    insertionPos,
  };
  startVoiceAnimation();
  scheduleRender();
}

async function stopVoiceRecordingAndTranscribe(): Promise<void> {
  const recorder = voiceSession.recorder;
  if (!recorder) return;
  voiceSession.recorder = null;

  const insertionPos = voiceSession.insertionPos;
  const prefixText = voiceSession.prefixText;
  const promptHint = state.inputBuffer.slice(0, insertionPos);
  const recordingDurationMs = Date.now() - voiceSession.recordingStartedAt;

  state.voicePrompt = {
    phase: "transcribing",
    frameIndex: 0,
    insertionPos,
  };
  startVoiceAnimation();
  scheduleRender();

  let clip: { bytes: Buffer; mimeType: string };
  try {
    clip = await recorder.stop();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ Voice capture failed: ${message}`, theme.error);
    scheduleRender();
    return;
  }

  if (recordingDurationMs < VOICE_MIN_RECORDING_MS) {
    resetVoiceOverlay();
    scheduleRender();
    return;
  }

  try {
    daemon.transcribeAudio(
      clip.bytes.toString("base64"),
      clip.mimeType,
      (text) => {
        const prevBuffer = state.inputBuffer;
        const prevCursor = state.cursorPos;
        resetVoiceOverlay();
        pushUndo(state.undo, prevBuffer, prevCursor);
        const next = insertVoiceTranscript(prevBuffer, prevCursor, insertionPos, text, prefixText);
        state.inputBuffer = next.buffer;
        state.cursorPos = next.cursorPos;
        state.autocomplete = null;
        scheduleRender();
      },
      () => {
        resetVoiceOverlay();
        scheduleRender();
      },
      promptHint,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resetVoiceOverlay();
    pushSystemMessage(state, `✗ Voice transcription failed: ${message}`, theme.error);
    scheduleRender();
  }
}

function cleanupVoiceSession(): void {
  if (voiceSession.recorder) {
    voiceSession.recorder.abort();
    voiceSession.recorder = null;
  }
  resetVoiceOverlay();
}

function handleVoiceKey(key: KeyEvent): boolean {
  if (state.voicePrompt?.phase === "transcribing") {
    return !isVoicePassthroughKey(key);
  }

  if (voiceSession.recorder) {
    if (key.type === "char" && key.char === " ") {
      voiceSession.lastSpaceRepeatAt = Date.now();
      return true;
    }
    if (isVoicePassthroughKey(key)) return false;
    void stopVoiceRecordingAndTranscribe();
    return true;
  }

  if (!isVoicePromptFocused()) return false;
  if (key.type !== "char" || key.char !== " ") return false;

  void startVoiceRecording(state.cursorPos);
  return true;
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function onDaemonEvent(event: Event): void {
  handleEvent(event, state, daemon);

  // Auto-generate title for newly created conversations when requested.
  if (event.type === "conversation_created" && state.convId && state.pendingGenerateTitleOnCreate) {
    state.pendingGenerateTitleOnCreate = false;
    generateTitle(state.convId, state, daemon, scheduleRender);
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

  scheduleRender();
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
          daemon.login(cmdResult.provider ?? state.provider);
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

  // Regular message — expand macros before sending
  const messageText = expandMacros(text);

  if (isStreaming(state)) {
    // Preserve images in the queue prompt so they travel with the message
    const queueImages = hasImages ? [...state.pendingImages] : undefined;
    if (hasImages) state.pendingImages = [];
    // Show queue prompt overlay — let user choose when to send
    state.queuePrompt = { text: messageText, selection: "message-end", images: queueImages };
    scheduleRender();
    return;
  }

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
    daemon.createConversation(state.provider, state.model, PENDING_TITLE, state.effort, state.fastMode);
  } else {
    daemon.sendMessage(state.convId, messageText, startedAt, images);

    // Instructions can create an otherwise-empty conversation before the first
    // real user message. In that case, kick off the normal pending→generated
    // title flow when the first user message is sent.
    const conv = state.sidebar.conversations.find((candidate) => candidate.id === state.convId);
    if (conv && !conv.title.trim()) {
      generateTitle(state.convId, state, daemon, scheduleRender);
    }
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  if (handleVoiceKey(key)) {
    scheduleRender();
    return;
  }

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

  scheduleRender();
}

function handleMouse(ev: MouseEvent): void {
  if (voiceSession.recorder || state.voicePrompt?.phase === "transcribing") {
    scheduleRender();
    return;
  }

  // Motion events: only render if something visual changed (focus switch, drag selection)
  if (ev.action === "motion") {
    const prevFocus = state.panelFocus;
    const prevCursorRow = state.historyCursor.row;
    const prevCursorCol = state.historyCursor.col;
    handleMouseEvent(ev, state);
    if (state.panelFocus !== prevFocus
        || state.historyCursor.row !== prevCursorRow
        || state.historyCursor.col !== prevCursorCol) {
      scheduleRender();
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

  scheduleRender();
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
  daemon = new DaemonClient(onDaemonEvent);
  try {
    await daemon.connect();
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  // Request initial usage data from daemon
  daemon.ping();

  daemon.onConnectionLost(() => {
    cleanupVoiceSession();
    clearPendingAI(state);
    pushSystemMessage(state, "✗ Lost connection to daemon.", theme.error);
    scheduleRender();
    setTimeout(() => { running = false; }, 2000);
  });

  setupTerminal();

  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    scheduleRender();
  });

  render(state);

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
  clearRenderTimer();
  clearStreamTick();
  cleanupVoiceSession();
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
