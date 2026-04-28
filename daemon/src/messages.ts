/**
 * Message and block model for exocortexd.
 *
 * Re-exports the shared domain types and adds daemon-specific
 * types: API-level content blocks, API messages (for conversation
 * storage / replay), and the Conversation type.
 */

// ── Shared domain types (single source of truth) ────────────────────

export * from "@exocortex/shared/messages";

// ── API-level types (for stored conversations / API replay) ─────────

import { DEFAULT_EFFORT, type ProviderId, type ModelId, type EffortLevel, type MessageMetadata, type ConversationSummary } from "@exocortex/shared/messages";
import type { AssistantProviderData } from "./providers/provider-data";

export type ApiContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
  providerData?: AssistantProviderData;
}

/** A message with optional metadata for persistence. */
export interface StoredMessage {
  role: "user" | "assistant" | "system" | "system_instructions";
  content: string | ApiContentBlock[];
  metadata: MessageMetadata | null;
  providerData?: AssistantProviderData;
}

// ── Conversation state ──────────────────────────────────────────────

export interface Conversation {
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  /** Conversation title. The daemon owns automatic title generation. */
  title: string;
}

/**
 * True if a message contains any tool_result blocks.
 *
 * Used to distinguish "real" user messages from the tool_result
 * containers the API requires between tool_use and the next
 * assistant turn.  Uses `some()` (not `every()`) so that
 * tool_result messages with extra content — such as context
 * pressure hints injected by the agent loop — are still
 * recognised as tool-result messages.  This matches the logic
 * in display.ts, which folds any message with tool_results
 * into the AI entry.  Without this consistency, unwindTo's
 * user-message index drifts from the TUI's index and the
 * splice can land between a tool_use and its tool_result,
 * bricking the conversation.  Also used by the context tool's
 * snapRange to keep tool_use/tool_result pairs atomic.
 */
export function isToolResultMessage(msg: StoredMessage): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.length > 0 && msg.content.some(b => b.type === "tool_result");
}

/** True for actual user/assistant history turns, excluding daemon metadata entries. */
export function isHistoryMessage(msg: StoredMessage): msg is StoredMessage & { role: "user" | "assistant" } {
  return msg.role !== "system" && msg.role !== "system_instructions";
}

/** Build turn index → messages index mapping for real conversation history. */
export function buildHistoryTurnMap(messages: StoredMessage[]): number[] {
  const map: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isHistoryMessage(messages[i])) map.push(i);
  }
  return map;
}

/** Count messages for summaries/UI, excluding per-conversation instructions metadata. */
export function countConversationMessages(messages: StoredMessage[]): number {
  return messages.filter((msg) => msg.role !== "system_instructions").length;
}

export type PersistedConversationSummary = Omit<ConversationSummary, "streaming" | "unread">;

export function summarizeConversation(conv: Conversation): PersistedConversationSummary {
  return {
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort ?? DEFAULT_EFFORT,
    fastMode: conv.fastMode ?? false,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: countConversationMessages(conv.messages),
    title: conv.title,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
  };
}

export function createConversation(
  id: string,
  provider: ProviderId,
  model: ModelId,
  sortOrder?: number,
  title?: string,
  effort?: EffortLevel,
  fastMode = false,
): Conversation {
  const now = Date.now();
  return {
    id,
    provider,
    model,
    effort: effort ?? DEFAULT_EFFORT,
    fastMode,
    messages: [],
    createdAt: now,
    updatedAt: now,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: sortOrder ?? -now,
    title: title ?? "",
  };
}
