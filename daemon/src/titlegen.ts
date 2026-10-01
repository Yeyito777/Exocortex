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
import type { ProviderId } from "./messages";
import { getTokenStatsSnapshot } from "./token-stats";
import { broadcastConversationUpdated } from "./conversation-events";
import { titleContext } from "./conversation-title-context";

const INSTRUCTION = `You generate short conversation titles. Output ONLY the title — 3 to 4 lowercase words, no quotes, no punctuation, no explanation. Match this naming style:
exo bash truncate, exo code qa, berlin airbnb, tokens bug, context tool, unbricking convo, merging img pasting, netherlands trains, exo vim linewrapping, exo msg queuing, fixing message queuing, airpods pro autoconnect, discord streaming, context management`;

// Must exceed the thinking budget (10000) configured in api.ts for
// non-adaptive models — otherwise all tokens go to thinking and the
// text response is empty.
const MAX_TOKENS = 10200;

/** Placeholder title shown while generation is in-flight. */
export const PENDING_TITLE = "pending";

const MARK_EMOJI_SET = new Set(["🕐", "🔥", "🧪", "📝", "🐛", "💡", "🔒", "✅", "📡"]);
const activeTitleJobs = new Set<string>();

export function titleModelForProvider(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      // Use the latest lightweight Luna tier for ChatGPT/Codex accounts.
      // GPT-5.4 mini is rejected by that endpoint, even if listed locally.
      return "gpt-6-luna";
    case "deepseek":
      return "deepseek-v4-flash";
    case "opencode":
      return "ox-alpha";
    case "openrouter":
      return "nousresearch/hermes-4-70b";
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

function broadcastTitle(server: DaemonServer, convId: string, title: string, reason: string): void {
  if (!convStore.rename(convId, title, false)) return;
  broadcastConversationUpdated(server, convId);
  log("info", `titlegen: ${reason} for ${convId} -> "${title}"`);
}

/**
 * Start daemon-owned title generation. Returns false if there is nothing to do
 * or a generation job is already active for the conversation.
 */
export function startTitleGeneration(server: DaemonServer, convId: string, options: { force?: boolean; extraContext?: string } = {}): boolean {
  if (activeTitleJobs.has(convId)) return false;
  const conv = convStore.getCached(convId);
  if (!conv) {
    const summary = convStore.getIndexedSummary(convId);
    if (!summary || (!options.force && summary.title.trim() && !isPendingTitle(summary.title))) return false;
    activeTitleJobs.add(convId);
    void convStore.getAsync(convId).then(loaded => {
      activeTitleJobs.delete(convId);
      if (loaded) startTitleGeneration(server, convId, options);
    }).catch(error => {
      activeTitleJobs.delete(convId);
      log("error", `titlegen: could not load ${convId}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
  }
  if (!options.force && conv.title.trim() && !isPendingTitle(conv.title)) return false;
  const context = titleContext(conv, options.extraContext);
  if (!context) return false;

  const existingTitle = conv.title ?? "";
  const { pendingTitle, previousStableTitle, markPrefix } = pendingTitleFor(existingTitle);
  const prompt = `${INSTRUCTION}\n\nHere is the conversation to generate a title for:\n<prompt>\n${context}\n</prompt>`;

  activeTitleJobs.add(convId);
  const releaseCache = convStore.pinConversationCache(convId);
  if (existingTitle !== pendingTitle) {
    broadcastTitle(server, convId, pendingTitle, "pending title");
  }

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
    })
    .finally(() => {
      activeTitleJobs.delete(convId);
      releaseCache();
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
