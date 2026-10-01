import { afterEach, expect, test } from "bun:test";
import * as convStore from "./conversations";
import * as persistence from "./persistence";
import { prepareArchiveHashes, stopConversationLoader } from "./conversation-loader";
import { archiveWindow, isArchivedMessage } from "./conversation-window";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createStoredUserContextCheckpoint, currentReplayHistoryPrefix, historyPrefixHash,
  isRealUserMessage, type StoredMessage,
} from "./messages";
import { buildConversationApiContext } from "./context-compaction";
import { orchestrateSendMessage, orchestrateCompactConversation, orchestrateGoalCycle } from "./orchestrator";
import type { streamMessage } from "./api";

convStore.requireAsyncConversationLoading();
const ids: string[] = [];
function seed() {
  const id = `async-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  const conv = convStore.create(id, "openai", "gpt-6.1-sol", "worker fixture");
  conv.messages.push({ role: "user", content: "archived original task", metadata: null });
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

function server() {
  return {
    sendTo() {}, broadcast() {}, sendToSubscribers() {}, sendToSubscribersExcept() {},
    hasSubscribers: () => false, hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers() {},
  };
}
function response(text: string) {
  return { text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [], inputTokens: 20, outputTokens: 3 };
}
function callbacks(fn: typeof streamMessage) { return { onHeaders() {}, onComplete() {}, streamMessageFn: fn }; }
function send(id: string, text: string, fn: typeof streamMessage = async () => response("answer")) {
  return orchestrateSendMessage(server() as never, null, undefined, id, text, Date.now(), callbacks(fn));
}
afterEach(() => {
  stopConversationLoader();
  for (const id of ids.splice(0)) {
    convStore.clearStreamHandoff(id);
    convStore.clearHistoryUnwindPending(id);
    convStore.remove(id);
  }
});

test("cold get coalesces and strict synchronous access cannot block IPC", async () => {
  const id = seed();
  expect(() => convStore.get(id)).toThrow(/asynchronous loading/);
  const [one, two] = await Promise.all([convStore.getAsync(id), convStore.getAsync(id)]);
  expect(one).toBe(two);
  expect(one!.messages.some(isArchivedMessage)).toBe(true);
  expect(convStore.get(id)).toBe(one);
});

test("cold paging, full compatibility snapshots, tool outputs and metadata dedupe need no canonical load", () => {
  const id = seed();
  expect(convStore.getStoredDisplayPage(id, 10)).not.toBeNull();
  expect(convStore.getRenderSnapshot(id, false)?.entries.length).toBeGreaterThan(0);
  expect(convStore.getToolOutputs(id, ["old-1"])).toHaveLength(1);
  expect(convStore.hasToolBlock(id, "tool_use", "old-1", "exec_command")).toBe(true);
  expect(convStore.hasToolBlock(id, "tool_result", "old-1")).toBe(true);
  expect(convStore.getCached(id)).toBeUndefined();
});

test("Stop during cold loading cancels admission without accepting user input", async () => {
  const id = seed();
  let calls = 0;
  const pending = send(id, "must not be committed", async () => { calls++; return response("wrong"); });
  expect(convStore.isStreamHandoffActive(id)).toBe(true);
  convStore.clearStreamHandoff(id);
  const outcome = await pending;
  expect(outcome.ok).toBe(false);
  expect(calls).toBe(0);
  expect(persistence.load(id)!.messages.some(message => message.content === "must not be committed")).toBe(false);
  expect(convStore.isStreaming(id)).toBe(false);
});

test("an old cold admission cannot consume a newer handoff", async () => {
  const id = seed();
  const old = send(id, "old cancelled input");
  convStore.clearStreamHandoff(id);
  const newer = send(id, "new authoritative input");
  expect((await old).ok).toBe(false);
  expect((await newer).ok).toBe(true);
  const users = persistence.load(id)!.messages.filter(isRealUserMessage).map(message => message.content);
  expect(users).not.toContain("old cancelled input");
  expect(users.filter(text => text === "new authoritative input")).toHaveLength(1);
});

test("deletion wins over a pending cold read and never resurrects state", async () => {
  const id = seed();
  const pending = send(id, "deleted input");
  expect(convStore.remove(id)).toBe(true);
  expect((await pending).ok).toBe(false);
  expect(convStore.getCached(id)).toBeUndefined();
  expect(convStore.hasConversation(id)).toBe(false);
  expect(persistence.load(id)).toBeNull();
});

test("multiple queued prompts get exact preceding-prefix proofs and remain durable until commit", async () => {
  const id = seed();
  const first = convStore.pushQueuedMessage(id, "queued one", "next-turn");
  const second = convStore.pushQueuedMessage(id, "queued two", "next-turn");
  let calls = 0;
  const outcome = await send(id, "start a tool round", (async () => {
    if (++calls === 1) return {
      ...response(""), stopReason: "tool_use", blocks: [],
      toolCalls: [{ id: "new-tool", name: "exec_command", input: { cmd: "printf worker-integration", yield_time_ms: 1000 } }],
    };
    expect(convStore.getQueuedMessageById(first.id)).toBeUndefined();
    expect(convStore.getQueuedMessageById(second.id)).toBeUndefined();
    const canonical = persistence.load(id)!;
    for (const queueId of [first.id, second.id]) {
      const index = canonical.messages.findIndex(message => message.metadata?.queueEntryId === queueId);
      const historyCount = currentReplayHistoryPrefix(canonical.messages).historyCount
        - canonical.messages.slice(index).filter(message => message.role !== "system" && message.role !== "system_instructions" && message.metadata?.kind !== "context_warning").length;
      expect(canonical.messages[index].contextCheckpoint).toMatchObject({
        transcriptHistoryCount: historyCount, transcriptPrefixHash: historyPrefixHash(canonical.messages, historyCount),
      });
    }
    return response("finished after queues");
  }) as typeof streamMessage);
  expect(outcome.ok, outcome.error).toBe(true);
  expect(calls).toBe(2);
  expect(convStore.get(id)!.messages.some(isArchivedMessage)).toBe(true);
});

test("a fresh compaction installs a valid fixed boundary without serializing archive headers", async () => {
  const id = seed();
  const outcome = await orchestrateCompactConversation(server() as never, null, undefined, id, Date.now(), callbacks(async () => ({
    ...response(""), blocks: [], compactionItems: [{ encryptedContent: "new-opaque" }],
    compactionDoneCount: 1, responseCompleted: true,
  })));
  expect(outcome.ok, outcome.error).toBe(true);
  const canonical = persistence.load(id)!;
  const loaded = convStore.get(id)!;
  expect(canonical.activeContext?.windowNumber).toBe(2);
  expect(canonical.activeContext?.transcriptPrefixHash).toBe(
    historyPrefixHash(canonical.messages, canonical.activeContext!.transcriptHistoryCount),
  );
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(canonical));
  expect(loaded.messages.some(isArchivedMessage)).toBe(true);
});

test("indexed tail unwind and explicit archive rewrite preserve canonical history", async () => {
  const id = seed();
  const original = persistence.load(id)!.messages as StoredMessage[];
  const result = await convStore.unwindTo(id, 1, "worker-tail-unwind");
  expect(result?.status).toBe("applied");
  expect(persistence.load(id)!.messages).toEqual(original.slice(0, -2));
  const loaded = await convStore.getFullAsync(id);
  expect(loaded!.messages.some(isArchivedMessage)).toBe(false);
  expect(archiveWindow(loaded!.messages)?.prefixSequence).toBe(0);
  expect(convStore.setSystemInstructions(id, "new instructions")).toBe(true);
  expect(persistence.load(id)!.messages[0].content).toBe("new instructions");
  await prepareArchiveHashes(loaded!.messages);
  expect(createStoredUserContextCheckpoint(loaded!)).not.toBeNull();
  expect(convStore.trimConversation(id, "messages", 1)).not.toBeNull();
  expect(archiveWindow(loaded!.messages)).toBeNull();
});

test("an asynchronous full-read preparation cannot overwrite a new stream handoff", async () => {
  const id = `async-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  // Zero-header windows need the same post-await busy guard as compacted ones.
  convStore.create(id, "openai", "gpt-6.1-sol", "noncompacted");
  const preparing = convStore.getFullAsync(id);
  convStore.beginStreamHandoff(id);
  let error: unknown;
  try { await preparing; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("changing archive");
  expect(convStore.isStreamHandoffActive(id)).toBe(true);
});

