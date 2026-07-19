/**
 * @exocortex/shared — Message and block domain model.
 *
 * The single source of truth for the core data structures shared
 * between the daemon and all clients. Blocks are the atoms of an
 * AI message. Messages are the units of a conversation.
 *
 * Package-specific extensions (ApiMessage, Conversation, helpers)
 * live in each package's own messages.ts and re-export from here.
 */

// ── Providers / Models ──────────────────────────────────────────────

export type ProviderId = "openai" | "deepseek";

/** Provider-scoped model identifier. */
export type ModelId = string;

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Reserved top-level folder used for autonomous subagent conversations. */
export const SUBAGENTS_FOLDER_NAME = "subagents";

export interface ReasoningEffortInfo {
  effort: EffortLevel;
  description: string;
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  maxContext: number;
  supportedEfforts: ReasoningEffortInfo[];
  defaultEffort: EffortLevel;
  /** Whether the model accepts image inputs. Omitted means "assume yes" for backwards compatibility. */
  supportsImages?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: ModelId;
  allowsCustomModels: boolean;
  supportsFastMode: boolean;
  models: ModelInfo[];
}

/** Preferred provider when the app needs a default selection. */
export const DEFAULT_PROVIDER_ID: ProviderId = "openai";

/** Preferred provider ordering for UI fallbacks and provider registries. */
export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = [DEFAULT_PROVIDER_ID, "deepseek"];

/** Preferred default model per provider when the app needs a fallback selection. */
export const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "gpt-5.6-sol",
  deepseek: "deepseek-v4-pro",
} as const satisfies Record<ProviderId, ModelId>;

// ── Effort ─────────────────────────────────────────────────────────

export const EFFORT_LEVELS: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: EffortLevel = "high";

/** Default effort fallback when the app only knows the provider/model ids. */
export function defaultEffortForModelId(providerId: ProviderId, model: ModelId): EffortLevel {
  if (providerId === "openai" && (/^gpt-5\.6-/.test(model) || /^gpt-5\.5(?:-|$)/.test(model))) return "medium";
  return DEFAULT_EFFORT;
}

export function supportsEffort(model: Pick<ModelInfo, "supportedEfforts"> | null | undefined, effort: EffortLevel): boolean {
  return model?.supportedEfforts.some((candidate) => candidate.effort === effort) ?? false;
}

export function normalizeEffortForModel(
  model: Pick<ModelInfo, "supportedEfforts" | "defaultEffort"> | null | undefined,
  effort: EffortLevel | null | undefined,
): EffortLevel {
  if (effort && supportsEffort(model, effort)) return effort;
  return model?.defaultEffort ?? DEFAULT_EFFORT;
}

export function supportsImageInputsForModel(
  model: Pick<ModelInfo, "supportsImages"> | null | undefined,
): boolean {
  return model?.supportsImages ?? true;
}

/** Maximum context window size in tokens, keyed by model id. */
export const MAX_CONTEXT: Record<string, number> = {
  "gpt-5": 400_000,
  // These OpenAI models run through the ChatGPT Codex backend. Their public
  // API context window is larger and should be modeled separately if added.
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "gpt-5.6-luna": 372_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.3-codex-spark": 128_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
};

// ── Image attachments ──────────────────────────────────────────────

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachment {
  mediaType: ImageMediaType;
  base64: string;       // base64-encoded image data
  sizeBytes: number;    // original byte size for display
}

// ── Blocks ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export type Block = ThinkingBlock | TextBlock | ToolCallBlock | ToolResultBlock;

// ── Message metadata ────────────────────────────────────────────────

/** Machine-readable identity and fallback text for persisted compaction dividers. */
export const CONTEXT_COMPACTION_FINISHED_KIND = "context_compaction_finished";
export const CONTEXT_COMPACTION_FINISHED_TEXT = "--- Compaction finished ---";

/**
 * Metadata attached to a message. Persisted by the daemon,
 * rendered by the client.
 */
export interface MessageMetadata {
  /** When the client sent this message. Client-originated. */
  startedAt: number;
  /** When the daemon finished. Null while streaming. */
  endedAt: number | null;
  /** Model used. Client-originated (set on creation). */
  model: ModelId;
  /** Accumulated output tokens. Starts at 0, daemon sends periodic updates. */
  tokens: number;
  /**
   * True for daemon-authored messages that should be visible to the model but
   * treated like system/UI notices instead of real user messages in clients.
   */
  system?: boolean;
  /** Machine-readable subtype for daemon-authored metadata/system notices. */
  kind?: string;
  /** Durable id used to deduplicate an accepted subagent completion notification. */
  subagentNotificationId?: string;
  /** Durable id used to deduplicate a user message accepted from the persistent queue. */
  queueEntryId?: string;
}

/** Build standard message metadata with sensible defaults. */
export function createMessageMetadata(
  startedAt: number,
  model: ModelId,
  options?: { endedAt?: number | null; tokens?: number },
): MessageMetadata {
  return {
    startedAt,
    endedAt: options?.endedAt ?? null,
    model,
    tokens: options?.tokens ?? 0,
  };
}

