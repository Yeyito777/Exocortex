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

export type ProviderId = "anthropic" | "openai";

/** Provider-scoped model identifier. */
export type ModelId = string;

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: ModelId;
  allowsCustomModels: boolean;
  models: ModelInfo[];
}

// ── Effort ─────────────────────────────────────────────────────────

export const EFFORT_LEVELS: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: EffortLevel = "high";

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

/** Maximum context window size in tokens, keyed by model id. */
export const MAX_CONTEXT: Record<string, number> = {
  sonnet: 1_000_000,
  haiku: 1_000_000,
  opus: 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
  "claude-haiku-4-5-20251001": 1_000_000,
  "claude-opus-4-6": 1_000_000,
  "gpt-5": 400_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
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
}

// ── Messages ────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
  images?: ImageAttachment[];
  metadata: MessageMetadata | null;
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

export type Message = UserMessage | AIMessage | SystemMessage;

// ── Conversation summary ────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Client-set title. The daemon stores it as-is — naming logic lives in the client. */
  title: string;
  marked: boolean;
  pinned: boolean;
  streaming: boolean;
  unread: boolean;
  sortOrder: number;
}

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
