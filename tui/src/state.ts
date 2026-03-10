/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import type { ModelId, UsageData, ToolDisplayInfo, ImageAttachment } from "./messages";
import type { Message, AIMessage, SystemMessage } from "./messages";
import type { MessageBound } from "./conversation";
import type { PanelFocus } from "./focus";
import type { ChatFocus } from "./chat";
import type { SidebarState } from "./sidebar";
import { createSidebarState } from "./sidebar";
import type { VimState } from "./vim";
import { createVimState } from "./vim";
import type { HistoryCursor } from "./historycursor";
import { createHistoryCursor } from "./historycursor";
import type { UndoState } from "./undo";
import { createUndoState, markInsertEntry } from "./undo";
import type { AutocompleteState } from "./autocomplete";

/** Cached layout values — set by the renderer, read by scroll functions. */
export interface LayoutCache {
  totalLines: number;      // total rendered message lines
  messageAreaHeight: number; // visible rows for messages
}

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  model: ModelId;
  convId: string | null;
  inputBuffer: string;
  cursorPos: number;
  cols: number;
  rows: number;
  scrollOffset: number;
  /** Rate-limit usage data from the daemon. Null until first update. */
  usage: UsageData | null;
  /** Input tokens from the latest API round. Null until first context_update. */
  contextTokens: number | null;
  /** Which panel has focus — sidebar or chat. */
  panelFocus: PanelFocus;
  /** Which sub-panel within chat has focus — prompt or history. */
  chatFocus: ChatFocus;
  /** Conversations sidebar state. */
  sidebar: SidebarState;
  /** Vim keybind engine state. */
  vim: VimState;
  /** Cached layout values — updated each render, read by scroll functions. */
  layout: LayoutCache;
  /** Pending message to send after conversation is created. */
  pendingSend: { active: boolean; text: string; images?: ImageAttachment[] };
  /** System messages buffered during streaming — flushed after AI message completes. */
  systemMessageBuffer: SystemMessage[];
  /** Available tools reported by the daemon on connect. */
  toolRegistry: ToolDisplayInfo[];
  /** Whether tool result output is visible. Toggled with Ctrl+O. */
  showToolOutput: boolean;
  /** Cursor position in chat history (active when chatFocus === "history"). */
  historyCursor: HistoryCursor;
  /** Visual mode anchor in chat history (row, col). Set when entering visual. */
  historyVisualAnchor: HistoryCursor;
  /** Cached rendered lines for history cursor navigation (ANSI included). */
  historyLines: string[];
  /** true for visual lines that are word-wrap continuations of the previous logical line. */
  historyWrapContinuation: boolean[];
  /** Per-message row ranges into historyLines (set by renderer). */
  historyMessageBounds: MessageBound[];
  /** Undo/redo state for the prompt line. */
  undo: UndoState;
  /** Autocomplete popup state (command or path completion). */
  autocomplete: AutocompleteState | null;
  /** Scroll offset for the prompt input area (vim-style: only scrolls when cursor leaves viewport). */
  promptScrollOffset: number;
  /** Images pasted from clipboard, waiting to be sent with the next message. */
  pendingImages: ImageAttachment[];
}

/** Streaming state is derived from pendingAI — no separate boolean. */
export function isStreaming(state: RenderState): boolean {
  return state.pendingAI !== null;
}

export function createInitialState(): RenderState {
  const s: RenderState = {
    messages: [],
    pendingAI: null,
    model: "opus",
    convId: null,
    inputBuffer: "",
    cursorPos: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
    usage: null,
    contextTokens: null,
    panelFocus: "chat",
    chatFocus: "prompt",
    sidebar: createSidebarState(),
    vim: createVimState(),
    layout: { totalLines: 0, messageAreaHeight: 0 },
    pendingSend: { active: false, text: "" },
    systemMessageBuffer: [],
    toolRegistry: [],
    showToolOutput: false,
    historyCursor: createHistoryCursor(),
    historyVisualAnchor: createHistoryCursor(),
    historyLines: [],
    historyWrapContinuation: [],
    historyMessageBounds: [],
    undo: createUndoState(),
    autocomplete: null,
    promptScrollOffset: 0,
    pendingImages: [],
  };
  // App starts in insert mode — mark entry so first Esc commits the session
  markInsertEntry(s.undo, s.inputBuffer, s.cursorPos);
  return s;
}
