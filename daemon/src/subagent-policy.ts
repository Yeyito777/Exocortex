import { readExocortexConfig, type ExocortexConfig } from "@exocortex/shared/config";
import { MAX_EXO_SUBAGENT_DEPTH, type Conversation } from "./messages";
import type { BuildSystemPromptOptions } from "./system";

/** Top-level → child → grandchild. Configurable as `agent.maxSubagentDepth`. */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2;

export const SCOPED_SUBAGENT_IDENTITY = "You are a scoped subagent working for a parent agent.";

export const SCOPED_SUBAGENT_WRAPPER_NOTE = [
  "# Scoped subagent",
  "Do only the assigned task.",
  "Start with explicitly named files or symbols. Do not inventory repositories or broaden scope unless directly necessary. Use targeted tool calls and stop once you have enough evidence.",
  "Do not modify files or external state unless explicitly requested. If blocked, report the blocker instead of exploring indefinitely.",
  "Return only: conclusion, path:line evidence, and unresolved uncertainty.",
].join("\n");

/** Longest Tasks-panel label kept from a subagent's prompt; clients clip it further to fit. */
export const SUBAGENT_TASK_LABEL_MAX_CHARS = 200;

/** A subagent's Tasks-panel label: its prompt on one line, ellipsized past the cap. */
export function subagentTaskLabel(prompt: string): string {
  const chars = Array.from(prompt.replace(/\s+/g, " ").trim());
  if (chars.length <= SUBAGENT_TASK_LABEL_MAX_CHARS) return chars.join("");
  return `${chars.slice(0, SUBAGENT_TASK_LABEL_MAX_CHARS - 1).join("").trimEnd()}…`;
}

export function isScopedSubagent(conversation: Pick<Conversation, "subagentPolicy">): boolean {
  return conversation.subagentPolicy != null;
}

/** Deepest allowed subagent nesting, from 1 (children cannot delegate) to MAX_EXO_SUBAGENT_DEPTH. */
export function maxSubagentDepth(config: ExocortexConfig = readExocortexConfig()): number {
  const configured = config.agent?.maxSubagentDepth;
  return typeof configured === "number" && Number.isInteger(configured)
    ? Math.min(Math.max(configured, 1), MAX_EXO_SUBAGENT_DEPTH)
    : DEFAULT_MAX_SUBAGENT_DEPTH;
}

/** 0 for a top-level conversation, 1 for its child, 2 for a grandchild. */
export function subagentDepth(conversation: Pick<Conversation, "subagentPolicy">): number {
  const policy = conversation.subagentPolicy;
  if (!policy) return 0;
  // Records from before nesting were all direct children.
  return typeof policy.depth === "number" && Number.isInteger(policy.depth) && policy.depth >= 1 ? policy.depth : 1;
}

/**
 * Further nesting levels a subagent may start, or null for a top-level
 * conversation. Derived from the stored depth on every turn, so it holds
 * even when a user sends to the subagent directly.
 */
export function remainingSubagentDepth(
  conversation: Pick<Conversation, "subagentPolicy">,
  config?: ExocortexConfig,
): number | null {
  if (!isScopedSubagent(conversation)) return null;
  return Math.max(0, maxSubagentDepth(config) - subagentDepth(conversation));
}

/** Tells a subagent where it sits in the delegation chain and how far it may delegate. */
export function subagentDelegationNote(
  conversation: Pick<Conversation, "subagentPolicy">,
  config: ExocortexConfig = readExocortexConfig(),
): string {
  const depth = subagentDepth(conversation);
  const max = maxSubagentDepth(config);
  const parentId = conversation.subagentPolicy?.parentConversationId;
  const position = `You are already a subagent, at depth ${depth} of ${max}${parentId ? ` (parent conversation ${parentId})` : ""}.`;
  const reporting = parentId
    ? `Whenever your turn ends, whatever woke you, your final reply reaches your parent as a notice. To tell it something mid-task (a question, or something it must do now), use exo message with conversation ${parentId}; that requests no reply, so don't repeat your final report there.`
    : "";
  if (depth >= max) {
    return [`## Delegation\n${position} You cannot start subagents of your own: exo refuses them at this depth. Do the work yourself.`, reporting]
      .filter(Boolean).join("\n");
  }
  const remaining = max - depth;
  return [
    "## Delegation",
    `${position} You may start subagents with exo, ${remaining === 1 ? "and they cannot delegate further" : `up to ${remaining} more levels deep`}.`,
    "Delegate only clearly separable work that would take hours; do everything else yourself. Never hand off your whole task, never delegate a task back to your parent or anyone above it, and never start a subagent only to have it start another.",
    "Your subagents report to you, not to the top-level conversation. Before ending your turn, wait for each one (chrono wait with task_id set to its conversation id) and include its results in your own report.",
    reporting,
  ].filter(Boolean).join("\n");
}

type ScopedPromptOptions = Pick<BuildSystemPromptOptions,
  "identity" | "wrapperNote"
>;

/** Subagents inherit constraints, not a restricted tool projection. */
export function scopedSubagentPromptOptions(
  conversation: Pick<Conversation, "subagentPolicy">,
  _maxDepth: number | null,
): ScopedPromptOptions | null {
  if (!isScopedSubagent(conversation)) return null;
  return {
    identity: SCOPED_SUBAGENT_IDENTITY,
    wrapperNote: `${SCOPED_SUBAGENT_WRAPPER_NOTE}\n\n${subagentDelegationNote(conversation)}`,
  };
}
