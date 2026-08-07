/** Tools exposed to the isolated one-shot agent. Keep this list read-only. */
export const BTW_READ_ONLY_TOOLS = ["read", "grep", "glob", "browse"] as const;

export const BTW_WRAPPER_NOTE = [
  "# BTW session",
  "You are answering a one-shot question against a frozen snapshot of an existing conversation.",
  "Answer the user's BTW query directly and do not ask follow-up questions.",
  "This answer is displayed in a conversation-owned panel and is not part of the model-visible transcript.",
  "You have read-only tools only. Do not attempt or claim to modify files, processes, conversations, schedules, or external state.",
].join("\n");

export const BTW_PERSIST_DEBOUNCE_MS = 100;
export const BTW_PERSIST_RETRY_MS = 250;
export const BTW_RESTART_ERROR = "Interrupted by daemon restart.";
