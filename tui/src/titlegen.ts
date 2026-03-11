/**
 * Auto-generate conversation titles via Haiku.
 *
 * Extracts the first user message, sends it to the daemon's
 * llm_complete endpoint, and renames the conversation with
 * the result. Called when `/rename` is used with no arguments.
 */

import type { DaemonClient } from "./client";
import type { RenderState } from "./state";

// ── Prompt ─────────────────────────────────────────────────────────

const SYSTEM = `You generate short conversation titles. Output ONLY the title — 3 to 4 lowercase words, no quotes, no punctuation, no explanation. Match this naming style:
exo bash truncate, exo code qa, berlin airbnb, tokens bug, context tool, unbricking convo, merging img pasting, netherlands trains, exo vim linewrapping, exo msg queuing, fixing message queuing, airpods pro autoconnect, discord streaming, context management`;

// Must exceed the thinking budget (10000) configured in api.ts for
// non-adaptive models — otherwise all tokens go to thinking and the
// text response is empty.
const MAX_TOKENS = 10200;

// ── Public API ─────────────────────────────────────────────────────

export function generateTitle(
  convId: string,
  state: RenderState,
  daemon: DaemonClient,
  scheduleRender: () => void,
): void {
  const firstUser = state.messages.find(m => m.role === "user");
  const prompt = firstUser && "text" in firstUser ? firstUser.text.slice(0, 500) : "";

  daemon.llmComplete(
    SYSTEM,
    prompt,
    (generatedTitle) => {
      const title = generatedTitle.trim().toLowerCase().replace(/["""''`.]/g, "");
      daemon.renameConversation(convId, title);
      const conv = state.sidebar.conversations.find(c => c.id === convId);
      if (conv) conv.title = title;
      scheduleRender();
    },
    (error) => {
      // Revert "(pending)" — clear the title so the sidebar falls back to preview
      const conv = state.sidebar.conversations.find(c => c.id === convId);
      if (conv) conv.title = null;
      state.messages.push({ role: "system", text: `✗ Title generation failed: ${error}`, metadata: null });
      scheduleRender();
    },
    "haiku",
    MAX_TOKENS,
  );
}
