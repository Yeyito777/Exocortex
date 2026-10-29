import { afterEach, describe, expect, mock, test } from "bun:test";
import { describeLiveBlocks } from "@exocortex/shared/live-delta";
import { appendMessages, appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, create, initStreamingState, pushStreamingBlock, remove, setActiveJob, setStreamingCommittedBlockCount } from "./conversations";
import { createHandler, setHistoryPushDelayForTest } from "./handler";
import type { Block } from "./messages";

const IDS: string[] = [];
afterEach(() => {
  setHistoryPushDelayForTest(500);
  for (const id of IDS.splice(0)) { clearActiveJob(id); remove(id); }
});

function conversation(turns = 4): string {
  const id = `history-push-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "openai", "gpt-5.4");
  for (let turn = 0; turn < turns; turn++) {
    appendMessages(id, [
      { role: "user", content: `user ${turn} `.repeat(40), metadata: null },
      { role: "assistant", content: `assistant ${turn} `.repeat(40), metadata: null },
    ]);
  }
  return id;
}

/** A running turn with `thinking` streamed so far. */
function startTurn(id: string, thinking: string): void {
  appendMessages(id, [{ role: "user", content: "go ".repeat(30), metadata: null }]);
  setActiveJob(id, new AbortController(), Date.now());
  initStreamingState(id);
  appendToStreamingBlock(id, "thinking", thinking);
}

/** One provider round (a tool call and its result) committed to history, as the orchestrator does. */
function commitRound(id: string, n: number): void {
  appendMessages(id, [
    { role: "assistant", content: [{ type: "text", text: `round ${n} `.repeat(30) }, { type: "tool_use", id: `tu-${n}`, name: "bash", input: { command: `step ${n}` } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tu-${n}`, content: `output ${n} `.repeat(30), is_error: false }], metadata: null },
  ], { preservePendingAssistant: true });
  clearCurrentStreamingBlocks(id);
  setStreamingCommittedBlockCount(id, n * 3);
}

const CAPS = ["history-block-pagination", "history-folded-elision", "history-push"];

function harness(capabilities = CAPS) {
  setHistoryPushDelayForTest(5);
  const sent: Array<any> = [];
  const client = { capabilities: new Set<string>(capabilities), subscriptions: new Set<string>(), socket: { destroyed: false } };
  const server = {
    sendTo: mock((_client: unknown, event: unknown) => { sent.push(event); }),
    broadcast: mock(() => {}), sendToSubscribers: mock(() => {}), sendToSubscribersExcept: mock(() => {}),
    subscribe: mock((target: typeof client, convId: string) => { target.subscriptions.add(convId); }),
    unsubscribe: mock((target: typeof client, convId: string) => { target.subscriptions.delete(convId); }),
    hasSubscribers: mock(() => false), broadcastHistoryRevisions: mock(() => {}),
  };
  const handle = createHandler(server as never);
  const run = async (command: Parameters<typeof handle>[1]) => {
    sent.length = 0;
    await handle(client as never, command);
    return [...sent];
  };
  const pushes = () => sent.filter(event => event.type === "history_push");
  const nextPush = async () => {
    for (let i = 0; i < 300 && pushes().length === 0; i++) await Bun.sleep(2);
    const [push] = pushes();
    expect(push).toBeDefined();
    sent.length = 0;
    return push;
  };
  const open = (convId: string, extra: Record<string, unknown> = {}) => ({
    type: "load_conversation" as const, reqId: `open-${Math.random()}`, convId, turns: 3,
    viewport: { rows: 40, cols: 120, folded: true }, initialBackfill: { reqId: `bf-${Math.random()}`, turns: 3 }, watch: true as const, ...extra,
  });
  return { client, server, run, sent, pushes, nextPush, open };
}