test("trash undo/redo restores indexed metadata without synchronously loading an archive", async () => {
  const id = seed();
  expect(convStore.remove(id)).toBe(true);
  expect((await convStore.undoDeleteAsync())?.type).toBe("conversation");
  expect(convStore.hasConversation(id)).toBe(true);
  expect(convStore.getCached(id)).toBeUndefined();
  expect(convStore.getStoredDisplayPage(id, 10)).not.toBeNull();
  expect((await convStore.redoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.hasConversation(id)).toBe(false);
  expect((await convStore.undoDeleteAsync())?.type).toBe("conversation");
  expect((await convStore.getAsync(id))!.messages.some(isArchivedMessage)).toBe(true);
});

test("cold sidebar mutations, clones and undo do not hydrate canonical archives", async () => {
  const id = seed();
  expect(convStore.rename(id, "cold renamed")).toBe(true);
  expect(convStore.mark(id, true)).toBe(true);
  expect(convStore.pin(id, true)).toBe(true);
  expect(convStore.mute(id, true)).toBe(true);
  expect(convStore.getCached(id)).toBeUndefined();
  expect((await convStore.undoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.getCached(id)).toBeUndefined();
  const copy = convStore.clone(id)!;
  ids.push(copy.id);
  expect(copy.title).toContain("cold renamed");
  expect(convStore.getCached(copy.id)).toBeUndefined();
  const original = await convStore.getAsync(id);
  expect(original!.title).toBe("cold renamed");
  original!.messages.push({ role: "user", content: "after metadata-only writes", metadata: null });
  convStore.markDirty(id, "messages");
  convStore.flush(id);
});

test("Stop can persist a cold active-goal pause without loading its history", async () => {
  const id = seed();
  await convStore.getAsync(id);
  convStore.setGoal(id, "continue");
  convStore.conversationCacheInternalsForTest.evictClean();
  let calls = 0;
  const pending = orchestrateGoalCycle(server() as never, id, callbacks(async () => { calls++; return response("wrong"); }));
  convStore.clearStreamHandoff(id);
  expect(convStore.updateGoalStatus(id, "paused", { reason: "Paused by user." })?.status).toBe("paused");
  expect(convStore.getCached(id)).toBeUndefined();
  expect((await pending).ok).toBe(false);
  expect(calls).toBe(0);
  expect(persistence.load(id)?.goal?.status).toBe("paused");
});

test("pinned realtime/title owners survive cache pressure and dirty window paging stays indexed", async () => {
  const id = seed();
  const conv = (await convStore.getAsync(id))!;
  const release = convStore.pinConversationCache(id);
  convStore.conversationCacheInternalsForTest.evictClean();
  expect(convStore.getCached(id)).toBe(conv);
  conv.lastContextTokens = 42;
  convStore.markContextAttributionDirty(id);
  expect(convStore.getStoredDisplayPage(id, 10)?.contextTokens).toBe(42);
  expect(convStore.getRenderSnapshot(id, false)).not.toBeNull();
  release();
  convStore.conversationCacheInternalsForTest.evictClean();
  expect(convStore.getCached(id)).toBeUndefined();
});
