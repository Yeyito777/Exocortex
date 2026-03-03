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
import { render, enter_alt, leave_alt, hide_cursor, show_cursor } from "./render";
import { createInitialState, isStreaming } from "./state";
import { createPendingAI, ensureCurrentBlock, type ModelId } from "./messages";
import type { Event } from "./protocol";

// ── State ───────────────────────────────────────────────────────────

const state = createInitialState();
let running = true;
let daemon: DaemonClient;
let pendingSendAfterCreate = false;
let pendingMessageText = "";
let renderTimer: ReturnType<typeof setTimeout> | null = null;
let streamTickTimer: ReturnType<typeof setTimeout> | null = null;
let pendingErrors: string[] = [];

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

function handleEvent(event: Event): void {
  switch (event.type) {
    case "conversation_created": {
      state.convId = event.convId;
      state.model = event.model;
      daemon.subscribe(event.convId);

      // If we had a pending message, send it now
      // (the message was already added to state.messages by handleSubmit)
      if (pendingSendAfterCreate && pendingMessageText && state.pendingAI) {
        daemon.sendMessage(event.convId, pendingMessageText, state.pendingAI.metadata.startedAt);
        pendingMessageText = "";
        pendingSendAfterCreate = false;
      }
      break;
    }

    case "streaming_started": {
      state.scrollOffset = 0;
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
      state.scrollOffset = 0;
      break;
    }

    case "thinking_chunk": {
      if (state.pendingAI) {
        const block = ensureCurrentBlock(state.pendingAI, "thinking");
        if (block.type === "thinking") block.text += event.text;
      }
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
        state.pendingAI.metadata.tokens = event.tokens;
      }
      break;
    }

    case "message_complete": {
      if (state.pendingAI) {
        state.pendingAI.metadata.endedAt = event.endedAt;
        state.messages.push(state.pendingAI);
        state.pendingAI = null;
      }
      break;
    }

    case "streaming_stopped": {
      // If pendingAI wasn't finalized (e.g. error/abort), push what we have
      const wasInterrupted = state.pendingAI !== null;
      if (state.pendingAI && state.pendingAI.blocks.length > 0) {
        state.pendingAI.metadata.endedAt ??= Date.now();
        state.messages.push(state.pendingAI);
      }
      state.pendingAI = null;

      // Flush errors that arrived during streaming (after the AI message)
      for (const msg of pendingErrors) {
        state.messages.push({ role: "system", text: `✗ ${msg}`, metadata: null });
      }
      pendingErrors = [];

      if (wasInterrupted) {
        state.messages.push({ role: "system", text: "✗ Interrupted", color: "\x1b[31m", metadata: null });
      }
      if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
      break;
    }

    case "error": {
      if (isStreaming(state)) {
        pendingErrors.push(event.message);
      } else {
        state.messages.push({ role: "system", text: `✗ ${event.message}`, metadata: null });
      }
      break;
    }

    case "ack":
    case "pong":
      break;
  }

  scheduleRender();
}

// ── Input handling ──────────────────────────────────────────────────

function handleSubmit(): void {
  const text = state.inputBuffer.trim();
  if (!text) return;

  // Commands
  if (text === "/quit" || text === "/exit") {
    running = false;
    return;
  }

  if (text === "/new") {
    state.messages = [];
    state.convId = null;
    state.pendingAI = null;
    state.inputBuffer = "";
    state.cursorPos = 0;
    state.scrollOffset = 0;
    scheduleRender();
    return;
  }

  if (text.startsWith("/model")) {
    const parts = text.split(/\s+/);
    if (parts[1] && ["sonnet", "haiku", "opus"].includes(parts[1])) {
      state.model = parts[1] as ModelId;
      state.messages.push({ role: "system", text: `Model set to ${state.model}`, metadata: null });
    } else {
      state.messages.push({ role: "system", text: `Current: ${state.model}. Available: sonnet, haiku, opus`, metadata: null });
    }
    state.inputBuffer = "";
    state.cursorPos = 0;
    scheduleRender();
    return;
  }

  // Regular message
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.scrollOffset = 0;

  if (isStreaming(state)) {
    state.messages.push({ role: "system", text: "Still streaming — wait or press Escape to abort.", metadata: null });
    scheduleRender();
    return;
  }

  // Create the AI message immediately so the timer starts now
  const startedAt = Date.now();
  state.messages.push({ role: "user", text, metadata: null });
  state.pendingAI = createPendingAI(startedAt, state.model);

  // If no conversation yet, create one first
  if (!state.convId) {
    pendingSendAfterCreate = true;
    pendingMessageText = text;
    daemon.createConversation(state.model);
  } else {
    daemon.sendMessage(state.convId, text, startedAt);
  }

  scheduleRender();
}

function handleKey(key: KeyEvent): void {
  switch (key.type) {
    case "char": {
      if (!key.char) break;
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos) +
        key.char +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos++;
      break;
    }
    case "enter":     handleSubmit(); break;
    case "backspace": {
      if (state.cursorPos > 0) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos - 1) +
          state.inputBuffer.slice(state.cursorPos);
        state.cursorPos--;
      }
      break;
    }
    case "delete": {
      if (state.cursorPos < state.inputBuffer.length) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos) +
          state.inputBuffer.slice(state.cursorPos + 1);
      }
      break;
    }
    case "left":      if (state.cursorPos > 0) state.cursorPos--; break;
    case "right":     if (state.cursorPos < state.inputBuffer.length) state.cursorPos++; break;
    case "home":      state.cursorPos = 0; break;
    case "end":       state.cursorPos = state.inputBuffer.length; break;
    case "up": {
      const allLines = state.messages.length * 3;
      const maxScroll = Math.max(0, allLines - (state.rows - 5));
      state.scrollOffset = Math.min(state.scrollOffset + 3, maxScroll);
      break;
    }
    case "down": {
      state.scrollOffset = Math.max(0, state.scrollOffset - 3);
      break;
    }
    case "escape": {
      if (isStreaming(state) && state.convId) daemon.abort(state.convId);
      break;
    }
    case "ctrl-c":
    case "ctrl-d":    running = false; break;
    default:          return;
  }
  scheduleRender();
}

// ── Terminal setup ──────────────────────────────────────────────────

function setupTerminal(): void {
  process.stdout.write(enter_alt + hide_cursor);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}

function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write(show_cursor + leave_alt);
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  daemon = new DaemonClient(handleEvent);
  try {
    await daemon.connect();
  } catch (err) {
    console.error(`\n  ✗ ${(err as Error).message}\n`);
    process.exit(1);
  }

  daemon.onConnectionLost(() => {
    state.pendingAI = null;
    state.messages.push({ role: "system", text: "⚠ Lost connection to daemon.", metadata: null });
    scheduleRender();
    setTimeout(() => { running = false; }, 2000);
  });

  setupTerminal();

  process.stdout.on("resize", () => {
    state.cols = process.stdout.columns || 80;
    state.rows = process.stdout.rows || 24;
    scheduleRender();
  });

  state.messages.push({ role: "system", text: "Connected to exocortexd. Type a message to begin.", metadata: null });
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
