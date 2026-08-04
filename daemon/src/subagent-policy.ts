import type { Conversation } from "./messages";
import type { BuildSystemPromptOptions } from "./system";
import { getDefaultSubagentInternalToolNames, resolveConversationToolPolicy } from "./tool-policy";

export const SCOPED_SUBAGENT_IDENTITY = "You are a scoped subagent working for a parent agent.";

export const SCOPED_SUBAGENT_WRAPPER_NOTE = [
  "# Scoped subagent",
  "Do only the assigned task.",
  "Start with explicitly named files or symbols. Do not inventory repositories or broaden scope unless directly necessary. Use targeted tool calls and stop once you have enough evidence.",
  "Do not modify files or external state unless explicitly requested. If blocked, report the blocker instead of exploring indefinitely.",
  "Return only: conclusion, path:line evidence, and unresolved uncertainty.",
].join("\n");

/** Backward-compatible projection for callers/tests that have not selected exact tools. */
export function subagentToolNames(maxDepth: number | null, allowEdits: boolean): string[] {
  return getDefaultSubagentInternalToolNames(maxDepth, allowEdits);
}

export function isScopedSubagent(conversation: Pick<Conversation, "subagentPolicy">): boolean {
  return conversation.subagentPolicy != null;
}

type ScopedPromptOptions = Pick<BuildSystemPromptOptions,
  "identity" | "wrapperNote" | "toolNames" | "includeExternalToolHints" | "externalToolNames"
>;

/** Return the scoped identity/wrapper plus this turn's resolved tool projection. */
export function scopedSubagentPromptOptions(
  conversation: Pick<Conversation, "subagentPolicy" | "toolPolicy">,
  maxDepth: number | null,
): ScopedPromptOptions | null {
  if (!isScopedSubagent(conversation)) return null;
  const resolved = resolveConversationToolPolicy({
    ...conversation,
    subagentMaxDepth: maxDepth,
    toolPolicy: conversation.toolPolicy ?? null,
  }, maxDepth);
  return {
    identity: SCOPED_SUBAGENT_IDENTITY,
    wrapperNote: SCOPED_SUBAGENT_WRAPPER_NOTE,
    toolNames: resolved.internalToolNames,
    includeExternalToolHints: true,
    externalToolNames: resolved.externalToolNames,
  };
}
