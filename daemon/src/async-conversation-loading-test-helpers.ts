/** Fixtures shared by the async-conversation-loading*.cases.ts files. */
import * as convStore from "./conversations";
import { conversationLoaderIdleForTest, stopConversationLoader } from "./conversation-loader";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, createStoredUserContextCheckpoint, currentReplayHistoryPrefix } from "./messages";
import { orchestrateSendMessage } from "./orchestrator";
import type { streamMessage } from "./api";

export const ids: string[] = [];
export function seed() {
  const id = `async-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  const conv = convStore.create(id, "openai", "gpt-6.1-sol", "worker fixture");
  conv.messages.push({
    role: "user", content: "archived original task",
    metadata: { startedAt: 1, endedAt: 1, model: conv.model, tokens: 0, queueEntryId: "archived-queue" },
  });
  for (let i = 0; i < 64; i++) conv.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: `old-${i}`, name: "exec_command", input: {} }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `old-${i}`, content: "x".repeat(16_384) }], metadata: null },
  );
  const prefix = currentReplayHistoryPrefix(conv.messages);
  conv.activeContext = {
    version: 1, kind: "openai_native", provider: "openai", model: conv.model,
    messages: [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "old-opaque" }] } } }],
    transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
    compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
    windowId: `${id}:1`, windowNumber: 1, compactedAt: 123, compactionCount: 1,
  };
  conv.messages.push({
    role: "system", content: CONTEXT_COMPACTION_FINISHED_TEXT,
    metadata: { startedAt: 123, endedAt: 123, model: conv.model, tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  });
  const checkpoint = createStoredUserContextCheckpoint(conv);
  conv.messages.push({ role: "user", content: "editable recent task", metadata: null, contextCheckpoint: checkpoint });
  conv.messages.push({ role: "assistant", content: "recent answer", metadata: null });
  convStore.markDirty(id, "messages");
  convStore.flush(id);
  convStore.conversationCacheInternalsForTest.evictClean();
  return id;
}

export function server() {
  return {
    sendTo() {}, broadcast() {}, sendToSubscribers() {}, sendToSubscribersExcept() {},
    hasSubscribers: () => false, hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers() {},
  };
}
export function response(text: string) {
  return { text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [], inputTokens: 20, outputTokens: 3 };
}
export function callbacks(fn: typeof streamMessage) { return { onHeaders() {}, onComplete() {}, streamMessageFn: fn }; }
export function send(id: string, text: string, fn: typeof streamMessage = async () => response("answer")) {
  return orchestrateSendMessage(server() as never, null, undefined, id, text, Date.now(), callbacks(fn));
}
/**
 * Run after each case: drops this case's conversations. Stops the loader
 * workers only when work is still outstanding: starting them again costs
 * ~0.1 s of CPU each, most of these files' time.
 */
export function cleanupAsyncLoadingCase(): void {
  if (!conversationLoaderIdleForTest()) stopConversationLoader();
  for (const id of ids.splice(0)) {
    convStore.clearStreamHandoff(id);
    convStore.clearHistoryUnwindPending(id);
    convStore.remove(id);
  }
}
