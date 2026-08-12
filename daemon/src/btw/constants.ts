/** The only advertised source-conversation tools that a BTW executor may run. */
export const BTW_READ_ONLY_TOOLS = ["read", "grep", "glob", "browse"] as const;

export function appendBtwQueryInstructions(
  query: string,
  advertisedToolNames: readonly string[],
): string {
  const permitted = new Set<string>(BTW_READ_ONLY_TOOLS);
  const readOnly = advertisedToolNames.filter(name => permitted.has(name));
  const disabled = advertisedToolNames.filter(name => !permitted.has(name));
  return [
    query,
    "",
    "[BTW aside]",
    "Answer the question above as a one-shot aside that is not part of the conversation transcript.",
    disabled.length > 0
      ? `Do not call these advertised tools because their executors are disabled for this aside: ${disabled.join(", ")}.`
      : "Do not attempt to modify files, processes, conversations, schedules, or external state.",
    readOnly.length > 0
      ? `Only these read-only tools may run if needed: ${readOnly.join(", ")}.`
      : "No tools may run for this aside.",
    "Answer directly and do not ask a follow-up question.",
  ].join("\n");
}

export const BTW_PERSIST_DEBOUNCE_MS = 100;
export const BTW_PERSIST_RETRY_MS = 250;
export const BTW_RESTART_ERROR = "Interrupted by daemon restart.";
