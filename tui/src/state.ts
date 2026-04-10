/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import { createEmptyProviderAuthInfo } from "@exocortex/shared/auth";
import type { ProviderId, ProviderInfo, ModelId, EffortLevel, UsageData, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, ModelInfo } from "./messages";
import { DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, supportsImageInputsForModel } from "./messages";
import type { Message, AIMessage, SystemMessage } from "./messages";
import { loadPreferredProvider } from "./preferences";
import { theme } from "./theme";
import type { MessageBound } from "./conversation";
import type { PanelFocus } from "./focus";
import type { ChatFocus } from "./chat";
import type { SidebarState } from "./sidebar";
import { createSidebarState } from "./sidebar";
import type { VimState } from "./vim";
import { createVimState } from "./vim";
import type { HistoryCursor } from "./historycursor";
import { createHistoryCursor } from "./historycursor";
import type { SearchDirection } from "./search";
import type { UndoState } from "./undo";
import { createUndoState, markInsertEntry } from "./undo";
import type { AutocompleteState } from "./autocomplete";
import type { ProviderAuthInfo, QueueTiming } from "./protocol";

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

export interface AuthQueuedMessage {
  text: string;
  images?: ImageAttachment[];
  echoStartedAt: number;
}

// ── Edit message modal types ──────────────────────────────────────

/** Sentinel index for system instructions in the edit message modal. */
export const EDIT_INDEX_INSTRUCTIONS = -2;
/** Sentinel index for queued messages in the edit message modal. */
export const EDIT_INDEX_QUEUED = -1;

export interface EditMessageItem {
  /** Index counting only user messages (0-based). -1 for queued, -2 for system instructions. */
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
  sepAbove: number;        // first row below the message area (search bar or separator)
  firstInputRow: number;   // row number of first input line
  sepBelow: number;        // row number of separator below prompt
}

export interface SearchState {
  barOpen: boolean;
  barMode: "search" | "command";
  direction: SearchDirection;
  query: string;
  barInput: string;
  barCursorPos: number;
  highlightsVisible: boolean;
  savedScrollOffset: number;
  savedHistoryCursor: HistoryCursor;
  originChatFocus: ChatFocus;
}

export interface RenderState {
  messages: Message[];
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  provider: ProviderId;
  hasChosenProvider: boolean;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  convId: string | null;
  inputBuffer: string;
  cursorPos: number;
  cols: number;
  rows: number;
  scrollOffset: number;
  /** Whether each provider currently has configured credentials. */
  authByProvider: Record<ProviderId, boolean>;
  /** Rich auth metadata for each provider, reported by the daemon. */
  authInfoByProvider: Record<ProviderId, ProviderAuthInfo>;
  /** Rate-limit usage data keyed by provider. Null until first update per provider. */
  usageByProvider: Record<ProviderId, UsageData | null>;
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
  /** Messages blocked on login; auto-sent after successful authentication. */
  pendingAuthQueue: AuthQueuedMessage[];
  /** Pending system instructions to apply after a conversation is created. */
  pendingSystemInstructions: string | null;
  /** Whether a just-created conversation should auto-generate its title. */
  pendingGenerateTitleOnCreate: boolean;
  /**
   * User-invoked notices buffered while streaming.
   *
   * These render as a live tail after the active AI message so slash-command
   * feedback stays visible at the bottom. Daemon-originated stream notices are
   * inserted inline instead.
   */
  streamingTailMessages: SystemMessage[];
  /**
   * Index of an assistant message that was committed inline before the daemon
   * sent streaming_stopped. Used to reconcile persisted abort/error blocks at
   * the correct history position instead of appending a second assistant turn.
   */
  pendingAICommittedIndex: number | null;
  /** Available tools reported by the daemon on connect. */
  toolRegistry: ToolDisplayInfo[];
  /** Available providers and models reported by the daemon on connect. */
  providerRegistry: ProviderInfo[];
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
  /** Chat-history search state for vim-style / and ? search. */
  search: SearchState | null;
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
  state.pendingAICommittedIndex = null;
}

