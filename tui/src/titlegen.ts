/**
 * Auto-generate conversation titles via Haiku.
 *
 * Collects all user messages from the conversation and sends them
 * to the daemon's llm_complete endpoint so the title reflects the
 * full scope of the conversation. Called when `/rename` is used
 * with no arguments — can be re-run when the topic shifts.
 */

import type { DaemonClient } from "./client";
import type { RenderState } from "./state";
import { getMarkPrefix } from "./marks";

// ── Prompt ─────────────────────────────────────────────────────────

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

function titleModelForProvider(provider: RenderState["provider"]): string {
  switch (provider) {
    case "openai":
      return "gpt-5.4-mini";
    case "anthropic":
    default:
      return "claude-haiku-4-5-20251001";
  }
}

// ── Helpers ────────────────────────────────────────────────────────

/** Collect user messages into a single string, truncated to MAX_CONTEXT_CHARS. */
function extractUserContext(state: RenderState): string {
  const parts: string[] = [];
  let total = 0;
  for (const msg of state.messages) {
    if (msg.role !== "user" || !("text" in msg)) continue;
    const text = msg.text;
    const remaining = MAX_CONTEXT_CHARS - total;
    if (remaining <= 0) break;
    parts.push(text.slice(0, remaining));
    total += text.length;
  }
  return parts.join("\n\n");
}

// ── Title state helpers ────────────────────────────────────────────

function pendingTitleFor(existingTitle: string): { pendingTitle: string; previousStableTitle: string } {
  const markPrefix = getMarkPrefix(existingTitle);
  const pendingTitle = markPrefix ? `${markPrefix} ${PENDING_TITLE}` : PENDING_TITLE;
  const previousStableTitle = existingTitle === pendingTitle ? (markPrefix ?? "") : existingTitle;
  return { pendingTitle, previousStableTitle };
}

function setCanonicalTitle(
  convId: string,
  title: string,
  state: RenderState,
  daemon: DaemonClient,
  scheduleRender: () => void,
): void {
  const conv = state.sidebar.conversations.find((candidate) => candidate.id === convId);
  if (conv) conv.title = title;
  daemon.renameConversation(convId, title);
  scheduleRender();
}

// ── Public API ─────────────────────────────────────────────────────

export function generateTitle(
  convId: string,
  state: RenderState,
  daemon: DaemonClient,
  scheduleRender: () => void,
): void {
  const context = extractUserContext(state);
  const prompt = `${INSTRUCTION}\n\nHere is the conversation to generate a title for:\n<prompt>\n${context}\n</prompt>`;

  // Preserve any emoji mark prefix across title regeneration.
  const existingTitle = state.sidebar.conversations.find(c => c.id === convId)?.title ?? "";
  const markPrefix = getMarkPrefix(existingTitle);
  const { pendingTitle, previousStableTitle } = pendingTitleFor(existingTitle);

  // Make the pending title canonical immediately so daemon-driven sidebar
  // updates don't clobber the optimistic local state while generation runs.
  setCanonicalTitle(convId, pendingTitle, state, daemon, scheduleRender);

  daemon.llmComplete(
    "",
    prompt,
    (generatedTitle) => {
      let title = generatedTitle.trim().toLowerCase().replace(/["""''`.]/g, "");
      if (markPrefix) title = markPrefix + " " + title;
      setCanonicalTitle(convId, title, state, daemon, scheduleRender);
    },
    (error) => {
      // Revert from pending to the last stable title (or empty for a brand-new
      // conversation) so the UI doesn't get stuck showing a perpetual pending state.
      setCanonicalTitle(convId, previousStableTitle, state, daemon, scheduleRender);
      state.messages.push({ role: "system", text: `✗ Title generation failed: ${error}`, metadata: null });
    },
    state.provider,
    titleModelForProvider(state.provider),
    MAX_TOKENS,
  );
}
