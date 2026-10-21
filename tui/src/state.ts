import type { FastMode } from "@exocortex/shared/messages";
/**
 * TUI render state.
 *
 * Owns the shape of the UI state that drives rendering.
 * Message and block types live in messages.ts.
 */

import { createEmptyProviderAuthInfo } from "@exocortex/shared/auth";
import { productConversationDefaults, type ConversationDefaults } from "@exocortex/shared/config";
import type { ProviderId, ProviderInfo, ModelId, EffortLevel, UsageData, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, ModelInfo, TokenStatsSnapshot, UserMessage } from "./messages";
import { supportsImageInputsForModel } from "./messages";
import type { Message, AIMessage, SystemMessage, Block } from "./messages";
import { loadHideSensitiveInfoPreference } from "./privacy";
import { loadDiagnosticsPreference, loadFoldStylePreference, loadTurnWorkPreference } from "./diagnostics";
import type { FoldStyle } from "./turncollapse";
import { theme } from "./theme";
import type { MessageBound, RenderLineAnchor } from "./conversation";
import type { WrapCopyLine } from "./textwrap";
import type { PanelFocus } from "./focus";
import type { ChatFocus } from "./chat";
import type { SidebarState } from "./sidebar";
import { createSidebarState } from "./sidebar";
import { loadSidebarFolderViewPreference } from "./sidebar/folderview";
import type { VimState } from "./vim";
import { createVimState } from "./vim";
import type { HistoryCursor } from "./historycursor";
import { createHistoryCursor } from "./historycursor";
import type { SearchDirection } from "./search";
import type { UndoState } from "./undo";
import { commitInsertSession, createUndoState, markInsertEntry } from "./undo";
import type { AutocompleteState } from "./autocomplete";
import type { AccountsSnapshot, ConversationDefaultsSnapshot, ConversationGoal, MacroEnvironment, ProviderAuthInfo, UserMacro, ProviderProxyInfo, QueuedCommandInvocation, QueueTiming, QueueWaitTarget as ProtocolQueueWaitTarget, UserMessageAutomation } from "./protocol";
import type { VoiceChatMessageState, VoicePromptState } from "./voice";
import type { TokenStatsView } from "./commands/tokens";
import type { BtwPanelState } from "./btw/state";
import { createConversationScrollState, type ConversationScrollState } from "./conversationscroll/types";
import type { InlineImageTarget } from "./inlineimages";
import type { ImageModalState } from "./imagemodal";
import type { AccountsOpenRequest, AccountsScreenState } from "./accountsscreen";
import type { InstructionsModalState } from "./instructions/state";
import { createInstructionsStore, type InstructionsStore } from "./instructions/store";
import { createUserMacroStore, type UserMacroStore } from "./usermacros/store";

// ── Queue types ────────────────────────────────────────────────────

export type { QueueTiming } from "./protocol";

export type QueueWaitTarget = ProtocolQueueWaitTarget;

