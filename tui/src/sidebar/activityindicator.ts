import type { ConversationSummary } from "../messages";
import { theme } from "../theme";
import { hasInProgressModelWork, inlineLongSleepStartedAt, isDurablySleeping } from "../taskvisibility";

/** The indicator glyph; its colour carries the state. */
export const ACTIVITY_GLYPH = "◉";

/** Per-conversation facts the indicator needs that the summary itself does not carry. */
export interface ConversationActivityContext {
  /** The conversation has a queued message waiting for the global idle gate. */
  globalIdle: boolean;
  /** Local input was accepted but the daemon has not reported streaming yet. */
  optimisticStreaming: boolean;
  /** Notifications are muted for the conversation, which hides unread. */
  notificationsMuted: boolean;
}

export interface ConversationActivityIndicator {
  /** Glyph plus trailing space, or "" when the conversation is idle. */
  icon: string;
  /** Theme colour sequence for the glyph, or "" when idle. */
  color: string;
}

/**
 * The sidebar's per-conversation activity indicator: blue while streaming,
 * yellow while suspended in a long sleep or waiting on the global idle gate,
 * green when unread. Shared with the Tasks panel so subagent rows match.
 */
export function conversationActivityIndicator(
  conv: Pick<ConversationSummary, "streaming" | "tasks" | "unread" | "providerWaiting">,
  context: ConversationActivityContext,
): ConversationActivityIndicator {
  // A Claude Code turn sleeping inside a long chrono call still streams, and
  // its pendingAI is that sleeping turn rather than an optimistic send.
  const hasInlineSleep = inlineLongSleepStartedAt(conv) !== null;
  const hasLongSleep = hasInlineSleep || isDurablySleeping(conv);
  const hasModelWork = hasInProgressModelWork(conv) || context.optimisticStreaming;
  const hasUnread = !context.notificationsMuted && conv.unread && !hasModelWork;
  const isStreaming = (conv.streaming || context.optimisticStreaming) && !hasInlineSleep && !conv.providerWaiting;
  const isWarning = hasLongSleep || context.globalIdle || conv.providerWaiting;
  const icon = isStreaming || isWarning || hasUnread ? `${ACTIVITY_GLYPH} ` : "";
  const color = isStreaming ? theme.accent : isWarning ? theme.warning : hasUnread ? theme.success : "";
  return { icon, color };
}
