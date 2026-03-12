/**
 * Message and block model for the Exocortex TUI.
 *
 * Re-exports the shared domain types and adds TUI-specific
 * helpers for building messages during streaming.
 */

// ── Shared domain types (single source of truth) ────────────────────

export * from "@exocortex/shared/messages";

// ── TUI helpers ─────────────────────────────────────────────────────

import type { AIMessage, Block, ModelId, ConversationSummary } from "@exocortex/shared/messages";

/** Resolve the display name for a conversation: title > preview > fallback. */
export function convDisplayName(
  conv: Pick<ConversationSummary, "title" | "preview">,
  fallback = "",
): string {
  let name = conv.title || conv.preview || fallback;
  const nl = name.indexOf("\n");
  if (nl !== -1) name = name.slice(0, nl);
  return name;
}

/** Create a fresh pending AI message for streaming. */
export function createPendingAI(startedAt: number, model: ModelId): AIMessage {
  return {
    role: "assistant",
    blocks: [],
    metadata: { startedAt, endedAt: null, model, tokens: 0 },
  };
}

/**
 * Get or create the last block of the given type in an AI message.
 * Used during streaming to append chunks to the right block.
 */
export function ensureCurrentBlock(msg: AIMessage, type: "text" | "thinking"): Block {
  const blocks = msg.blocks;
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) return last;

  const block: Block = { type, text: "" };
  blocks.push(block);
  return block;
}
