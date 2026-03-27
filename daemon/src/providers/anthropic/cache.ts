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

import type { ApiMessage, ApiContentBlock } from "../../messages";

const CACHE_CONTROL = { type: "ephemeral" } as const;

export function injectToolBreakpoints(tools: unknown[]): unknown[] {
  if (tools.length === 0) return tools;
  const result = tools.map(t => ({ ...(t as Record<string, unknown>) }));
  result[result.length - 1].cache_control = CACHE_CONTROL;
  return result;
}

export function injectMessageBreakpoints(messages: ApiMessage[]): ApiMessage[] {
  if (messages.length === 0) return messages;

  const result: ApiMessage[] = messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map(b => ({ ...b })),
  }));

  markLastBlock(result[result.length - 1]);

  if (result.length >= 3) {
    const idx = findSecondLastUserMessage(result);
    if (idx >= 0) markLastBlock(result[idx]);
  }

  return result;
}

function markLastBlock(message: ApiMessage): void {
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text: message.content, cache_control: CACHE_CONTROL } as ApiContentBlock,
    ];
    return;
  }
  if (message.content.length === 0) return;
  (message.content[message.content.length - 1] as Record<string, unknown>).cache_control = CACHE_CONTROL;
}

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

