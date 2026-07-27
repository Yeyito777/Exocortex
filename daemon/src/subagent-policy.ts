import type { Conversation } from "./messages";
import type { BuildSystemPromptOptions } from "./system";

export const SCOPED_SUBAGENT_IDENTITY = "You are a scoped subagent working for a parent agent.";

export const SCOPED_SUBAGENT_WRAPPER_NOTE = [
  "# Scoped subagent",
  "Do only the assigned task.",
  "Start with explicitly named files or symbols. Do not inventory repositories or broaden scope unless directly necessary. Use targeted tool calls and stop once you have enough evidence.",
  "Do not modify files or external state unless explicitly requested. If blocked, report the blocker instead of exploring indefinitely.",
  "Return only: conclusion, path:line evidence, and unresolved uncertainty.",
].join("\n");

const BASE_SUBAGENT_TOOLS = ["read", "glob", "grep", "browse"] as const;
const SUBAGENT_EDIT_TOOLS = ["bash", "write", "edit", "patch", "chrono"] as const;

/** Tool capabilities are daemon-owned; callers can opt into mutation tools but not external hints. */
export function subagentToolNames(maxDepth: number | null, allowEdits: boolean): string[] {
  return [
    ...BASE_SUBAGENT_TOOLS,
    ...(allowEdits ? SUBAGENT_EDIT_TOOLS : []),
    ...(typeof maxDepth === "number" && maxDepth > 0 ? ["exo"] : []),
  ];
}

export function isScopedSubagent(conversation: Pick<Conversation, "subagentPolicy">): boolean {
  return conversation.subagentPolicy != null;
}

type ScopedPromptOptions = Pick<BuildSystemPromptOptions,
  "identity" | "wrapperNote" | "toolNames" | "includeExternalToolHints"
>;

/** Return the immutable prompt restrictions for a scoped worker, or null for a normal conversation. */
export function scopedSubagentPromptOptions(
  conversation: Pick<Conversation, "subagentPolicy">,
  maxDepth: number | null,
): ScopedPromptOptions | null {
  if (!isScopedSubagent(conversation)) return null;
  return {
    identity: SCOPED_SUBAGENT_IDENTITY,
    wrapperNote: SCOPED_SUBAGENT_WRAPPER_NOTE,
    toolNames: subagentToolNames(maxDepth, conversation.subagentPolicy?.allowEdits === true),
    includeExternalToolHints: false,
  };
}
