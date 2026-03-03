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
import { render, enter_alt, leave_alt, hide_cursor, show_cursor } from "./render";
import { createInitialState, isStreaming } from "./state";
import { createPendingAI, ensureCurrentBlock } from "./messages";
import { theme } from "./theme";
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
        state.messages.push({ role: "system", text: `✗ ${msg}`, color: theme.error, metadata: null });
      }
      pendingErrors = [];

      if (wasInterrupted) {
        state.messages.push({ role: "system", text: "✗ Interrupted", color: theme.error, metadata: null });
      }
      if (streamTickTimer) { clearTimeout(streamTickTimer); streamTickTimer = null; }
      break;
    }

    case "error": {
      if (isStreaming(state)) {
        pendingErrors.push(event.message);
      } else {
        state.messages.push({ role: "system", text: `✗ ${event.message}`, color: theme.error, metadata: null });
      }
      break;
    }

    case "usage_update": {
      state.usage = event.usage;
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

  // Slash commands
  const cmdResult = tryCommand(text, state);
  if (cmdResult) {
    if (cmdResult.type === "quit") { running = false; return; }
    scheduleRender();
    return;
  }

  // Regular message
  clearPrompt(state);
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
    case "handled":
      break;
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