/** Clear the live streaming tail used for user-invoked notices. */
export function clearStreamingTailMessages(state: RenderState): void {
  state.streamingTailMessages = [];
}

/** Semantic system-notice colors accepted by TUI call sites and daemon events. */
export type SystemNoticeColorName = "muted" | "warning" | "error";

/**
 * Normalize a system-notice color into a concrete ANSI style.
 *
 * Accepts either a semantic color name (e.g. "warning") or an already-resolved
 * theme escape sequence (e.g. theme.warning). Unknown strings are passed
 * through unchanged so custom ANSI styles still work.
 */
export function resolveSystemMessageColor(color?: SystemNoticeColorName | string): string | undefined {
  if (color === "error") return theme.error;
  if (color === "warning") return theme.warning;
  if (color === "muted") return theme.muted;
  return color;
}

/**
 * Add a user-invoked system notice to the UI.
 *
 * While an assistant response is actively streaming, these notices are kept in
 * the live tail so command feedback stays visible at the bottom. Daemon-
 * originated stream notices should bypass this helper and be inserted inline.
 *
 * The color may be either a semantic notice color name ("warning", "error",
 * "muted") or an already-resolved ANSI style string.
 */
export function pushSystemMessage(state: RenderState, text: string, color?: SystemNoticeColorName | string): void {
  const msg: SystemMessage = { role: "system", text, color: resolveSystemMessageColor(color), metadata: null };
  if (isStreaming(state)) {
    state.streamingTailMessages.push(msg);
  } else {
    state.messages.push(msg);
  }
}

export function getProviderInfo(state: RenderState, provider = state.provider): ProviderInfo | null {
  return state.providerRegistry.find((candidate) => candidate.id === provider) ?? null;
}

export function getModelInfo(state: RenderState, provider = state.provider, model = state.model): ModelInfo | null {
  return getProviderInfo(state, provider)?.models.find((candidate) => candidate.id === model) ?? null;
}

export function modelSupportsImages(state: RenderState, provider = state.provider, model = state.model): boolean {
  return supportsImageInputsForModel(getModelInfo(state, provider, model));
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
  const preferredProvider = loadPreferredProvider();
  const provider = preferredProvider ?? DEFAULT_PROVIDER_ID;

  const s: RenderState = {
    messages: [],
    pendingAI: null,
    provider,
    hasChosenProvider: preferredProvider !== null,
    model: DEFAULT_MODEL_BY_PROVIDER[provider],
    effort: DEFAULT_EFFORT,
    fastMode: false,
    convId: null,
    inputBuffer: "",
    cursorPos: 0,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
    authByProvider: {
      anthropic: false,
      openai: false,
    },
    authInfoByProvider: {
      anthropic: createEmptyProviderAuthInfo(),
      openai: createEmptyProviderAuthInfo(),
    },
    usageByProvider: {
      anthropic: null,
      openai: null,
    },
    contextTokens: null,
    panelFocus: "chat",
    chatFocus: "prompt",
    sidebar: createSidebarState(),
    vim: createVimState(),
    layout: { totalLines: 0, messageAreaHeight: 0, chatCol: 1, sepAbove: 0, firstInputRow: 0, sepBelow: 0 },
    pendingSend: { active: false, text: "" },
    pendingAuthQueue: [],
    pendingSystemInstructions: null,
    pendingGenerateTitleOnCreate: false,
    streamingTailMessages: [],
    pendingAICommittedIndex: null,
    toolRegistry: [],
    providerRegistry: [],
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
    search: null,
    queuedMessages: [],
    editMessagePrompt: null,
    pendingImages: [],
    mouseCursor: "pointer",
  };
  // App starts in insert mode — mark entry so first Esc commits the session
  markInsertEntry(s.undo, s.inputBuffer, s.cursorPos);
  return s;
}
