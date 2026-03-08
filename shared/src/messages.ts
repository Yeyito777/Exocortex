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

// ── Models ──────────────────────────────────────────────────────────

export type ModelId = "sonnet" | "haiku" | "opus";

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
  metadata: MessageMetadata | null;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  metadata: MessageMetadata;
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
  model: ModelId;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  /** Explicit user-set title. Takes priority over auto-generated preview. */
  title: string | null;
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

// ── Tool display info (daemon → TUI on connect) ────────────────────

export interface ToolDisplayInfo {
  name: string;     // "bash", "read", etc.
  label: string;    // "$", "Read", etc.
  color: string;    // hex color "#d19a66"
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
