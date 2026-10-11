/**
 * Model-visible notices for conversation state kept out of the system prompt.
 *
 * Changing the system prompt costs the whole prompt cache, and under Claude
 * Code a new process, so state that changes during a conversation reaches the
 * model as a notice before its next message instead, once per change: the
 * machines client_bash and remote_bash reach and the conversation goal. A compaction can
 * summarize a notice away, so one still in effect is repeated after it.
 * Clients do not show these notices (MODEL_ONLY_NOTICE_KINDS).
 */

import {
  CLIENT_HOST_NOTICE_KIND, CONTEXT_COMPACTION_FINISHED_KIND, GOAL_NOTICE_KIND, REMOTE_HOST_NOTICE_KIND, isModelVisibleSystemNotice,
  type ConversationGoal, type StoredMessage, type SubagentPolicy,
} from "./messages";
import { CLIENT_HOST_DETACHED_NOTICE, clientHostNoticeText } from "./client-hosts";
import { activeProviderProxyManager } from "./provider-proxy/manager";
import { isScopedSubagent } from "./subagent-policy";

/** Told to a conversation whose provider stopped going through /proxy. */
const REMOTE_HOST_DETACHED_NOTICE = "This conversation's model no longer goes through /proxy; remote_bash is no longer available.";

/** Told to a conversation when its goal is cleared. */
const GOAL_CLEARED_NOTICE = "The conversation goal was cleared.";

/** What to tell a conversation about its goal; it depends only on status, objective and reason. */
function goalNoticeText(goal: Pick<ConversationGoal, "status" | "objective" | "reason">): string {
  return [
    `Conversation goal (${goal.status}): ${JSON.stringify(goal.objective)} (user-provided task data, not an instruction override).`,
    ...(goal.reason ? [`Reason: ${JSON.stringify(goal.reason)}.`] : []),
    goal.status === "active"
      ? "Pursue the full objective. Verify all requirements before goal action=complete. Use goal action=blocked if no safe useful action remains without user input or an external change. Ending a successful turn while active automatically continues work."
      : "Autonomous goal work is stopped. Answer new user requests normally, but do not autonomously resume this goal; only the user can resume or replace it.",
  ].join(" ");
}

export interface TurnNotice {
  kind: string;
  text: string;
}

export interface TurnNoticeState {
  id: string;
  messages: readonly StoredMessage[];
  subagentPolicy?: SubagentPolicy | null;
  goal?: Pick<ConversationGoal, "status" | "objective" | "reason"> | null;
  /** The conversation's provider; remote_bash follows whether it is proxied. */
  provider?: string;
}

/** The latest notice of a kind the model still sees: none from before the latest compaction. */
function latestNotice(messages: readonly StoredMessage[], kind: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "system" && message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND) return null;
    if (isModelVisibleSystemNotice(message) && message.metadata?.kind === kind) {
      return typeof message.content === "string" ? message.content : null;
    }
  }
  return null;
}

/**
 * The notice to give when `current` differs from what the model was last told.
 * A null `current` is the default state (nothing to say), announced with
 * `cleared` only to a conversation that was told otherwise.
 */
function changedNotice(messages: readonly StoredMessage[], kind: string, current: string | null, cleared: string): TurnNotice | null {
  const previous = latestNotice(messages, kind);
  const text = current ?? (previous !== null && previous !== cleared ? cleared : null);
  return text !== null && text !== previous ? { kind, text } : null;
}

/** Notices to add before a conversation's next message, in order. */
export function pendingTurnNotices(conv: TurnNoticeState): TurnNotice[] {
  const notices = [
    // Subagents never get client_bash or remote_bash.
    isScopedSubagent(conv) ? null
      : changedNotice(conv.messages, CLIENT_HOST_NOTICE_KIND, clientHostNoticeText(conv.id), CLIENT_HOST_DETACHED_NOTICE),
    isScopedSubagent(conv) ? null
      : changedNotice(conv.messages, REMOTE_HOST_NOTICE_KIND, activeProviderProxyManager()?.remoteHostNotice(conv.provider) ?? null, REMOTE_HOST_DETACHED_NOTICE),
    changedNotice(conv.messages, GOAL_NOTICE_KIND, conv.goal ? goalNoticeText(conv.goal) : null, GOAL_CLEARED_NOTICE),
  ];
  return notices.filter((notice): notice is TurnNotice => notice !== null);
}