export interface QueuedMessage {
  /** Stable daemon queue identity. Optional only for transient test/voice placeholders. */
  id?: string;
  /** Local shadow awaiting its first authoritative daemon snapshot. */
  optimistic?: boolean;
  convId: string;
  text: string;
  /** A queued command to execute instead of sending text as a user message. */
  command?: QueuedCommandInvocation;
  timing: QueueTiming;
  images?: ImageAttachment[];
  /**
   * The daemon owns both stream-relative delivery and the global-idle `/queue`
   * FIFO. The TUI retains only an optimistic/display projection.
   */
  source?: "daemon" | "global-idle";
  /** Machine-readable provenance for daemon/model-authored queued prompts. */
  automation?: UserMessageAutomation;
  /** New-conversation /queue entries reserve a client conversation id here. */
  target?: "conversation" | "new-conversation";
  /** Captured draft settings for target === "new-conversation". */
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: FastMode;
  folderId?: string | null;
  /** Daemon-evaluated dependency that must be idle before delivery. */
  waitTarget?: QueueWaitTarget;
  createdAt?: number;
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

/** Sentinel index for queued messages in the edit message modal. */
export const EDIT_INDEX_QUEUED = -1;

export interface EditMessageItem {
  /** Index counting only user messages (0-based). -1 for queued. */
  userMessageIndex: number;
  text: string;
  isQueued: boolean;
  images?: ImageAttachment[];
  /** Original local message object, when this item represents a rendered user message. */
  message?: UserMessage;
  /** Actual object from state.messages before any canonicalization. */
  sourceMessage?: UserMessage;
  /** Original local queue object, when this item represents a queued message. */
  queuedMessage?: QueuedMessage;
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
  /** Width used only for history rows vertically beside a right-hand task panel. */
  historyWidth: number;
  /** Width history is laid out at (totalLines counts rows of this width). */
  chatWidth: number;
  /** Screen rectangle occupied by the task panel; a click there toggles its expansion. */
  taskPanelRect: { top: number; bottom: number; left: number; right: number } | null;
  /** Rows the expanded task panel can scroll; 0 when everything fits or it is collapsed. */
  taskPanelMaxScroll: number;
  /** Screen rectangle of the status line's usage block; a click there opens the Accounts screen. */
  usageBlockRect: { top: number; bottom: number; left: number; right: number } | null;
  /** Canonical history row and source/display offsets rendered on each message-area row. */
  historyViewportRows: Array<{ lineIndex: number; startCol: number; displayPrefixWidth: number; endCol?: number } | null>;
  chatCol: number;         // 1-based column where chat area starts
  sepAbove: number;        // first row below the message area (search bar or separator)
  firstInputRow: number;   // row number of first input line
  sepBelow: number;        // row number of separator below prompt
}

export interface DeferredHistoryRenderState {
  convId: string | null;
  width: number;
  /** First message index currently included in the rendered suffix. */
  startMessageIndex: number;
  /** Incremented when a new deferred render generation starts. */
  generation: number;
  /** True once the full conversation has been rendered. */
  complete: boolean;
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
  /** Absolute index of the oldest currently loaded non-instructions display entry. */
  historyStartIndex: number;
  /**
   * First loaded block of the entry at historyStartIndex. Nonzero when only the
   * tail of a long AI entry is loaded; that entry is still a single message.
   */
  historyStartBlockIndex: number;
  /** Absolute index of the first user message in the loaded window. */
  historyStartUserIndex: number;
  /** Total non-instructions display entries reported by the latest canonical snapshot. */
  historyTotalEntries: number;
  /** Whether another page exists before historyStartIndex. */
  historyHasOlder: boolean;
  /** True while an older-history page request is in flight. */
  historyLoadingOlder: boolean;
  /** Start time used to animate the older-history loading row. */
  historyLoadingStartedAt: number | null;
  /** Request id of the one older-history page currently in flight. */
  historyLoadingRequestId: string | null;
  /** Deadline for holding the first paint of a short opening window, or null. */
  historyOpeningFillUntil: number | null;
  /** Navigation to resume after older history is prepended. */
  pendingHistoryNavigation: import("./keybinds").Action | null;
  /** The AI message currently being streamed (not yet finalized). */
  pendingAI: AIMessage | null;
  /** Start time for the transient native context-compaction spinner. */
  contextCompactionStartedAt: number | null;
  /** When the streaming turn started waiting for the network to return (see network-wait.ts). */
  connectionWaitStartedAt: number | null;
  connectionWaitLabel: string | null;
  /** The daemon's shared connectivity monitor: offline since when, or null while online. */
  daemonOfflineSince: number | null;
  /** True when pendingAI was hydrated from a daemon snapshot rather than live local chunks. */
  pendingAIHydratedFromSnapshot: boolean;
  /**
   * Started-at timestamp for a metadata-only pendingAI whose metadata should be
   * hidden while waiting for the matching terminal streaming_stopped. This is
   * set when a terminal stream notice (interrupt/error) arrives before any
   * visible assistant content, and cleared for every new assistant turn.
   */
  suppressPendingAIMetadataStartedAt: number | null;
  provider: ProviderId;
  hasChosenProvider: boolean;
  /** Connection-scoped cache received from the daemon; never read from local config. */
  conversationDefaults: ConversationDefaultsSnapshot | null;
  model: ModelId;
  effort: EffortLevel;
  fastMode: FastMode;
  goal: ConversationGoal | null;
  convId: string | null;
  /** Conversation opened ahead of its canonical load (remote routes); shown as a spinner. */
  conversationLoading: { convId: string; startedAt: number } | null;
  /**
   * Latest load_conversation this TUI still wants applied. A load for another
   * conversation navigates only when it answers this request; starting a draft
   * replaces it with NO_CONVERSATION_OPEN so
   * late or replayed opens cannot yank the user back. Null means untracked
   * (nothing opened through the tracked path yet; loads apply as before).
   */
  conversationOpenRequest: { reqId: string | null; convId: string | null } | null;
  /** Selected remote daemon route. Null means the local daemon. */
  sshRemote: { alias: string; connected: boolean } | null;
  macroEnvironment: MacroEnvironment | null;
  /** The daemon's user macros with this TUI's unconfirmed changes (see usermacros/store). */
  macroStore: UserMacroStore;
  /** The macro this TUI last deleted, for /macro undo. */
  lastDeletedMacro: UserMacro | null;
  /** When the prompt text last changed by typing (ms epoch), so /macro can hold errors briefly. */
  promptEditedAt: number;
  /** Route transition UI is independent of chat messages and startup loads. */
  sshConnecting: { phase: "probing" | "loading"; message: string } | null;
  /** Folder captured when the current blank draft was started. Sidebar browsing must not retarget it. */
  draftFolderId: string | null;
  inputBuffer: string;
  cursorPos: number;
  /** Experimental: the daemon's predicted next message, shown as ghost text in the empty prompt. */
  nextMessageSuggestion: { convId: string; text: string } | null;
  /** Preferred prompt column for repeated vertical movement (Vim curswant). */
  promptCurswant: number | null;
  cols: number;
  rows: number;
  scrollOffset: number;
  /** TUI-local per-conversation position memory and response-scroll policy. */
  conversationScroll: ConversationScrollState;
  /** Whether each provider currently has configured credentials. */
  authByProvider: Record<ProviderId, boolean>;
  /** Rich auth metadata for each provider, reported by the daemon. */
  authInfoByProvider: Record<ProviderId, ProviderAuthInfo>;
  /** Rate-limit usage data keyed by provider. Null until first update per provider. */
  usageByProvider: Record<ProviderId, UsageData | null>;
  /** Providers the daemon sends through /proxy; null when the daemon predates /proxy. */
  providerProxies: ProviderProxyInfo[] | null;
  /** Persistent token-accounting snapshot from the daemon. */
  tokenStats: TokenStatsSnapshot | null;
  /** A /tokens report waiting for the get_token_stats reply with this reqId. */
  pendingTokenStatsView: (TokenStatsView & { reqId: string }) | null;
  /** Input tokens from the latest API round. Zero for a blank chat; null when unknown. */
  contextTokens: number | null;
  /** Which panel has focus — sidebar or chat. */
  panelFocus: PanelFocus;
  /** Which sub-panel within chat has focus — prompt, chat history, or BTW history. */
  chatFocus: ChatFocus;
  /** Conversations sidebar state. */
  sidebar: SidebarState;
  /** Vim keybind engine state. */
  vim: VimState;
  /** Cached layout values — updated each render, read by scroll functions. */
  layout: LayoutCache;
  /** Progressive chat-history render state used to paint large conversations quickly. */
  deferredHistoryRender: DeferredHistoryRenderState | null;
  /** Pending message to send after conversation is created. */
  pendingSend: { active: boolean; text: string; images?: ImageAttachment[] };
  /** Messages blocked on login; auto-sent after successful authentication. */
  pendingAuthQueue: AuthQueuedMessage[];
  /** Pending system instructions to apply after a conversation is created. */
  pendingSystemInstructions: string | null;
  /** Whether a just-created conversation should auto-generate its title. */
  pendingGenerateTitleOnCreate: boolean;
  /** Reserved id for a queued draft conversation that is still awaiting daemon creation. */
  pendingQueuedDraftConvId: string | null;
  /**
   * User-invoked notices buffered while streaming.
   *
   * These render as a live tail after the active AI message so slash-command
   * feedback stays visible at the bottom. Daemon-originated stream notices are
   * inserted inline instead.
   */
  streamingTailMessages: SystemMessage[];
  /** Canonical active-turn blocks already committed into state.messages. */
  pendingAIBlockOffset: number;
  /** Local active-turn blocks already committed into messages, including partial blocks. */
  pendingAIPartialCommittedBlocks: Block[];
  /**
   * Index of an assistant message that was committed inline before the daemon
   * sent streaming_stopped. Used to reconcile persisted abort/error blocks at
   * the correct history position instead of appending a second assistant turn.
   */
  pendingAICommittedIndex: number | null;
  /** Canonical block offset of pendingAICommittedIndex within the active turn. */
  pendingAICommittedBlockOffset: number | null;
  /** Index in pendingAIPartialCommittedBlocks immediately before that message. */
  pendingAICommittedLocalBlockIndex: number | null;
  /** Last daemon streamSeq observed per conversation, used to diagnose missed stream events. */
  lastStreamSeqByConv: Record<string, number | undefined>;
  /** Available tools reported by the daemon on connect. */
  toolRegistry: ToolDisplayInfo[];
  /** Available providers and models reported by the daemon on connect. */
  providerRegistry: ProviderInfo[];
  /** External tool styles for bash sub-command matching (from daemon). */
  externalToolStyles: ExternalToolStyle[];
  /** Detailed view: tool result output and every turn's work are visible. Toggled with Ctrl+I. */
  showToolOutput: boolean;
  /** Every turn's work and every notification are visible (otherwise they fold). Ctrl+O; saved in config.tui.showTurnWork. */
  showTurnWork: boolean;
  /** Experimental folded-history style (/foldstyle). */
  foldStyle: FoldStyle;
  /** Turns and notifications opened one at a time by a click while folded, by their opening message. */
  expandedHistoryItems: WeakSet<object>;
  /** Bumped whenever expandedHistoryItems changes, so cached renders notice. */
  historyExpansionRevision: number;
  /** Whether user-identifying auth/account labels should be censored in the UI. */
  hideSensitiveInfo: boolean;
  /** Whether output-token counts are shown in AI metadata. TUI-only /diagnostics. */
  showDiagnostics: boolean;
  /** Whether a tool-output fetch is currently in flight for the active conversation. */
  toolOutputsLoading: boolean;
  /** Daemon reqId of the newest in-flight tool-output fetch (null when unknown or idle). */
  toolOutputsRequestId: string | null;
  /** Tool results already requested for this transcript; automatic fetches never repeat them. */
  requestedToolOutputIds: Set<string>;
  /** Whether Ctrl+O should auto-expand once the in-flight tool-output fetch completes. */
  showToolOutputAfterLoad: boolean;
  /** Cursor position in chat history (active when chatFocus === "history"). */
  historyCursor: HistoryCursor;
  /** Preferred history column for repeated j/k movement (Vim curswant). */
  historyCurswant: number | null;
  /** Visual mode anchor in chat history (row, col). Set when entering visual. */
  historyVisualAnchor: HistoryCursor;
  /** Cached rendered lines for history cursor navigation (ANSI included). */
  historyLines: string[];
  /** true for visual lines that are word-wrap continuations of the previous logical line. */
  historyWrapContinuation: boolean[];
  /** separator to reinsert before each continuation line when copying/yanking. */
  historyWrapJoiners: string[];
  /** Per-rendered-line source projection for vim yanks/copies. */
  historyCopyLines: Array<WrapCopyLine | null>;
  /** Per-message row ranges into historyLines (set by renderer). */
  historyMessageBounds: MessageBound[];
  /** Per-rendered-line semantic anchors into historyLines (set by renderer). */
  historyLineAnchors: RenderLineAnchor[];
  /** Undo/redo state for the prompt line. */
  undo: UndoState;
  /** Autocomplete popup state (command or path completion). */
  autocomplete: AutocompleteState | null;
  /** Scroll offset for the prompt input area (vim-style: only scrolls when cursor leaves viewport). */
  promptScrollOffset: number;
  /** Queue prompt overlay — non-null when the modal is showing. */
  queuePrompt: QueuePromptState | null;
  /** Durable read-only aside thread owned by the active conversation until closed. */
  btw: BtwPanelState | null;
  /** Chat-history search state for vim-style / and ? search. */
  search: SearchState | null;
  /** Messages queued for delivery at a specific timing. */
  queuedMessages: QueuedMessage[];
  /** Optimistic unqueues awaiting an authoritative settled snapshot. */
  pendingQueueRemovalIds: Set<string>;
  /** Edit message modal — non-null when the modal is showing. */
  editMessagePrompt: EditMessageState | null;
  /** Images pasted from clipboard, waiting to be sent with the next message. */
  pendingImages: ImageAttachment[];
  /** Active hold-to-talk placeholder rendered inline in the prompt, if any. */
  voicePrompt: VoicePromptState | null;
  /** Completed recordings still being transcribed inline in the prompt. */
  voicePromptJobs: VoicePromptState[];
  /** Submitted voice transcription placeholder rendered as a local user message. */
  voiceMessage: VoiceChatMessageState | null;
  /** The /instructions picker and editor, drawn over everything while open. */
  instructionsModal: InstructionsModalState | null;
  /** Every instruction scope's text as the TUI has it, and saves on their way. */
  instructionsStore: InstructionsStore;
  /** Current mouse cursor shape — used to avoid redundant cursor shape OSC writes. */
  mouseCursor: "pointer" | "text" | "hand";
  /** Last reported pointer cell, so the shape can follow content that moves under a still mouse. */
  mousePosition?: { col: number; row: number } | null;
  /** Open only on release at the original link, never when dragging to select. */
  mouseLinkPress?: { row: number; col: number; target: string } | null;
  /** Left press on an inline image; a release on the same cell opens the viewer. */
  mouseImagePress?: { row: number; col: number; image: InlineImageTarget } | null;
  /** Folded turn/notification row pressed; a release on the same cell opens or closes it. */
  mouseTogglePress?: { row: number; col: number; toggle: object } | null;
  /** Full-size image viewer opened from history (Enter or click on a thumbnail). */
  imageModal: ImageModalState | null;
  /** Accounts screen (/accounts, `g a`), live while open. */
  accountsScreen: AccountsScreenState | null;
  /** An `accounts` request whose answer opens the screen (or explains why it cannot). */
  accountsOpenRequest: AccountsOpenRequest | null;
  /** Last `accounts` snapshot seen, shown at once when the screen reopens. */
  accountsSnapshotCache: AccountsSnapshot | null;
  /**
   * The Tasks panel expanded by a click to list every entry, with its
   * scroll offset in panel rows. Session-only and tied to one conversation:
   * the panel collapses when another conversation is shown.
   */
  taskPanelExpansion: { convId: string; scroll: number } | null;
}

/** The daemon's streaming bit also covers handoffs between ordinary turns. */
export function isStreaming(state: RenderState): boolean {
  return state.pendingAI !== null || state.sidebar.conversations.some(conv => conv.id === state.convId && conv.streaming);
}

/** Stop also applies to active goals suspended in a durable Chrono sleep. */
export function canInterrupt(state: RenderState): boolean {
  return isStreaming(state) || state.goal?.status === "active";
}

/** Clear pending AI state — always use this instead of setting pendingAI = null directly. */
export function clearPendingAI(state: RenderState): void {
  state.pendingAI = null;
  state.contextCompactionStartedAt = null;
  state.connectionWaitStartedAt = null;
  state.connectionWaitLabel = null;
  state.pendingAIHydratedFromSnapshot = false;
  state.pendingAICommittedIndex = null;
  state.pendingAICommittedBlockOffset = null;
  state.pendingAICommittedLocalBlockIndex = null;
  state.pendingAIBlockOffset = 0;
  state.pendingAIPartialCommittedBlocks = [];
  state.suppressPendingAIMetadataStartedAt = null;
}

/** Whether the active conversation is still waiting for its first canonical load. */
/** Every earlier open is unwanted: the user started a draft or a folder document. */
export function noConversationOpen(): { reqId: null; convId: null } {
  return { reqId: null, convId: null };
}

/** Record the load_conversation request the user currently wants applied. */
export function noteConversationOpenRequest(state: RenderState, convId: string, reqId: string): void {
  state.conversationOpenRequest = { reqId, convId };
}

export function isActiveConversationLoading(state: RenderState): boolean {
  return state.conversationLoading != null && state.conversationLoading.convId === state.convId;
}

/** Clear the live streaming tail used for user-invoked notices. */
export function clearStreamingTailMessages(state: RenderState): void {
  state.streamingTailMessages = [];
}

export function resetHistoryPagination(state: RenderState): void {
  state.historyStartIndex = 0;
  state.historyStartBlockIndex = 0;
  state.historyStartUserIndex = 0;
  state.historyTotalEntries = 0;
  state.historyHasOlder = false;
  state.historyLoadingOlder = false;
  state.pendingHistoryNavigation = null;
  state.historyLoadingStartedAt = null;
  state.historyLoadingRequestId = null;
  state.historyOpeningFillUntil = null;
  state.deferredHistoryRender = null;
}

/** Fully reset historical tool-output state (used when clearing/switching chats). */
export function resetToolOutputState(state: RenderState): void {
  // Ctrl+I is per view; Ctrl+O (showTurnWork) is a saved preference and stays.
  state.showToolOutput = false;
  clearToolOutputRequests(state);
}

/**
 * Forget fetch bookkeeping when a transcript is reloaded. An in-flight reply may
 * never arrive (reconnects), and loaded bodies are carried over separately.
 */
export function clearToolOutputRequests(state: RenderState): void {
  state.toolOutputsLoading = false;
  state.toolOutputsRequestId = null;
  state.requestedToolOutputIds.clear();
  state.showToolOutputAfterLoad = false;
}

/** Semantic system-notice colors accepted by TUI call sites and daemon events. */
export type SystemNoticeColorName = "muted" | "warning" | "error" | "success";

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
  if (color === "success") return theme.success;
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
 * "muted", "success") or an already-resolved ANSI style string.
 */