/**
 * Combine metadata from adjacent assistant fragments that render as one AI
 * message. This preserves the visible span across goal-continuation turns:
 * the rendered entry starts when the first fragment started, ends when the
 * last finished. Token counts are summed across distinct continuation turns;
 * fragments from the same turn keep the cumulative token count instead.
 */
export function combineMessageMetadata(
  current: MessageMetadata | null | undefined,
  next: MessageMetadata | null | undefined,
): MessageMetadata | null {
  if (!current && !next) return null;
  if (!current) return next ? { ...next } : null;
  if (!next) return { ...current };

  const sameAssistantTurn = current.startedAt === next.startedAt;

  return {
    ...next,
    startedAt: Math.min(current.startedAt, next.startedAt),
    endedAt: current.endedAt == null || next.endedAt == null
      ? null
      : Math.max(current.endedAt, next.endedAt),
    model: next.model,
    // Fragments with the same startedAt are pieces of one assistant turn (for
    // example tool-round salvage on abort), so their token counts are already
    // cumulative. Distinct starts are separate continuation turns and should add.
    tokens: sameAssistantTurn ? Math.max(current.tokens, next.tokens) : current.tokens + next.tokens,
  };
}

// ── Messages ────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
  images?: ImageAttachment[];
  metadata: MessageMetadata | null;
  /** Daemon-authored identity of this exact transcript boundary for safe unwinds. */
  unwindFingerprint?: string;
  /** Daemon-owned rewind point for Ctrl-W history editing. */
  contextCheckpoint?: UserMessageContextCheckpoint;
}

/** Safe client projection of the context immediately before a user message. */
export interface UserMessageContextCheckpoint {
  /** Last provider-reported (or daemon-estimated) context at this rewind point. */
  contextTokens: number | null;
  /** False when the message is represented by the latest irreversible compaction. */
  editable: boolean;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  metadata: MessageMetadata | null;
}

/**
 * System messages are daemon-generated notices (errors, status changes).
 * Shown to the user, persisted in the conversation, never sent to the AI.
 */
export interface SystemMessage {
  role: "system";
  text: string;
  color?: string;
  metadata: MessageMetadata | null;
}

/**
 * Per-conversation system instructions. Stored as messages[0], appended
 * to the global system prompt before each API call. Never sent as an
 * API message — only used to augment the system prompt string.
 */
export interface SystemInstructionsMessage {
  role: "system_instructions";
  text: string;
  metadata: null;
}

export type Message = UserMessage | AIMessage | SystemMessage | SystemInstructionsMessage;

// ── Conversation goals ───────────────────────────────────────────────

export type ConversationGoalStatus = "active" | "paused" | "complete";

export interface ConversationGoal {
  objective: string;
  status: ConversationGoalStatus;
  /** Whether the model may pause this goal. Defaults to true for older saved goals. */
  pausable?: boolean;
  /** Whether the model may mark this goal complete. Defaults to true for older saved goals. */
  completable?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Number of automatic continuation turns since the goal was set/resumed. */
  turns: number;
}

// ── Conversation summary ────────────────────────────────────────────

/** Ephemeral work currently owned by a conversation. */
export interface ConversationTaskSummary {
  /** Child conversation id for subagents, or the tool-owned task id for background work. */
  id: string;
  kind: "subagent" | "background" | "chrono";
  /** Short subagent conversation title or a compact background-command description. */
  title: string;
  /** Unix epoch milliseconds when this work started. */
  startedAt: number;
  /** Next due time for sleeping/scheduled Chrono work. */
  dueAt?: number;
  /** Chrono lifecycle shown by the focused-conversation Tasks UI. */
  chronoMode?: "wait" | "sleep" | "wake";
}

/** How an external notification subscription handles events for its conversation. */
export type ExternalNotificationDelivery = "wake" | "inbox" | "soft";

/** Health of an external notification subscription's source. */
export type ExternalIntegrationStatus = "active" | "offline" | "disabled";

/** Durable external notification route projected into conversation UI. */
export interface ExternalIntegrationSummary {
  /** Stable daemon-owned subscription id. */
  id: string;
  /** External tool manifest name, for example `discord` or `whatsapp`. */
  toolName: string;
  /** Tool-owned opaque source id. */
  sourceId: string;
  /** Human-readable source label supplied by the external tool. */
  label: string;
  /** Optional longer explanation of which external events this source emits. */
  description?: string;
  delivery: ExternalNotificationDelivery;
  status: ExternalIntegrationStatus;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Conversation title. The daemon owns automatic title generation. */
  title: string;
  /** Optional persistent objective that can auto-continue while active. */
  goal?: ConversationGoal | null;
  marked: boolean;
  pinned: boolean;
  streaming: boolean;
  /** False for maintenance jobs that must be aborted, but not replayed, across daemon restarts. */
  restartRecoverable?: boolean;
  unread: boolean;
  sortOrder: number;
  /** Folder containing this conversation. Null means the sidebar root. */
  folderId?: string | null;
  /** Ephemeral number of child subagent turns currently running for this conversation. */
  subagentCount?: number;
  /** Ephemeral number of detached background tool processes currently running for this conversation. */
  backgroundTaskCount?: number;
  /** Ephemeral task details used by focused-conversation activity UI. */
  tasks?: ConversationTaskSummary[];
  /** Durable external notification subscriptions targeting this conversation. */
  integrations?: ExternalIntegrationSummary[];
}