describe("watched copies (history_push)", () => {
  test("stream the live part as it grows, only what is newer, coalesced", async () => {
    const id = conversation();
    const { run, nextPush, open, sent } = harness();
    startTurn(id, "Let me look");
    const [loaded] = await run(open(id, { peek: true }));
    expect(loaded.copySeq).toBeNumber();
    expect(loaded.pendingAI.blocks).toEqual([{ type: "thinking", text: "Let me look" }]);
    expect(loaded.pendingAI.blocksBase).toBeUndefined();

    for (let i = 0; i < 3; i++) appendToStreamingBlock(id, "thinking", " closer");
    const text = await nextPush();
    expect(text).toMatchObject({ type: "history_push", convId: id, base: loaded.copySeq, live: { blocksBase: { keep: 0, extend: " closer closer closer" }, blocks: [] } });
    expect(text.loaded).toBeUndefined();
    expect(text.copySeq).toBeGreaterThan(loaded.copySeq);

    pushStreamingBlock(id, { type: "tool_call", toolCallId: "t1", toolName: "bash", input: { command: "ls" }, summary: "ls" });
    pushStreamingBlock(id, { type: "tool_result", toolCallId: "t1", toolName: "bash", output: "a big output ".repeat(500), isError: false });
    const tools = await nextPush();
    expect(tools.base).toBe(text.copySeq);
    expect(tools.live.blocksBase).toEqual({ keep: 1 });
    // Tool output is not pushed: it is fetched when shown.
    expect(tools.live.blocks.map((block: Block) => block.type === "tool_result" ? block.output : block.type)).toEqual(["tool_call", ""]);
    expect(JSON.stringify(tools).length).toBeLessThan(1_000);
    sent.length = 0;
    const [outputs] = await run({ type: "load_tool_outputs", reqId: "o", convId: id, toolCallIds: ["t1"] });
    expect(outputs.outputs).toEqual([{ toolCallId: "t1", output: "a big output ".repeat(500) }]);
  });

  test("send a committed round as the page's new blocks, not the whole turn again", async () => {
    const id = conversation();
    const { run, nextPush, open } = harness();
    startTurn(id, "Thinking");
    commitRound(id, 1);
    const [loaded] = await run(open(id, { peek: true }));
    const turnEntry = loaded.entries.at(-1);
    expect(turnEntry.type).toBe("ai");
    commitRound(id, 2);
    const push = await nextPush();
    expect(push.rev).not.toBe(loaded.historyRev);
    expect(push.loaded.entryBlocks).toHaveLength(1);
    const [fresh, , order] = push.loaded.entryBlocks[0];
    expect(order.filter((index: number) => index < 0).length).toBeGreaterThan(0);
    // Only what the round added (and what it changed) travels.
    expect(push.loaded.entries[fresh].blocks.length).toBeLessThanOrEqual(4);
    expect(order.length).toBe(turnEntry.blocks.length + 3);
    expect(push.loaded.entries.filter((entry: { type: string }) => entry.type === "user")).toEqual([]);
    expect(push.live).toMatchObject({ blocks: [] });
  });

  test("pause while open, resume after leaving; stop when deleted or past the limit", async () => {
    const id = conversation();
    const { run, nextPush, pushes, open, sent } = harness();
    startTurn(id, "a");
    await run(open(id));
    appendToStreamingBlock(id, "thinking", "b");
    await Bun.sleep(30);
    expect(pushes()).toEqual([]);
    await run({ type: "unsubscribe", convId: id });
    expect((await nextPush()).live.blocksBase).toEqual({ keep: 0, extend: "b" });
    // Leaving an unchanged copy confirms it at once.
    await run(open(id));
    const [confirmed] = (await run({ type: "unsubscribe", convId: id })).filter(event => event.type === "history_push");
    expect(confirmed).toMatchObject({ type: "history_push", convId: id, base: expect.any(Number), copySeq: expect.any(Number) });
    expect(confirmed.live).toBeUndefined();
    expect(confirmed.loaded).toBeUndefined();
    sent.length = 0;

    remove(id);
    IDS.splice(IDS.indexOf(id), 1);
    appendToStreamingBlock(id, "thinking", "c");
    expect(await nextPush()).toEqual({ type: "history_push", convId: id, unwatched: true });

    const many = Array.from({ length: 17 }, () => conversation(1));
    for (const convId of many) await run(open(convId, { peek: true }));
    expect(pushes()).toEqual([{ type: "history_push", convId: many[0], unwatched: true }]);
  });

  test("an open sends the live part against the client's copy, and its catch-up leaves the blocks out", async () => {
    const id = conversation();
    const { run, open } = harness();
    startTurn(id, "Planning the change");
    const copy: Block[] = [{ type: "thinking", text: "Planning" }];
    const events = await run(open(id, { liveBase: describeLiveBlocks(copy) }));
    const loaded = events.find(event => event.type === "conversation_loaded");
    expect(loaded.pendingAI).toMatchObject({ blocksBase: { keep: 0, extend: " the change" }, blocks: [] });
    const catchup = events.find(event => event.type === "streaming_started");
    expect(catchup).toMatchObject({ snapshotKind: "catchup", blockOffset: 0 });
    expect(catchup).not.toHaveProperty("blocks");
  });

  test("an open naming the watched copy is sent against the daemon's record of it, with nothing described", async () => {
    const id = conversation(60);
    const { run, open } = harness();
    startTurn(id, "Look");
    const peeked = await run(open(id, { peek: true }));
    const copySeq = peeked[0].copySeq;
    appendToStreamingBlock(id, "thinking", "ing again");
    const events = await run(open(id, { baseCopy: copySeq }));
    const loaded = events.find(event => event.type === "conversation_loaded");
    expect(loaded.baseCopy).toBe(copySeq);
    expect(loaded.entries).toEqual([]);
    expect(loaded.entryOrder.every((index: number) => index < 0)).toBe(true);
    expect(loaded.pendingAI).toMatchObject({ blocksBase: { keep: 0, extend: "ing again" }, blocks: [] });
    const backfill = events.find(event => event.type === "conversation_history_loaded");
    expect(backfill).toMatchObject({ baseCopy: copySeq, entries: [] });
    // A copy the daemon does not know (any more) gets an ordinary answer.
    const stale = (await run(open(id, { baseCopy: 9_999_999 }))).find(event => event.type === "conversation_loaded");
    expect(stale.baseCopy).toBeUndefined();
    expect(stale.entries.length).toBeGreaterThan(0);
  });

  test("older clients are unchanged: whole live part with tool output, catch-up blocks, no watch", async () => {
    const id = conversation();
    const { run, open, pushes } = harness(["history-block-pagination", "history-folded-elision"]);
    startTurn(id, "x");
    pushStreamingBlock(id, { type: "tool_result", toolCallId: "t", toolName: "bash", output: "full", isError: false });
    const events = await run(open(id, { liveBase: describeLiveBlocks([{ type: "thinking", text: "x" }]) }));
    const loaded = events.find(event => event.type === "conversation_loaded");
    expect(loaded).not.toHaveProperty("copySeq");
    expect(loaded.pendingAI.blocks.at(-1).output).toBe("full");
    expect(loaded.pendingAI.blocksBase).toBeUndefined();
    expect(events.find(event => event.type === "streaming_started").blocks).toHaveLength(2);
    await run({ type: "unsubscribe", convId: id });
    appendToStreamingBlock(id, "thinking", "y");
    await Bun.sleep(30);
    expect(pushes()).toEqual([]);
  });
});
