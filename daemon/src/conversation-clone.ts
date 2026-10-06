import { createHash } from "node:crypto";
import {
  DEFAULT_EFFORT,
  CONTEXT_COMPACTION_FINISHED_KIND,
  historyPrefixHash,
  isReplayHistoryMessage,
  validatedActiveContextCompactionHistoryCount,
  type Conversation,
} from "./messages";
import { archiveWindow, systemInstructionMessages } from "./conversation-window";
import { updateCheckpointTailHash } from "./checkpoint-tail-integrity";

/** Metadata that differs between a durable conversation and its clone. */
export interface ConversationCloneTarget {
  id: string;
  title: string;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Build a standalone copy for either repository.
 *
 * Keep only the latest checkpoint and its editable canonical tail. SQLite
 * supplies a verified sparse window, so this never walks the superseded archive.
 * Conversations without a checkpoint retain their complete history.
 */
export function clonedConversationValue(
  source: Conversation,
  target: ConversationCloneTarget,
): Conversation {
  const boundary = source.activeContext
    ? validatedActiveContextCompactionHistoryCount(source.activeContext, source.messages)
    : 0;
  if (boundary === null) throw new Error("Cannot copy an invalid compaction checkpoint");
  if (!source.activeContext && source.messages.some(message => message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND)) {
    throw new Error("Cannot copy a missing compaction checkpoint");
  }
  const window = archiveWindow(source.messages);
  if (!source.activeContext && window && window.prefixSequence > 0) throw new Error("Cannot copy a missing compaction checkpoint");
  let historyCount = window?.sparse ? window.prefixHistoryCount : 0;
  if (historyCount > boundary) throw new Error("Compaction tail is missing");
  let start = 0;
  while (historyCount < boundary && start < source.messages.length) {
    if (isReplayHistoryMessage(source.messages[start])) historyCount++;
    start++;
  }
  const tail = source.messages.slice(start);
  const retained = new Set(tail);
  const messages = structuredClone([
    // Instruction snapshots before the cut still apply to the new conversation.
    ...systemInstructionMessages(source.messages).filter(message =>
      !retained.has(message)),
    ...tail,
  ]);
  const activeContext = source.activeContext
    ? {
        ...structuredClone(source.activeContext),
        windowId: `${target.id}:${source.activeContext.windowNumber}`,
        transcriptHistoryCount: source.activeContext.transcriptHistoryCount - boundary,
        compactionHistoryCount: 0,
        compactionPrefixHash: historyPrefixHash([], 0),
      }
    : null;

  if (source.activeContext && activeContext) {
    // These are now independent canonical rows, not references to the source's
    // absolute archive offsets. Preserve legacy replay cursors within the tail.
    delete activeContext.historyHashMode;
    activeContext.transcriptPrefixHash = historyPrefixHash(messages, activeContext.transcriptHistoryCount);
    let count = 0;
    const hash = createHash("sha256");
    for (const message of messages) {
      if (message.contextCheckpoint) {
        if (message.contextCheckpoint.windowId === source.activeContext.windowId) {
          message.contextCheckpoint.windowId = activeContext.windowId;
          message.contextCheckpoint.transcriptHistoryCount = count;
          message.contextCheckpoint.transcriptPrefixHash = hash.copy().digest("hex").slice(0, 24);
        } else {
          delete message.contextCheckpoint;
        }
      }
      if (isReplayHistoryMessage(message)) {
        count++;
        updateCheckpointTailHash(hash, message);
      }
    }
    // Provider replay is opaque working context, not editable transcript. Do
    // not retain source-relative rewind cursors in it.
    for (const message of activeContext.messages) delete message.contextCheckpoint;
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
    toolPolicy: source.toolPolicy == null ? null : structuredClone(source.toolPolicy),
  };
}
