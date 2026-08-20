import {
  DEFAULT_EFFORT,
  type Conversation,
} from "./messages";

/** Metadata that differs between a durable conversation and its clone. */
export interface ConversationCloneTarget {
  id: string;
  title: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Build the compatibility/JSON representation of a clone.
 *
 * Production SQLite performs the equivalent copy inside the database, but the
 * legacy backend still needs one canonical definition of clone semantics.
 */
export function clonedConversationValue(
  source: Conversation,
  target: ConversationCloneTarget,
): Conversation {
  const activeContext = source.activeContext
    ? {
        ...structuredClone(source.activeContext),
        windowId: `${target.id}:${source.activeContext.windowNumber}`,
      }
    : null;
  const messages = structuredClone(source.messages);

  if (source.activeContext && activeContext) {
    for (const message of [...messages, ...activeContext.messages]) {
      if (message.contextCheckpoint?.windowId === source.activeContext.windowId) {
        message.contextCheckpoint.windowId = activeContext.windowId;
      }
    }
  }

  return {
    id: target.id,
    provider: source.provider,
    model: source.model,
    effort: source.effort ?? DEFAULT_EFFORT,
    fastMode: source.fastMode ?? false,
    messages,
    activeContext,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
    lastContextTokens: source.lastContextTokens,
    marked: source.marked,
    pinned: source.pinned,
    muted: source.muted === true,
    sortOrder: target.sortOrder,
    folderId: source.folderId ?? null,
    title: target.title,
    toolPolicy: source.toolPolicy ? structuredClone(source.toolPolicy) : null,
  };
}
