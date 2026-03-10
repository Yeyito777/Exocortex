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

import type { ModelId, MessageMetadata } from "@exocortex/shared/messages";

export type ApiContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
}

/** A message with optional metadata for persistence. */
export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: string | ApiContentBlock[];
  metadata: MessageMetadata | null;
}

// ── Conversation state ──────────────────────────────────────────────

export interface Conversation {
  id: string;
  model: ModelId;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  /** Explicit user-set title. Null means use auto-generated preview. */
  title: string | null;
}

/** Extract a short preview from the first user message in a message list. */
export function extractPreview(messages: StoredMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user" && typeof msg.content === "string") {
      return msg.content.slice(0, 80);
    }
  }
  return "";
}

/** Resolve the display name: explicit title, first-message preview, or "(empty)". */
export function displayName(conv: Conversation): string {
  return conv.title || extractPreview(conv.messages) || "(empty)";
}

export function createConversation(id: string, model: ModelId, sortOrder?: number): Conversation {
  const now = Date.now();
  return {
    id,
    model,
    messages: [],
    createdAt: now,
    updatedAt: now,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: sortOrder ?? -now,
    title: null,
  };
}
