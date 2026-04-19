import { clearPrompt } from "../promptstate";
import { isStreaming, pushSystemMessage } from "../state";
import type { TrimMode } from "../protocol";
import { parsePositiveInt, trimHelpText } from "./shared";
import type { CompletionItem, SlashCommand } from "./types";

export const TRIM_MODE_ITEMS: CompletionItem[] = [
  { name: "messages", desc: "Trim oldest history entries first" },
  { name: "thinking", desc: "Strip oldest assistant thinking blocks first" },
  { name: "toolresults", desc: "Strip oldest tool result payloads first" },
];

function parseTrimMode(raw: string | undefined): TrimMode | null {
  const value = raw?.toLowerCase();
  return value === "messages" || value === "thinking" || value === "toolresults"
    ? value
    : null;
}

export const TRIM_COMMAND: SlashCommand = {
  name: "/trim",
  description: "Trim old context from the current conversation",
  args: TRIM_MODE_ITEMS,
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      pushSystemMessage(state, trimHelpText(state));
      clearPrompt(state);
      return { type: "handled" };
    }

    const mode = parseTrimMode(parts[1]);
    if (!mode) {
      pushSystemMessage(state, `${trimHelpText(state)}\n\nUnknown trim mode: ${parts[1] ?? ""}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (parts.length !== 3) {
      pushSystemMessage(state, trimHelpText(state));
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!state.convId) {
      pushSystemMessage(state, "No active conversation to trim.");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (isStreaming(state)) {
      pushSystemMessage(state, "Cannot trim the conversation while it is streaming.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const count = parsePositiveInt(parts[2]);
    if (count == null) {
      pushSystemMessage(state, `Trim count must be a positive integer.\n\n${trimHelpText(state)}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return { type: "trim_requested", mode, count };
  },
};
