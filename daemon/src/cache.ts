/**
 * Prompt cache control for Anthropic API requests.
 *
 * Injects ephemeral cache_control breakpoints into the request
 * payload to maximize Anthropic's prefix caching. Each breakpoint
 * tells the API to cache everything from the start of the request
 * up to and including the marked block (5-minute TTL).
 *
 * Budget: 4 breakpoints per request, allocated as:
 *   1. System prompt        — static, injected in api.ts
 *   2. Last tool definition — static across all turns
 *   3. Conversation history — stable across tool-use rounds
 *   4. Latest context       — caches full prefix for retries
 *
 * In multi-round tool-use, breakpoint 3 cascades: each round's
 * "fresh" breakpoint becomes the next round's "stable" breakpoint,
 * giving progressive cache hits across the entire agent loop.
 */

import type { ApiMessage, ApiContentBlock } from "./messages";

const CACHE_CONTROL = { type: "ephemeral" } as const;

// ── Tools ─────────────────────────────────────────────────────────────

/**
 * Return a copy of the tools array with a cache breakpoint on the
 * last definition. Combined with the system prompt breakpoint this
 * caches the entire static prefix (system + tools) across all turns.
 */
export function injectToolBreakpoints(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  const result = tools.map(t => ({ ...(t as Record<string, unknown>) }));
  result[result.length - 1].cache_control = CACHE_CONTROL;
  return result;
}

// ── Messages ──────────────────────────────────────────────────────────

/**
 * Return a copy of the messages array with up to 2 cache breakpoints
 * placed at strategic positions for maximum cache reuse.
 */
export function injectMessageBreakpoints(messages: ApiMessage[]): ApiMessage[] {
  if (messages.length === 0) return messages;

  // Shallow-clone messages and their content blocks (don't mutate originals)
  const result: ApiMessage[] = messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map(b => ({ ...b })),
    ...(m.metadata ? { metadata: m.metadata } : {}),
    ...(m.providerData ? { providerData: m.providerData } : {}),
  }));

  // Fresh breakpoint: always on the last message.
  // Caches the full conversation prefix for tool-use retries.
  markLastBlock(result[result.length - 1]);

  // Stable breakpoint: second-to-last user message.
  // In multi-round tool use this naturally aligns with the previous
  // round's fresh breakpoint, giving cascading cache hits.
  if (result.length >= 3) {
    const idx = findSecondLastUserMessage(result);
    if (idx >= 0) markLastBlock(result[idx]);
  }

  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Attach cache_control to the last content block of a message. */
function markLastBlock(message: ApiMessage): void {
  if (typeof message.content === "string") {
    // Convert string content to array form to attach cache_control
    message.content = [
      { type: "text", text: message.content, cache_control: CACHE_CONTROL } as ApiContentBlock,
    ];
    return;
  }
  if (message.content.length === 0) return;
  (message.content[message.content.length - 1] as Record<string, unknown>).cache_control = CACHE_CONTROL;
}

/** Find the index of the second-to-last user message. */
function findSecondLastUserMessage(messages: ApiMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      count++;
      if (count === 2) return i;
    }
  }
  return -1;
}
