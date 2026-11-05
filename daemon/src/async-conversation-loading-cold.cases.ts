import { afterEach, expect, test } from "bun:test";
import * as convStore from "./conversations";
import * as persistence from "./persistence";
import { isRealUserMessage } from "./messages";
import { orchestrateSendMessage, orchestrateGoalCycle } from "./orchestrator";
import { cancelDeferredChronoSleep, configureChronoService, deferChronoSleep, interruptDeferredChronoSleep, listDeferredChronoSleeps, startChronoService, stopChronoService } from "./chrono-service";
import type { streamMessage } from "./api";
import { cleanupAsyncLoadingCase, ids, seed, server, response, callbacks } from "./async-conversation-loading-test-helpers";

convStore.requireAsyncConversationLoading();
afterEach(cleanupAsyncLoadingCase);

test("an unwound conversation gone cold is deleted, alone or with its folder, without loading", async () => {
  const alone = seed();
  const inFolder = seed();
  for (const id of [alone, inFolder]) expect((await convStore.unwindTo(id, 1, `cold-delete-${id}`))?.status).toBe("applied");
  const kept = persistence.load(alone)!.messages;
  const folder = convStore.createFolder(`cold unwound ${Date.now()}`, null, [{ type: "conversation", id: inFolder }])!;
  convStore.conversationCacheInternalsForTest.evictClean();
  for (const id of [alone, inFolder]) {
    expect(convStore.getCached(id)).toBeUndefined();
    expect(persistence.hasConversationUnwindReceipt(id)).toBe(true);
  }

  expect(convStore.remove(alone)).toBe(true);
  expect(convStore.hasConversation(alone)).toBe(false);
  expect(persistence.hasConversationUnwindReceipt(alone)).toBe(false);
  expect(convStore.deleteFolder(folder.id)).toBe(true);
  expect(convStore.hasConversation(inFolder)).toBe(false);
  expect(convStore.getCached(alone) ?? convStore.getCached(inFolder)).toBeUndefined();

  expect((await convStore.undoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.getSummary(inFolder)?.folderId).toBe(folder.id);
  expect((await convStore.undoDeleteAsync())?.type).toBe("conversation");
  expect(persistence.load(alone)!.messages).toEqual(kept);
});

test("undoing a folder unwrap keeps every cold child loaded under cache pressure", async () => {
  const first = seed();
  const second = seed();
  const folder = convStore.createFolder("unwrap fixture")!;
  expect(convStore.moveConversationToFolder(first, folder.id)).toBe(true);
  expect(convStore.moveConversationToFolder(second, folder.id)).toBe(true);
  expect(convStore.deleteFolder(folder.id, "unwrap")).toBe(true);
  convStore.conversationCacheInternalsForTest.evictClean();
  convStore.conversationCacheInternalsForTest.setLimits({ maxEntries: 1, maxFileBytes: Number.MAX_SAFE_INTEGER });
  try {
    expect(await convStore.undoDeleteAsync()).not.toBeNull();
    expect(convStore.getIndexedSummary(first)?.folderId).toBe(folder.id);
    expect(convStore.getIndexedSummary(second)?.folderId).toBe(folder.id);
  } finally {
    convStore.conversationCacheInternalsForTest.resetLimits();
    convStore.deleteFolder(folder.id, "unwrap", false);
  }
});

test("undo and redo of a cold rename or mark apply without loading, and older entries stay reachable", async () => {
  const a = seed();
  const b = seed();
  convStore.conversationCacheInternalsForTest.evictClean();
  const titleB = convStore.getSummary(b)!.title;
  expect(convStore.rename(b, "B renamed")).toBe(true);
  expect(convStore.mark(a, true)).toBe(true);
  expect((await convStore.undoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.getSummary(a)?.marked).toBe(false);
  expect((await convStore.undoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.getSummary(b)?.title).toBe(titleB);
  expect(convStore.getCached(a)).toBeUndefined();
  expect(convStore.getCached(b)).toBeUndefined();
  expect((await convStore.redoDeleteAsync())?.type).toBe("sidebar_state");
  expect(convStore.getSummary(b)?.title).toBe("B renamed");
  expect((await convStore.getAsync(b))!.title).toBe("B renamed");
});

test("a deleted conversation's slow-to-stop turn never touches it after undo and a new turn", async () => {
  const id = seed();
  // Turn 1 takes 300 ms to honor abort (a slow tool or provider teardown).
  const slow = (async (_p: unknown, _m: unknown, _model: unknown, _cb: unknown, options: { signal: AbortSignal }) => {
    await new Promise<void>(resolve => {
      if (options.signal.aborted) setTimeout(resolve, 300);
      else options.signal.addEventListener("abort", () => setTimeout(resolve, 300));
    });
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  }) as unknown as typeof streamMessage;
  const first = orchestrateSendMessage(server() as never, null, undefined, id, "first", Date.now(), callbacks(slow));
  for (let i = 0; i < 600 && !convStore.getActiveJob(id); i++) await Bun.sleep(5);
  expect(convStore.getActiveJob(id)).toBeDefined();
  expect(convStore.remove(id)).toBe(true);
  expect((await convStore.undoDeleteAsync())?.type).toBe("conversation");

  let release!: () => void;
  const held = (async () => { await new Promise<void>(resolve => { release = resolve; }); return response("second answer"); }) as typeof streamMessage;
  const second = orchestrateSendMessage(server() as never, null, undefined, id, "second", Date.now(), callbacks(held));
  for (let i = 0; i < 600 && !release; i++) await Bun.sleep(5);
  const secondJob = convStore.getActiveJob(id);
  expect(secondJob).toBeDefined();

  expect((await first).aborted).toBe(true);
  // The old turn's end left the new turn's job and transcript alone.
  expect(convStore.getActiveJob(id)).toBe(secondJob);
  expect(convStore.isStreaming(id)).toBe(true);
  release();
  expect((await second).ok).toBe(true);
  const tail = (await convStore.getAsync(id))!.messages.slice(-3).map(m => [m.role, typeof m.content === "string" ? m.content : "blocks"]);
  // "first" was saved before the delete; nothing of turn 1's was written after it.
  expect(tail).toEqual([["user", "first"], ["user", "second"], ["assistant", "blocks"]]);
});

test("a turn in a subagent whose parent is cold loads the parent instead of failing", async () => {
  const parent = seed();
  const child = seed();
  await convStore.getAsync(child);
  convStore.setSubagentPolicy(child, { parentConversationId: parent, allowEdits: false, parentSystemInstructions: "" });
  convStore.conversationCacheInternalsForTest.evictClean();
  expect(convStore.getCached(parent)).toBeUndefined();
  expect(convStore.getCached(child)).toBeUndefined();

  const outcome = await orchestrateSendMessage(
    server() as never, null, undefined, child, "[chrono wake: chrono:test]\ncheck the run", Date.now(),
    callbacks(async () => response("checked")), undefined, { automation: { kind: "chrono_wake", sourceId: "chrono:test" } },
  );

  expect(outcome.error).toBeUndefined();
  expect(outcome.ok).toBe(true);
  const stored = persistence.load(child)!.messages;
  expect(stored.some(message => message.role === "system" && String(message.content).startsWith("✗"))).toBe(false);
  expect(stored.some(message => isRealUserMessage(message) && String(message.content).includes("check the run"))).toBe(true);
});

/** A conversation holding an unanswered Chrono sleep call, gone cold as after a restart. */
async function seedColdSleeper(toolCallId: string): Promise<string> {
  const id = seed();
  await convStore.getAsync(id);
  convStore.appendMessages(id, [{
    role: "assistant",
    content: [{ type: "tool_use", id: toolCallId, name: "chrono", input: { action: "sleep", duration: "10m" } }],
    metadata: null,
  }]);
  convStore.conversationCacheInternalsForTest.evictClean();
  expect(convStore.getCached(id)).toBeUndefined();
  return id;
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await Bun.sleep(5);
  }
}

test("a deferred Chrono sleep ending on a cold conversation loads it, attaches its result and replays", async () => {
  const id = await seedColdSleeper("cold-sleep-elapsed");
  let replayed = false;
  configureChronoService(null, () => { replayed = true; });
  await startChronoService();
  try {
    const durationMs = 10 * 60_000;
    expect(deferChronoSleep({ conversationId: id, toolCallId: "cold-sleep-elapsed", startedAt: Date.now() - durationMs + 20, durationMs }).error).toBeUndefined();
    await until(() => replayed && listDeferredChronoSleeps(id).length === 0);
    expect(convStore.hasToolBlock(id, "tool_result", "cold-sleep-elapsed")).toBe(true);
  } finally {
    stopChronoService();
    configureChronoService(null);
  }
});

test("cancelling a cold conversation's deferred sleep answers at once and attaches the result after loading", async () => {
  const id = await seedColdSleeper("cold-sleep-stop");
  let replayed = false;
  const historyChanged: string[] = [];
  configureChronoService(null, () => { replayed = true; }, changed => { historyChanged.push(changed); });
  await startChronoService();
  try {
    expect(deferChronoSleep({ conversationId: id, toolCallId: "cold-sleep-stop", startedAt: Date.now(), durationMs: 10 * 60_000 }).error).toBeUndefined();
    expect(cancelDeferredChronoSleep(id)).toBe(true);
    expect(convStore.getCached(id)).toBeUndefined();
    await until(() => listDeferredChronoSleeps(id).length === 0);
    expect(convStore.hasToolBlock(id, "tool_result", "cold-sleep-stop")).toBe(true);
    expect(historyChanged).toEqual([id]);
    expect(replayed).toBe(false);
  } finally {
    stopChronoService();
    configureChronoService(null);
  }
});

test("a user turn right after a cold Stop finds the cancelled sleep's result already attached", async () => {
  const id = await seedColdSleeper("cold-sleep-stop-turn");
  // The scheduler is not running here: the turn has to attach the result itself.
  expect(deferChronoSleep({ conversationId: id, toolCallId: "cold-sleep-stop-turn", startedAt: Date.now(), durationMs: 10 * 60_000 }).error).toBeUndefined();
  expect(cancelDeferredChronoSleep(id)).toBe(true);
  expect(convStore.hasToolBlock(id, "tool_result", "cold-sleep-stop-turn")).toBe(false);
  await convStore.getAsync(id);
  expect(interruptDeferredChronoSleep(id)).toBeNull();
  expect(convStore.hasToolBlock(id, "tool_result", "cold-sleep-stop-turn")).toBe(true);
  expect(listDeferredChronoSleeps(id)).toEqual([]);
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

test("pinned cache owners survive cache pressure and dirty window paging stays indexed", async () => {
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

test("a context-attribution mark does not downgrade a pending full save", async () => {
  const id = `async-attribution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  convStore.create(id, "openai", "gpt-6.1-sol", "attribution fixture");
  convStore.appendMessages(id, [
    { role: "user", content: "hi", metadata: null },
    { role: "assistant", content: "hello", metadata: { startedAt: 1, endedAt: null, model: "gpt-6.1-sol", tokens: 0 } },
  ]);
  const conv = (await convStore.getAsync(id))!;
  // The aborted turn's metadata is stamped in place and flushed later; a
  // context update lands in between.
  conv.messages[1].metadata!.endedAt = 99;
  convStore.markDirty(id, "messages");
  convStore.markContextAttributionDirty(id);
  convStore.flush(id);
  expect(persistence.load(id)!.messages[1].metadata?.endedAt).toBe(99);
});

test("commands on cold unwound conversations: delete_conversation and save_tool_instructions", async () => {
  const { createHandler } = await import("./handler");
  const sent: Array<{ type: string; reqId?: string; message?: string }> = [];
  const handle = createHandler({
    ...server(),
    sendTo: (_client: unknown, event: { type: string; reqId?: string; message?: string }) => { sent.push(event); return 0; },
    broadcastExcept() {}, subscribe() {}, unsubscribe() {}, setHiddenConversationFilter() {},
    onClientClosed: () => () => {}, broadcastSidebarStatePatched() {}, broadcastSidebarItemsReordered() {},
  } as never);
  const client = { id: "cold-commands", socket: { destroyed: false }, subscriptions: new Set(), capabilities: new Set() };
  const run = (command: Record<string, unknown>) => handle(client as never, command as never);
  try {
    const deleted = seed();
    const routed = seed();
    for (const id of [deleted, routed]) expect((await convStore.unwindTo(id, 1, `cold-command-${id}`))?.status).toBe("applied");
    convStore.conversationCacheInternalsForTest.evictClean();

    await run({ type: "delete_conversation", reqId: "delete", convId: deleted });
    expect(convStore.hasConversation(deleted)).toBe(false);
    // Empty edits stop at validation, after the route is known: nothing is written.
    await run({ type: "save_tool_instructions", reqId: "save", convId: routed, edits: [] });
    for (let i = 0; i < 100 && !sent.some(event => event.reqId === "save"); i++) await Bun.sleep(5);
    expect(sent.filter(event => event.type === "error")).toEqual([{ type: "error", reqId: "save", message: "Nothing to save" }]);
  } finally {
    await handle.stop();
  }
});
