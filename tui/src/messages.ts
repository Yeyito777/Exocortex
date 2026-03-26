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

/** Resolve the display name for a conversation: title or fallback. */
export function convDisplayName(
  conv: Pick<ConversationSummary, "title">,
  fallback = "",
): string {
  let name = conv.title || fallback;
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
 * Truncate an AI message's blocks to the last completed tool round.
 *
 * "Completed" means everything through the last tool_result or tool_call
 * block. Trailing text/thinking blocks (partial content from a failed
 * streaming attempt) are discarded. This is safe because tool_call and
 * tool_result blocks are only appended by the agent loop after the API
 * call returns — they're never partial.
 *
 * Used on stream retry to clear stale partial output without losing
 * blocks from earlier, fully-completed rounds.
 */
export function truncateToCompletedRounds(msg: AIMessage): void {
  let lastCompletedIdx = -1;
  for (let i = msg.blocks.length - 1; i >= 0; i--) {
    const t = msg.blocks[i].type;
    if (t === "tool_result" || t === "tool_call") {
      lastCompletedIdx = i;
      break;
    }
  }
  msg.blocks.length = lastCompletedIdx + 1;
}

/**
 * Split a pending AI message at its current position.
 *
 * Moves existing blocks into a finalized AI message (returned) and
 * resets the original for continuation (blocks emptied, metadata kept).
 * Returns null if there are no blocks to commit.
 *
 * Used when a mid-stream event (retry, queued user message) needs
 * to appear inline between completed and upcoming blocks.
 */
export function splitPendingAI(msg: AIMessage): AIMessage | null {
  if (msg.blocks.length === 0) return null;
  const finalized: AIMessage = {
    role: "assistant",
    blocks: msg.blocks,
    metadata: null,
  };
  msg.blocks = [];
  return finalized;
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
