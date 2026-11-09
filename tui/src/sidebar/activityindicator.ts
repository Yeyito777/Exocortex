import type { ConversationSummary } from "../messages";
import { isGlobalIdleQueuedMessage } from "../queue";
import type { RenderState } from "../state";
import { theme } from "../theme";
import { hasInProgressModelWork, inlineLongSleepStartedAt, isDurablySleeping } from "../taskvisibility";
import { areConversationNotificationsMuted } from "./folders";
import type { SidebarState } from "./state";

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

/** TUI-wide facts the sidebar's indicators read besides the conversation summaries. */
export interface SidebarActivityInputs {
  /** Conversations with a message queued for the global idle gate. */
  globalIdleConvIds: ReadonlySet<string>;
  /** The open conversation while local input awaits the daemon's streaming report. */
  optimisticStreamingConvId: string | null;
}

export function sidebarActivityInputs(
  state: Pick<RenderState, "queuedMessages" | "pendingAI" | "convId">,
): SidebarActivityInputs {
  return {
    globalIdleConvIds: new Set(state.queuedMessages.filter(isGlobalIdleQueuedMessage).map(message => message.convId)),
    optimisticStreamingConvId: state.pendingAI ? state.convId : null,
  };
}

/** The indicator context for one sidebar conversation row. */
export function sidebarConversationActivityContext(
  sidebar: SidebarState,
  conv: ConversationSummary,
  inputs: SidebarActivityInputs,
): ConversationActivityContext {
  return {
    globalIdle: inputs.globalIdleConvIds.has(conv.id),
    optimisticStreaming: conv.id === inputs.optimisticStreamingConvId,
    notificationsMuted: areConversationNotificationsMuted(sidebar, conv),
  };
}

export interface ConversationActivityIndicator {
  /** Glyph plus trailing space, or "" when the conversation is idle. */
  icon: string;
  /** Theme colour sequence for the glyph, or "" when idle. */
  color: string;
}

/** Which indicator a conversation shows; null when it shows none. */
export type ConversationActivityState = "streaming" | "warning" | "unread";

/**
 * The sidebar's per-conversation activity state: streaming (blue), suspended
 * in a long sleep or waiting on the global idle gate (yellow), or finished
 * and unread (green).
 */
export function conversationActivityState(
  conv: Pick<ConversationSummary, "streaming" | "tasks" | "unread" | "providerWaiting">,
  context: ConversationActivityContext,
): ConversationActivityState | null {
  // A Claude Code turn sleeping inside a long chrono call still streams, and
  // its pendingAI is that sleeping turn rather than an optimistic send.
  const hasInlineSleep = inlineLongSleepStartedAt(conv) !== null;
  const hasLongSleep = hasInlineSleep || isDurablySleeping(conv);
  const hasModelWork = hasInProgressModelWork(conv) || context.optimisticStreaming;
  const hasUnread = !context.notificationsMuted && conv.unread && !hasModelWork;
  const isStreaming = (conv.streaming || context.optimisticStreaming) && !hasInlineSleep && !conv.providerWaiting;
  const isWarning = hasLongSleep || context.globalIdle || conv.providerWaiting;
  return isStreaming ? "streaming" : isWarning ? "warning" : hasUnread ? "unread" : null;
}

/**
 * The sidebar's per-conversation activity indicator, coloured by
 * conversationActivityState. Shared with the Tasks panel so subagent rows match.
 */
export function conversationActivityIndicator(
  conv: Pick<ConversationSummary, "streaming" | "tasks" | "unread" | "providerWaiting">,
  context: ConversationActivityContext,
): ConversationActivityIndicator {
  const state = conversationActivityState(conv, context);
  if (!state) return { icon: "", color: "" };
  const color = state === "streaming" ? theme.accent : state === "warning" ? theme.warning : theme.success;
  return { icon: `${ACTIVITY_GLYPH} `, color };
}
