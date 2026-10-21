/**
 * Experimental next-message suggestions (`experimental.nextMessageSuggestions`).
 *
 * When a top-level conversation's turn ends cleanly while a client is
 * watching, the provider's cheap title model predicts the user's next message
 * from the recent transcript. Subscribers receive it as
 * `next_message_suggestion`; the TUI shows it as ghost text in the empty
 * prompt. Generation is fire-and-forget: it never delays the turn, the prompt
 * or a following turn, which cancels it.
 */

import { log } from "./log";
import { complete } from "./llm";
import * as convStore from "./conversations";
import { experimentalFeatures } from "./experimental";
import { isRealUserMessage, type Conversation, type StoredMessage } from "./messages";
import { normalizeEffort } from "./providers/registry";
import type { ConnectedClient, DaemonServer } from "./server";
import { isScopedSubagent } from "./subagent-policy";
import { titleModelForProvider } from "./titlegen";

const SYSTEM = `You predict the next message a user will send to their AI assistant. You see the end of their conversation.

Write the message THEY would most likely type next, in their own voice: match their language, casing, punctuation and usual length. The test: would they think "I was just about to type that"?

Examples:
- They asked to fix a bug and run the tests; the fix is done -> "run the tests"
- The assistant offers options -> the option they would likely pick
- The assistant asks whether to go ahead -> "yes" or "go ahead"
- The task is done and the follow-up is obvious -> "commit and push it"

Never write: thanks or praise ("looks good"), the assistant's voice ("Let me...", "I'll..."), new ideas they did not ask about, or more than one sentence.
If the next step is not obvious, or the last reply shows an error or a misunderstanding, output exactly NONE.
Output only the message (2 to 15 words) with no quotes or explanation, or NONE.`;

const MAX_CONTEXT_CHARS = 8000;
const MAX_ENTRY_CHARS = 1500;
const MAX_LAST_REPLY_CHARS = 3000;
const MAX_ENTRIES = 12;
const MAX_SUGGESTION_CHARS = 160;
const MAX_REMEMBERED = 100;

interface StoredSuggestion {
  text: string;
  /** conv.messages.length the suggestion was made for. */
  messageCount: number;
}

const suggestions = new Map<string, StoredSuggestion>();
const inFlight = new Map<string, AbortController>();
let completeFn: typeof complete = complete;

function enabled(): boolean {
  return experimentalFeatures().nextMessageSuggestions === true;
}

