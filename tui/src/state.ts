/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import type { ModelId, EffortLevel, UsageData, ToolDisplayInfo, ExternalToolStyle, ImageAttachment } from "./messages";
import { DEFAULT_EFFORT } from "./messages";
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
import type { QueueTiming } from "./protocol";

// ── Queue types ────────────────────────────────────────────────────

export type { QueueTiming } from "./protocol";

export interface QueuedMessage {
  convId: string;
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

export interface QueuePromptState {
  text: string;            // the message text being queued
  selection: QueueTiming;  // which option is highlighted
  images?: ImageAttachment[];
}

// ── Edit message modal types ──────────────────────────────────────

export interface EditMessageItem {
  /** Index counting only user messages (0-based). -1 for queued messages. */
  userMessageIndex: number;
  text: string;
  isQueued: boolean;
  images?: ImageAttachment[];
}

export interface EditMessageState {
  items: EditMessageItem[];
  selection: number;        // index into items[]
  scrollOffset: number;     // for scrolling long lists
}

/** Cached layout values — set by the renderer, read by scroll and mouse functions. */
export interface LayoutCache {
  totalLines: number;      // total rendered message lines
  messageAreaHeight: number; // visible rows for messages
  chatCol: number;         // 1-based column where chat area starts
  sepAbove: number;        // row number of separator above prompt
  firstInputRow: number;   // row number of first input line
  sepBelow: number;        // row number of separator below prompt
}

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  model: ModelId;
  effort: EffortLevel;
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
  /** External tool styles for bash sub-command matching (from daemon). */
  externalToolStyles: ExternalToolStyle[];
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
  /** Queue prompt overlay — non-null when the modal is showing. */
  queuePrompt: QueuePromptState | null;
  /** Messages queued for delivery at a specific timing. */
  queuedMessages: QueuedMessage[];
  /** Edit message modal — non-null when the modal is showing. */
  editMessagePrompt: EditMessageState | null;
  /** Images pasted from clipboard, waiting to be sent with the next message. */
  pendingImages: ImageAttachment[];
  /** Current mouse cursor shape — used to avoid redundant cursor shape OSC writes. */
  mouseCursor: "pointer" | "text" | "hand";
}

/** Streaming state is derived from pendingAI — no separate boolean. */
export function isStreaming(state: RenderState): boolean {
  return state.pendingAI !== null;
}

/** Clear pending AI state — always use this instead of setting pendingAI = null directly. */
export function clearPendingAI(state: RenderState): void {
  state.pendingAI = null;
}

// ── Focus transition helpers ──────────────────────────────────────
// Centralise the mode+focus combos that are repeated across call sites.

/** Focus the prompt in insert mode. */
export function focusPrompt(state: RenderState): void {
  state.panelFocus = "chat";
  state.chatFocus = "prompt";
  if (state.vim.mode !== "insert") state.vim.mode = "insert";
}

/** Focus chat history in normal mode. */
export function focusHistory(state: RenderState): void {
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
}

/** Focus the sidebar in normal mode. */
export function focusSidebar(state: RenderState): void {
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
}

export function createInitialState(): RenderState {
  const s: RenderState = {
    messages: [],
    pendingAI: null,
    model: "opus",
    effort: DEFAULT_EFFORT,
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
    layout: { totalLines: 0, messageAreaHeight: 0, chatCol: 1, sepAbove: 0, firstInputRow: 0, sepBelow: 0 },
    pendingSend: { active: false, text: "" },
    systemMessageBuffer: [],
    toolRegistry: [],
    externalToolStyles: [],
    showToolOutput: false,
    historyCursor: createHistoryCursor(),
    historyVisualAnchor: createHistoryCursor(),
    historyLines: [],
    historyWrapContinuation: [],
    historyMessageBounds: [],
    undo: createUndoState(),
    autocomplete: null,
    promptScrollOffset: 0,
    queuePrompt: null,
    queuedMessages: [],
    editMessagePrompt: null,
    pendingImages: [],
    mouseCursor: "pointer",
  };
  // App starts in insert mode — mark entry so first Esc commits the session
  markInsertEntry(s.undo, s.inputBuffer, s.cursorPos);
  return s;
}