export interface FolderSummary {
  id: string;
  name: string;
  /** Parent folder. Null means the sidebar root. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  sortOrder: number;
  /** Effective parent→child AGENTS.md context for draft chats in this folder. */
  effectiveInstructions?: string;
}

export type SidebarItemRef =
  | { type: "conversation"; id: string }
  | { type: "folder"; id: string };

// ── Conversation sorting ────────────────────────────────────────────

/** Canonical sort: pinned first (by sortOrder), then unpinned (by sortOrder). */
export function sortConversations<T extends Pick<ConversationSummary, "pinned" | "sortOrder">>(list: T[]): T[] {
  return list.sort(compareConversations);
}

/** Comparator for conversation sorting. Usable standalone with Array.sort(). */
export function compareConversations(
  a: Pick<ConversationSummary, "pinned" | "sortOrder">,
  b: Pick<ConversationSummary, "pinned" | "sortOrder">,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.sortOrder - b.sortOrder;
}

// ── Sort-order placement helpers ────────────────────────────────────
// Used by both daemon (authoritative) and TUI (optimistic) to compute
// where a conversation lands when pinned/unpinned/created.

type SortOrderEntry = Pick<ConversationSummary, "id" | "pinned" | "sortOrder">;

/** sortOrder that places an item at the bottom of the pinned section. */
export function bottomPinnedOrder(items: Iterable<SortOrderEntry>, excludeId: string): number {
  let maxOrder = -Infinity;
  for (const c of items) {
    if (c.pinned && c.id !== excludeId && c.sortOrder > maxOrder) maxOrder = c.sortOrder;
  }
  return maxOrder === -Infinity ? 0 : maxOrder + 1;
}

/** sortOrder that places an item at the top of the unpinned section. */
export function topUnpinnedOrder(items: Iterable<SortOrderEntry>, excludeId?: string): number {
  let minOrder = 0;
  for (const c of items) {
    if (!c.pinned && c.id !== excludeId && c.sortOrder < minOrder) minOrder = c.sortOrder;
  }
  return minOrder - 1;
}

// ── Tool display info (daemon → TUI on connect) ────────────────────

export interface ToolDisplayInfo {
  name: string;     // "bash", "read", etc.
  label: string;    // "$", "Read", etc.
  color: string;    // hex color "#d19a66"
}

/**
 * External tool style — maps a bash sub-command prefix to TUI display
 * properties. Sent alongside ToolDisplayInfo so the TUI can style
 * bash invocations of external tools (e.g. "gmail" → Gmail label + color).
 */
export interface ExternalToolStyle {
  cmd: string;      // command prefix to match (e.g. "gmail")
  label: string;    // TUI label (e.g. "Gmail")
  color: string;    // hex color "#4ddbb7"
}

// ── Usage data ──────────────────────────────────────────────────────

export interface UsageWindow {
  /** Utilization percentage, 0–100. */
  utilization: number;
  /** Unix timestamp (ms) when this window resets. Null if unknown. */
  resetsAt: number | null;
}

export interface UsageData {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

// ── Token stats ─────────────────────────────────────────────────────

export const TOKEN_USAGE_SOURCES = [
  "conversation",
  "llm_complete",
  "title_generation",
  "browse_summary",
  "context_summary",
  "context_compaction",
] as const;

export type TokenUsageSource = typeof TOKEN_USAGE_SOURCES[number];

export interface TokenTrackingContext {
  source: TokenUsageSource;
  conversationId?: string;
}

export interface TokenUsageTotals {
  inputTokens: number;
  /** Input tokens billed/served through provider prompt-cache discounts when known. */
  cachedInputTokens: number;
  /** Input tokens known not to be cached. Zero for legacy/provider records without cache details. */
  uncachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

export interface TokenStatsBucket extends TokenUsageTotals {
  byProvider: Partial<Record<ProviderId, TokenUsageTotals>>;
  byModel: Record<ModelId, TokenUsageTotals>;
  bySource: Partial<Record<TokenUsageSource, TokenUsageTotals>>;
}

export interface TokenStatsDay extends TokenStatsBucket {
  /** Local calendar day in YYYY-MM-DD form. */
  day: string;
}

export interface TokenStatsSnapshot {
  /** Last time the backing stats store changed, or null if empty. */
  updatedAt: number | null;
  /** Today bucket in local time. Always present, zeroed when unused. */
  today: TokenStatsDay;
  /** Lifetime totals across all recorded days. */
  lifetime: TokenStatsBucket;
  /** Active days only, newest first. */
  days: TokenStatsDay[];
}

export function createTokenUsageTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
}

export function createTokenStatsBucket(): TokenStatsBucket {
  return {
    ...createTokenUsageTotals(),
    byProvider: {},
    byModel: {},
    bySource: {},
  };
}

export function createTokenStatsDay(day: string): TokenStatsDay {
  return {
    day,
    ...createTokenStatsBucket(),
  };
}
