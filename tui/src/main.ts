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
import { parseKeys, type KeyEvent } from "./input";
import { handleFocusedKey } from "./focus";
import { clearPrompt } from "./promptline";
import { tryCommand } from "./commands";
import { expandMacros } from "./macros";
import { render } from "./render";
import { enter_alt, leave_alt, hide_cursor, show_cursor, enable_bracketed_paste, disable_bracketed_paste } from "./terminal";
import { createInitialState, isStreaming } from "./state";
import { createPendingAI } from "./messages";
import { handleEvent } from "./events";
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

  // Clear stream tick on streaming_stopped
  if (event.type === "streaming_stopped") {
    if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
  }

  scheduleRender();
}

// ── Input handling ──────────────────────────────────────────────────

function handleSubmit(): void {
  const text = state.inputBuffer.trim();
  if (!text) return;

  // Slash commands
  const cmdResult = tryCommand(text, state);
  if (cmdResult) {
    if (cmdResult.type === "quit") { running = false; return; }
    if (cmdResult.type === "new_conversation") {
      if (state.convId) daemon.unsubscribe(state.convId);
      state.convId = null;
    }
    if (cmdResult.type === "model_changed" && state.convId) {
      daemon.setModel(state.convId, cmdResult.model);
    }
    if (cmdResult.type === "rename_conversation" && state.convId) {
      daemon.renameConversation(state.convId, cmdResult.title);
    }
    scheduleRender();
    return;
  }

  // Regular message — expand macros before sending
  const messageText = expandMacros(text);
  clearPrompt(state);
  state.scrollOffset = 0;

  if (isStreaming(state)) {
    state.messages.push({ role: "system", text: "Still streaming — wait or press Escape to abort.", metadata: null });
    scheduleRender();
    return;
  }

  // Create the AI message immediately so the timer starts now
  const startedAt = Date.now();
  state.messages.push({ role: "user", text: messageText, metadata: null });
  state.pendingAI = createPendingAI(startedAt, state.model);

  // If no conversation yet, create one first
  if (!state.convId) {
    state.pendingSend.active = true;
    state.pendingSend.text = messageText;
    daemon.createConversation(state.model);
  } else {
    daemon.sendMessage(state.convId, messageText, startedAt);
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  const result = handleFocusedKey(key, state);

  switch (result.type) {
    case "submit":
      handleSubmit();
      return;
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
      if (state.convId) daemon.unsubscribe(state.convId);
      state.convId = null;
      state.messages = [];
      state.pendingAI = null;
      state.contextTokens = null;
      break;
    case "delete_conversation":
      daemon.deleteConversation(result.convId);
      // If deleting the current conversation, clear the chat
      if (state.convId === result.convId) {
        state.convId = null;
        state.messages = [];
        state.pendingAI = null;
        state.contextTokens = null;
      }
      break;
    case "undo_delete":
      daemon.undoDelete();
      break;
    case "mark_conversation":
      daemon.markConversation(result.convId, result.marked);
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
    state.pendingAI = null;
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

  process.stdin.on("data", (data: Buffer) => {
    const keys = parseKeys(data);
    for (const key of keys) {
      handleKey(key);
      if (!running) break;
    }
    if (!running) cleanup();
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
