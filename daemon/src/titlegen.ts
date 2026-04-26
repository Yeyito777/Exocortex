/**
 * Daemon-owned conversation title generation.
 *
 * Keeping title generation in the daemon makes it durable across TUI client
 * disconnects: once requested or auto-started, the daemon persists the pending
 * title and later persists/broadcasts the final title without relying on a
 * request-scoped client callback.
 */

import { log } from "./log";
import { complete } from "./llm";
import * as convStore from "./conversations";
import type { DaemonServer } from "./server";
import type { ApiContentBlock, Conversation, ProviderId, StoredMessage } from "./messages";
import { isToolResultMessage } from "./messages";
import { getTokenStatsSnapshot } from "./token-stats";

const INSTRUCTION = `You generate short conversation titles. Output ONLY the title — 3 to 4 lowercase words, no quotes, no punctuation, no explanation. Match this naming style:
exo bash truncate, exo code qa, berlin airbnb, tokens bug, context tool, unbricking convo, merging img pasting, netherlands trains, exo vim linewrapping, exo msg queuing, fixing message queuing, airpods pro autoconnect, discord streaming, context management`;

// Must exceed the thinking budget (10000) configured in api.ts for
// non-adaptive models — otherwise all tokens go to thinking and the
// text response is empty.
const MAX_TOKENS = 10200;

/** Max characters of user message context to send for title generation. */
const MAX_CONTEXT_CHARS = 2000;

/** Placeholder title shown while generation is in-flight. */
export const PENDING_TITLE = "pending";

const MARK_EMOJI_SET = new Set(["🕐", "🔥", "🧪", "📝", "🐛", "💡", "🔒", "✅", "📡"]);
const activeTitleJobs = new Set<string>();

function titleModelForProvider(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      // Title generation was previously a mini-tier utility task; keep it on the
      // working GPT-5.4 mini model until a usable GPT-5.5 mini arrives.
      return "gpt-5.4-mini";
    case "anthropic":
    default:
      return "claude-haiku-4-5-20251001";
  }
}

export function sanitizeGeneratedTitle(raw: string): string {
  let title = raw.trim().toLowerCase().replace(/["""''`]/g, "");
  // Keep decimal points in model/version names like gpt-5.5, but strip other
  // periods so sentence punctuation does not end up in sidebar titles.
  title = title.replace(/\./g, (_dot, index) => {
    const previous = title[index - 1] ?? "";
    const next = title[index + 1] ?? "";
    return /\d/.test(previous) && /\d/.test(next) ? "." : "";
  });
  return title;
}

function getMarkPrefix(title: string): string | null {
  for (const emoji of MARK_EMOJI_SET) {
    if (title.startsWith(emoji + " ")) return emoji;
  }
  return null;
}

export function isPendingTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed === PENDING_TITLE) return true;
  const markPrefix = getMarkPrefix(trimmed);
  return markPrefix ? trimmed === `${markPrefix} ${PENDING_TITLE}` : false;
}

function pendingTitleFor(existingTitle: string): { pendingTitle: string; previousStableTitle: string; markPrefix: string | null } {
  const markPrefix = getMarkPrefix(existingTitle);
  const pendingTitle = markPrefix ? `${markPrefix} ${PENDING_TITLE}` : PENDING_TITLE;
  const previousStableTitle = existingTitle === pendingTitle ? (markPrefix ?? "") : existingTitle;
  return { pendingTitle, previousStableTitle, markPrefix };
}

function userTextFromContent(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content;
  const textParts: string[] = [];
  for (const block of content as ApiContentBlock[]) {
    if (block.type === "text" && block.text.trim()) textParts.push(block.text);
  }
  if (textParts.length > 0) return textParts.join("\n");
  return content.some((block) => block.type === "image") ? "[image]" : "";
}

/** Collect user messages into a single string, truncated to MAX_CONTEXT_CHARS. */
function extractUserContext(conv: Conversation): string {
  const parts: string[] = [];
  let total = 0;
  for (const msg of conv.messages) {
    if (msg.role !== "user" || isToolResultMessage(msg)) continue;
    const text = userTextFromContent(msg.content).trim();
    if (!text) continue;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    parts.push(text.slice(0, remaining));
    total += text.length;
  }
  return parts.join("\n\n");
}

function hasTitleContext(conv: Conversation): boolean {
  return conv.messages.some((msg) => msg.role === "user" && !isToolResultMessage(msg) && userTextFromContent(msg.content).trim().length > 0);
}

function broadcastTitle(server: DaemonServer, convId: string, title: string, reason: string): void {
  if (!convStore.rename(convId, title)) return;
  const summary = convStore.getSummary(convId);
  if (summary) server.broadcast({ type: "conversation_updated", summary });
  log("info", `titlegen: ${reason} for ${convId} -> "${title}"`);
}

/**
 * Start daemon-owned title generation. Returns false if there is nothing to do
 * or a generation job is already active for the conversation.
 */
export function startTitleGeneration(server: DaemonServer, convId: string, options: { force?: boolean } = {}): boolean {
  if (activeTitleJobs.has(convId)) return false;
  const conv = convStore.get(convId);
  if (!conv) return false;
  if (!options.force && conv.title.trim() && !isPendingTitle(conv.title)) return false;
  if (!hasTitleContext(conv)) return false;

  const existingTitle = conv.title ?? "";
  const { pendingTitle, previousStableTitle, markPrefix } = pendingTitleFor(existingTitle);
  const context = extractUserContext(conv);
  const prompt = `${INSTRUCTION}\n\nHere is the conversation to generate a title for:\n<prompt>\n${context}\n</prompt>`;

  activeTitleJobs.add(convId);
  broadcastTitle(server, convId, pendingTitle, "pending title");

  void complete("", prompt, {
    provider: conv.provider,
    model: titleModelForProvider(conv.provider),
    maxTokens: MAX_TOKENS,
    tracking: { source: "title_generation", conversationId: convId },
  })
    .then((result) => {
      let title = sanitizeGeneratedTitle(result.text);
      if (!title) title = previousStableTitle || pendingTitle;
      if (markPrefix && !title.startsWith(markPrefix + " ")) title = `${markPrefix} ${title}`;
      broadcastTitle(server, convId, title, "generated title");
      server.broadcast({ type: "token_stats", stats: getTokenStatsSnapshot() });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `titlegen: failed for ${convId}: ${message}`);
      broadcastTitle(server, convId, previousStableTitle, "reverted failed title");
      server.sendToSubscribers(convId, { type: "system_message", convId, text: `✗ Title generation failed: ${message}`, color: "error" });
    })
    .finally(() => {
      activeTitleJobs.delete(convId);
    });

  return true;
}

/** Retry persisted orphan pending titles after daemon startup. */
export function recoverPendingTitles(server: DaemonServer): void {
  for (const summary of convStore.listSummaries()) {
    if (isPendingTitle(summary.title)) {
      startTitleGeneration(server, summary.id, { force: true });
    }
  }
}