/** A client-only notice, not one of the daemon's display entries. */
export function isLocalOnlyMessage(message: Message): boolean {
  return message.role === "system" && message.localOnly === true;
}

export function pushSystemMessage(state: RenderState, text: string, color?: SystemNoticeColorName | string): void {
  const msg: SystemMessage = { role: "system", text, color: resolveSystemMessageColor(color), metadata: null, localOnly: true };
  if (isStreaming(state)) {
    state.streamingTailMessages.push(msg);
  } else {
    state.messages.push(msg);
  }
}

export function resetDraftConversationState(state: RenderState, folderId = state.sidebar.currentFolderId): void {
  state.convId = null;
  state.conversationLoading = null;
  state.conversationOpenRequest = noConversationOpen();
  // Starting a draft chooses its destination. Navigating the sidebar afterward
  // is only browsing and must not silently move the eventual conversation.
  state.draftFolderId = folderId;
  state.messages = [];
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  state.contextTokens = 0;
  state.goal = null;
  state.btw = null;
  state.voicePrompt = null;
  state.voicePromptJobs = [];
  state.voiceMessage = null;
  resetToolOutputState(state);
  resetNewConversationDefaults(state);
  state.pendingSystemInstructions = null;
  state.pendingGenerateTitleOnCreate = false;
  state.pendingQueuedDraftConvId = null;
  state.scrollOffset = 0;
  resetHistoryPagination(state);
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

/** Reset to the connected daemon's defaults, or a temporary bootstrap fallback. */
export function resetNewConversationDefaults(state: RenderState): void {
  const defaults = state.conversationDefaults?.defaults ?? productConversationDefaults();
  state.provider = defaults.provider;
  // Treat the configured default as the selected blank-chat provider so later
  // provider-registry refreshes don't substitute the focused/sole auth provider.
  state.hasChosenProvider = state.conversationDefaults !== null;
  state.model = defaults.model;
  state.effort = defaults.effort;
  state.fastMode = defaults.fastMode;
}

/** Never send the display-only startup fallback as an override of daemon defaults. */
export function newConversationSelection(state: RenderState): Partial<ConversationDefaults> {
  if (!state.conversationDefaults && !state.hasChosenProvider) return {};
  return { provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode };
}

// ── Focus transition helpers ──────────────────────────────────────
// Centralise the mode+focus combos that are repeated across call sites.

function commitFocusedPromptInsert(state: RenderState): void {
  if (state.panelFocus === "chat" && state.chatFocus === "prompt" && state.vim.mode === "insert") {
    commitInsertSession(state.undo, state.inputBuffer);
  }
}

/** Focus the prompt in insert mode. */
export function focusPrompt(state: RenderState): void {
  const alreadyEditingPrompt = state.panelFocus === "chat"
    && state.chatFocus === "prompt"
    && state.vim.mode === "insert";
  state.panelFocus = "chat";
  state.chatFocus = "prompt";
  if (state.vim.mode !== "insert") state.vim.mode = "insert";
  if (!alreadyEditingPrompt) {
    markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
  }
}

/** Focus chat history in normal mode. */
export function focusHistory(state: RenderState): void {
  commitFocusedPromptInsert(state);
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
}

/** Focus the conversation-owned BTW card using the ordinary history Vim context. */
export function focusBtw(state: RenderState): void {
  if (!state.btw) {
    focusHistory(state);
    return;
  }
  commitFocusedPromptInsert(state);
  state.panelFocus = "chat";
  state.chatFocus = "btw";
  state.vim.mode = "normal";
}

/** Focus the sidebar in normal mode. */
export function focusSidebar(state: RenderState): void {
  commitFocusedPromptInsert(state);
  state.panelFocus = "sidebar";
  state.vim.mode = "normal";
}

export function createInitialState(): RenderState {
  const defaults = productConversationDefaults();
  const provider = defaults.provider;
  const hideSensitiveInfo = loadHideSensitiveInfoPreference();

  const s: RenderState = {
    messages: [],
    historyStartIndex: 0,
    historyStartBlockIndex: 0,
    historyStartUserIndex: 0,
    historyTotalEntries: 0,
    historyHasOlder: false,
    historyLoadingOlder: false,
    historyOpeningFillUntil: null,
    pendingHistoryNavigation: null,
    historyLoadingStartedAt: null,
    historyLoadingRequestId: null,
    pendingAI: null,
    contextCompactionStartedAt: null,
    connectionWaitStartedAt: null,
    connectionWaitLabel: null,
    daemonOfflineSince: null,
    pendingAIHydratedFromSnapshot: false,
    suppressPendingAIMetadataStartedAt: null,
    provider,
    hasChosenProvider: false,
    conversationDefaults: null,
    model: defaults.model,
    effort: defaults.effort,
    fastMode: defaults.fastMode,
    goal: null,
    convId: null,
    conversationLoading: null,
    conversationOpenRequest: null,
    sshRemote: null,
    macroEnvironment: null,
    macroStore: createUserMacroStore(),
    lastDeletedMacro: null,
    promptEditedAt: 0,
    sshConnecting: null,
    draftFolderId: null,
    inputBuffer: "",
    nextMessageSuggestion: null,
    cursorPos: 0,
    promptCurswant: null,
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    scrollOffset: 0,
    conversationScroll: createConversationScrollState(),
    authByProvider: {
      openai: false,
      deepseek: false,
      opencode: false,
      openrouter: false,
      anthropic: false,
    },
    authInfoByProvider: {
      openai: createEmptyProviderAuthInfo(),
      deepseek: createEmptyProviderAuthInfo(),
      opencode: createEmptyProviderAuthInfo(),
      openrouter: createEmptyProviderAuthInfo(),
      anthropic: createEmptyProviderAuthInfo(),
    },
    usageByProvider: {
      openai: null,
      deepseek: null,
      opencode: null,
      openrouter: null,
      anthropic: null,
    },
    providerProxies: null,
    tokenStats: null,
    pendingTokenStatsView: null,
    contextTokens: 0,
    panelFocus: "chat",
    chatFocus: "prompt",
    sidebar: createSidebarState(loadSidebarFolderViewPreference()),
    vim: createVimState(),
    layout: { totalLines: 0, messageAreaHeight: 0, historyWidth: 0, chatWidth: 0, taskPanelRect: null, taskPanelMaxScroll: 0, usageBlockRect: null, historyViewportRows: [], chatCol: 1, sepAbove: 0, firstInputRow: 0, sepBelow: 0 },
    deferredHistoryRender: null,
    pendingSend: { active: false, text: "" },
    pendingAuthQueue: [],
    pendingSystemInstructions: null,
    pendingGenerateTitleOnCreate: false,
    pendingQueuedDraftConvId: null,
    streamingTailMessages: [],
    pendingAIBlockOffset: 0,
    pendingAIPartialCommittedBlocks: [],
    pendingAICommittedIndex: null,
    pendingAICommittedBlockOffset: null,
    pendingAICommittedLocalBlockIndex: null,
    lastStreamSeqByConv: {},
    toolRegistry: [],
    providerRegistry: [],
	    externalToolStyles: [],
	    showToolOutput: false,
	    showTurnWork: loadTurnWorkPreference(),
	    foldStyle: loadFoldStylePreference(),
	    expandedHistoryItems: new WeakSet(),
	    historyExpansionRevision: 0,
	    hideSensitiveInfo,
	    showDiagnostics: loadDiagnosticsPreference(),
    toolOutputsLoading: false,
    toolOutputsRequestId: null,
    requestedToolOutputIds: new Set(),
    showToolOutputAfterLoad: false,
    historyCursor: createHistoryCursor(),
    historyCurswant: null,
    historyVisualAnchor: createHistoryCursor(),
    historyLines: [],
    historyWrapContinuation: [],
    historyWrapJoiners: [],
    historyCopyLines: [],
    historyMessageBounds: [],
    historyLineAnchors: [],
    imageModal: null,
    accountsScreen: null,
    accountsOpenRequest: null,
    accountsSnapshotCache: null,
    taskPanelExpansion: null,
    undo: createUndoState(),
    autocomplete: null,
    promptScrollOffset: 0,
    queuePrompt: null,
    btw: null,
    search: null,
    queuedMessages: [],
    pendingQueueRemovalIds: new Set(),
    editMessagePrompt: null,
    pendingImages: [],
    voicePrompt: null,
    voicePromptJobs: [],
    voiceMessage: null,
    instructionsModal: null,
    instructionsStore: createInstructionsStore(),
    mouseCursor: "pointer",
  };
  // App starts in insert mode — mark entry so first Esc commits the session
  markInsertEntry(s.undo, s.inputBuffer, s.cursorPos);
  return s;
}
