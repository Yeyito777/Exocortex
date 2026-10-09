import { isTurnChronoSleep } from "@exocortex/shared/chrono";
import type { ConversationSummary, ConversationTaskSummary } from "./messages";

export { inlineLongSleepStartedAt } from "@exocortex/shared/chrono";

/** Whether a durable Chrono sleep or wait currently suspends a conversation. */
export function isDurablySleeping(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): boolean {
  return !conversation.streaming && conversation.tasks?.some(isTurnChronoSleep) === true;
}

/**
 * Whether a conversation still owns an active model turn.
 *
 * Long Chrono sleeps/waits deliberately close the provider websocket and suspend the
 * turn, so `streaming` becomes false even though the turn has not completed.
 * This remains useful for attention and activity navigation even though the
 * sidebar renders the suspended state differently from connected streaming.
 */
export function hasInProgressModelWork(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): boolean {
  return conversation.streaming || isDurablySleeping(conversation);
}

/**
 * Whether an active task should contribute to conversation activity UI.
 *
 * A Chrono `wait` is the current turn waiting on another task already shown in
 * the UI, so rendering both rows (and counting both badges) is redundant.
 */
export function shouldDisplayConversationTask(
  task: Pick<ConversationTaskSummary, "kind" | "chronoMode">,
): boolean {
  return task.kind !== "chrono" || task.chronoMode !== "wait";
}

/** Claude Code background tasks run by an agent rather than a command. */
const AGENT_BACKGROUND_TOOLS = new Set(["Agent", "Workflow"]);

/**
 * Whether background work is an agent, shown like an Exocortex subagent.
 *
 * Claude Code runs its subagents and workflows inside its own process, so the
 * daemon reports them as background tasks rather than child conversations.
 */
export function isAgentBackgroundTask(task: { kind: string; toolName?: string }): boolean {
  return task.kind === "background" && task.toolName !== undefined && AGENT_BACKGROUND_TOOLS.has(task.toolName);
}

/** Running subagents and background commands, counting Claude Code agents as subagents. */
export function conversationWorkCounts(
  conversation: Pick<ConversationSummary, "subagentCount" | "backgroundTaskCount" | "tasks">,
): { subagents: number; commands: number } {
  const agents = conversation.tasks?.filter(isAgentBackgroundTask).length ?? 0;
  const background = conversation.backgroundTaskCount ?? 0;
  return {
    subagents: (conversation.subagentCount ?? 0) + Math.min(agents, background),
    commands: Math.max(0, background - agents),
  };
}