function messageText(message: StoredMessage): string {
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

function isHumanMessage(message: StoredMessage): boolean {
  return isRealUserMessage(message) && !message.metadata?.automation && !message.metadata?.subagentNotificationId;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Replies end with what they ask or offer, so keep their tail.
  const head = Math.floor(max / 4);
  return `${text.slice(0, head)}\n[...]\n${text.slice(text.length - (max - head))}`;
}

/** The recent transcript as USER/ASSISTANT/NOTICE lines, or null when there is nothing to predict from. */
export function suggestionContext(conv: Pick<Conversation, "messages">): string | null {
  const entries: string[] = [];
  let used = 0;
  let sawHuman = false;
  let endsWithReply = false;
  for (let i = conv.messages.length - 1; i >= 0 && entries.length < MAX_ENTRIES && used < MAX_CONTEXT_CHARS; i--) {
    const message = conv.messages[i];
    let label: string;
    if (message.role === "assistant") label = "ASSISTANT";
    else if (isHumanMessage(message)) label = "USER";
    else if (isRealUserMessage(message)) label = "NOTICE";
    else continue;
    const text = messageText(message);
    if (!text) continue;
    if (entries.length === 0) {
      if (label !== "ASSISTANT") return null;
      endsWithReply = true;
    }
    const entry = `${label}: ${clip(text, entries.length === 0 ? MAX_LAST_REPLY_CHARS : MAX_ENTRY_CHARS)}`;
    entries.unshift(entry.slice(0, MAX_CONTEXT_CHARS - used));
    used += entry.length;
    if (label === "USER") sawHuman = true;
  }
  if (!endsWithReply || !sawHuman) return null;
  return `<conversation>\n${entries.join("\n\n")}\n</conversation>\n\nPredict the user's next message.`;
}

/** Clean a model reply into a suggestion, or null when it should not be shown. */
export function sanitizeSuggestion(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^(?:suggestion|user|next message)\s*:\s*/i, "").trim();
  text = text.replace(/^(["'`“‘])(.*)(["'`”’])$/s, "$2").trim();
  if (!text || text.includes("\n") || text.length > MAX_SUGGESTION_CHARS) return null;
  if (/^(?:none|nothing|silence|no suggestion|n\/a)\b[.!]*$/i.test(text)) return null;
  if (/^(?:let me|i'll|i will|i've|here's|here is)\b/i.test(text)) return null;
  if (/^(?:thanks|thank you|ty|looks good|lgtm|great|perfect|nice|awesome|cool)[.!]*$/i.test(text)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  return text;
}

function remember(convId: string, suggestion: StoredSuggestion): void {
  suggestions.delete(convId);
  suggestions.set(convId, suggestion);
  while (suggestions.size > MAX_REMEMBERED) {
    const oldest = suggestions.keys().next().value;
    if (oldest === undefined) break;
    suggestions.delete(oldest);
  }
}

/** A new turn makes any suggestion stale: cancel generation and tell watchers. */
export function clearNextMessageSuggestion(server: DaemonServer, convId: string): void {
  inFlight.get(convId)?.abort();
  inFlight.delete(convId);
  if (suggestions.delete(convId)) {
    server.sendToSubscribers(convId, { type: "next_message_suggestion", convId, text: null });
  }
}

/** Tell a client that just opened a conversation its current suggestion (or that there is none). */
export function sendNextMessageSuggestion(server: DaemonServer, client: ConnectedClient, convId: string): void {
  if (!enabled()) return;
  const stored = suggestions.get(convId);
  const conv = convStore.getCached(convId);
  const current = stored && (!conv || conv.messages.length === stored.messageCount) && !convStore.isStreaming(convId);
  server.sendTo(client, { type: "next_message_suggestion", convId, text: current ? stored.text : null });
}

/** Predict the user's next message after a clean turn end. Never throws. */
export function startNextMessageSuggestion(server: DaemonServer, convId: string): void {
  if (!enabled()) return;
  const conv = convStore.getCached(convId);
  if (!conv || isScopedSubagent(conv) || !server.hasSubscribers(convId)) return;
  const context = suggestionContext(conv);
  if (!context) return;

  inFlight.get(convId)?.abort();
  const ac = new AbortController();
  inFlight.set(convId, ac);
  const messageCount = conv.messages.length;
  const provider = conv.provider;
  const model = titleModelForProvider(provider);
  const startedAt = Date.now();

  void completeFn(SYSTEM, context, {
    provider,
    model,
    effort: normalizeEffort(provider, model, "none"),
    maxTokens: 1024,
    signal: ac.signal,
    tracking: { source: "next_message_suggestion", conversationId: convId },
  })
    .then(result => {
      if (inFlight.get(convId) !== ac || ac.signal.aborted) return;
      const latest = convStore.getCached(convId);
      if (!latest || latest.messages.length !== messageCount || convStore.isStreaming(convId)) return;
      const text = sanitizeSuggestion(result.text);
      log("info", `next-message: ${text ? "suggested" : "no suggestion"} for ${convId} in ${Date.now() - startedAt}ms (model=${model}, in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"})`);
      if (!text) return;
      remember(convId, { text, messageCount });
      server.sendToSubscribers(convId, { type: "next_message_suggestion", convId, text });
    })
    .catch(error => {
      if (ac.signal.aborted) return;
      log("warn", `next-message: failed for ${convId}: ${error instanceof Error ? error.message : String(error)}`);
    })
    .finally(() => {
      if (inFlight.get(convId) === ac) inFlight.delete(convId);
    });
}

/** Tests: forget all suggestions, cancel generation, and stub the model call. */
export function resetNextMessageSuggestionsForTest(stub: typeof complete = complete): void {
  for (const ac of inFlight.values()) ac.abort();
  inFlight.clear();
  suggestions.clear();
  completeFn = stub;
}
