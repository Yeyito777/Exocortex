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
import { parseKeys, PasteBuffer, type KeyEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { clearPrompt } from "./promptline";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { render } from "./render";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste } from "./terminal";
import { createInitialState, isStreaming, clearPendingAI } from "./state";
import { createPendingAI, type ImageAttachment } from "./messages";
import { handleEvent } from "./events";
import { confirmQueueMessage, cancelQueuePrompt, clearLocalQueue, removeLocalQueueEntry } from "./queue";
import { confirmEditMessage, cancelEditMessage } from "./editmessage";
import { generateTitle, PENDING_TITLE } from "./titlegen";
import { theme } from "./theme";
import type { Event } from "./protocol";

// ── State ───────────────────────────────────────────────────────────

const state = createInitialState();
let running = true;
let daemon: DaemonClient;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let streamTickTimer: ReturnType<typeof setTimeout> | null = null;
let terminalSetUp = false;

// ── Render scheduling ───────────────────────────────────────────────

/** Schedule a render on the next frame. Resets the 1s stream tick. */
function scheduleRender(): void {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render(state);
    resetStreamTick();
  }, 16);
}

/** During streaming, ensure we re-render at least once per second. */
function resetStreamTick(): void {
  if (streamTickTimer) clearTimeout(streamTickTimer);
  if (isStreaming(state)) {
    streamTickTimer = setTimeout(scheduleRender, 1000);
  }
}

// ── Event handler (daemon → TUI) ───────────────────────────────────

function onDaemonEvent(event: Event): void {
  handleEvent(event, state, daemon);

  // Auto-generate title for new conversations
  if (event.type === "conversation_created" && state.convId) {
    generateTitle(state.convId, state, daemon, scheduleRender);
  }

  // Clear stream tick on streaming_stopped
  if (event.type === "streaming_stopped") {
    if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
    // Queue shadows are NOT cleared here — the daemon drains one queued
    // message at a time and re-queues the rest. Each consumed message
    // triggers a user_message event, whose handler in events.ts removes
    // the corresponding shadow individually.
  }

  scheduleRender();
}

// ── Input handling ──────────────────────────────────────────────────

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
        case "model_changed":
          if (state.convId) daemon.setModel(state.convId, cmdResult.model);
          break;
        case "effort_changed":
          if (state.convId) daemon.setEffort(state.convId, cmdResult.effort);
          break;
        case "rename_conversation":
          if (state.convId) daemon.renameConversation(state.convId, cmdResult.title);
          break;
        case "generate_title":
          if (state.convId) generateTitle(state.convId, state, daemon, scheduleRender);
          break;
        case "login":
          daemon.login();
          break;
        case "logout":
          daemon.logout();
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
    // Queue system doesn't support images yet — drop them with a warning
    if (hasImages) {
      state.pendingImages = [];
      state.messages.push({ role: "system", text: "⚠ Images can't be queued — only text will be sent.", color: theme.warning, metadata: null });
    }
    // Show queue prompt overlay — let user choose when to send
    state.queuePrompt = {
      text: messageText,
      selection: "message-end",
    };
    scheduleRender();
    return;
  }

  const images = hasImages ? [...state.pendingImages] : undefined;
  clearPrompt(state);
  state.pendingImages = [];
  state.scrollOffset = 0;
  sendDirectly(messageText, images);
}

/** Send a message immediately (no streaming in progress). */
function sendDirectly(messageText: string, images?: ImageAttachment[]): void {
  const startedAt = Date.now();
  state.messages.push({ role: "user", text: messageText, images, metadata: null });
  state.pendingAI = createPendingAI(startedAt, state.model);

  if (!state.convId) {
    state.pendingSend.active = true;
    state.pendingSend.text = messageText;
    state.pendingSend.images = images;
    daemon.createConversation(state.model, PENDING_TITLE, state.effort);
  } else {
    daemon.sendMessage(state.convId, messageText, startedAt, images);
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
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
        // No images — queue system is text-only (images cleared on queue entry)
        sendDirectly(qr.text);
      } else if (qr.action === "queue") {
        // Send queue command to daemon — it handles injection timing
        daemon.queueMessage(qr.convId, qr.text, qr.timing);
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
    case "new_conversation":
      if (state.convId) {
        daemon.unsubscribe(state.convId);
        clearLocalQueue(state, state.convId);
      }
      state.convId = null;
      state.messages = [];
      clearPendingAI(state);
      state.contextTokens = null;
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

// ── Terminal setup ──────────────────────────────────────────────────

function setupTerminal(): void {
  process.stdout.write(enter_alt + hide_cursor + enable_bracketed_paste);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalSetUp = true;
}

function restoreTerminal(): void {
  if (!terminalSetUp) return;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(disable_bracketed_paste + show_cursor + leave_alt);
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
    clearPendingAI(state);
    state.messages.push({ role: "system", text: "✗ Lost connection to daemon.", color: theme.error, metadata: null });
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
    const keys = parseKeys(str);
    for (const key of keys) {
      handleKey(key);
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
  if (streamTickTimer) clearTimeout(streamTickTimer);
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
