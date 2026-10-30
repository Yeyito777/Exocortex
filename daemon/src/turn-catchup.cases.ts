import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer, type ConnectedClient } from "./server";
import { createHandler } from "./handler";
import * as convStore from "./conversations";
import { orchestrateReplayConversation, orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { registerTurnAwait } from "./app-api";
import { setAppRegistryPathForTests } from "./app-registry";
import type { streamMessage } from "./api";
import type { Block } from "./messages";
import type { Command } from "./protocol";

// Turn catch-ups (docs/app-api.md, "Catching up with a turn") through the real
// server, handler and orchestrator, with a scripted model: a client that drops
// mid-stream, takes its session back, attaches from another connection or
// re-attaches must rebuild exactly the turn's blocks from the catch-up and the
// stream events that follow it, none of them before it.

type Json = Record<string, any>;

let dir: string;
let server: DaemonServer;
let handle: ReturnType<typeof createHandler>;
let script: typeof streamMessage;
const sockets: Socket[] = [];

const callbacks: OrchestrationCallbacks = {
  onHeaders() {},
  onComplete() {},
  streamMessageFn: ((...args: Parameters<typeof streamMessage>) => script(...args)) as typeof streamMessage,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "exo-turn-catchup-"));
  setAppRegistryPathForTests(join(dir, "app-conversations.json"));
  server = new DaemonServer(join(dir, "daemon.sock"), (client: ConnectedClient, cmd: Command) => {
    // The handler's own path for an awaited send, with the scripted model; a send again goes to the handler.
    if (cmd.type === "send_message" && !convStore.hasMessageMetadata(cmd.convId, { startedAt: cmd.startedAt! }, "user")) {
      if (cmd.awaitResult) registerTurnAwait(client, cmd.reqId, cmd.convId, String(cmd.startedAt));
      return void orchestrateSendMessage(server, client, cmd.reqId, cmd.convId, cmd.text, cmd.startedAt!, callbacks, undefined, { subagentMaxDepth: null });
    }
    return handle(client, cmd);
  });
  handle = createHandler(server);
  await server.start();
});

afterAll(async () => {
  await handle.stop();
  await server.stop();
  setAppRegistryPathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

async function until(done: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  if (!done()) throw new Error(`Timed out waiting for ${label}`);
}

/** A raw app connection: every event it received, in order. */
interface Conn { socket: Socket; events: Json[]; send(cmd: Json): void; wait(match: (e: Json) => boolean, label: string): Promise<Json> }

async function connectApp(session?: string, capabilities = ["turn-catchup"]): Promise<{ conn: Conn; welcome: Json }> {
  const socket = netConnect(join(dir, "daemon.sock"));
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const events: Json[] = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    buffer += data;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) events.push(JSON.parse(line));
    }
  });
  const conn: Conn = {
    socket,
    events,
    send: cmd => { socket.write(JSON.stringify(cmd) + "\n"); },
    wait: async (match, label) => {
      await until(() => events.some(match), label);
      return events.find(match)!;
    },
  };
  conn.send({ type: "client_capabilities", reqId: "w", capabilities, app: { name: "demo", reconnectGraceMs: 60_000, ...(session ? { session } : {}) } });
  const welcome = await conn.wait(e => e.type === "app_welcome", "app_welcome");
  return { conn, welcome };
}

/** Drop a connection and wait until the daemon saw it go. */
async function drop(conn: Conn): Promise<void> {
  conn.socket.destroy();
  await until(() => server.clientCount === sockets.filter(socket => !socket.destroyed).length, "the daemon to see the connection go");
}

const BLOCK_EVENTS = new Set(["block_start", "text_chunk", "thinking_chunk", "tool_call", "tool_result", "streaming_sync", "message_complete"]);

/**
 * What a client following the turn builds from catch-ups and the stream
 * events after them alone (streaming_sync is followed by a catch-up), up to
 * the stream's final message_complete, whose blocks it must then equal.
 * `stale` counts stream events at or below the last catch-up's seq: none
 * should ever arrive.
 */
function follow(events: Json[], convId: string, from: Block[] = []): { blocks: Block[]; stale: number; catchups: Json[]; text: string } {
  let blocks = structuredClone(from);
  let seq = 0;
  let offset = 0;
  let stale = 0;
  const catchups: Json[] = [];
  for (const event of events) {
    if (event.convId !== convId) continue;
    if (event.type === "turn_catchup") {
      blocks = structuredClone(event.blocks);
      seq = event.streamSeq;
      offset = event.streamOffset;
      catchups.push(event);
      continue;
    }
    if (event.type === "streaming_started" && event.snapshotKind === "start") { seq = event.streamSeq; continue; }
    if (event.type === "turn_result" || event.type === "message_complete") break;
    if (!BLOCK_EVENTS.has(event.type)) continue;
    if (event.streamSeq <= seq) { stale++; continue; }
    seq = event.streamSeq;
    if (event.type === "block_start") blocks.push({ type: event.blockType, text: "" });
    else if (event.type === "text_chunk" || event.type === "thinking_chunk") {
      const type = event.type === "text_chunk" ? "text" : "thinking";
      const last = blocks.at(-1);
      if (last?.type === type) last.text += event.text; else blocks.push({ type, text: event.text });
    } else if (event.type === "tool_call") {
      blocks.push({ type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input, summary: event.summary });
    } else if (event.type === "tool_result") {
      blocks.push({ type: "tool_result", toolCallId: event.toolCallId, toolName: event.toolName, output: event.output, isError: event.isError });
    }
  }
  void offset;
  const text = blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("");
  return { blocks, stale, catchups, text };
}

function textOf(blocks: Block[]): string {
  return blocks.flatMap(block => block.type === "text" ? [block.text] : []).join("");
}

const reply = (text: string) => ({
  text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [], inputTokens: 1, outputTokens: 1,
});
const toolRound = (text: string, id: string) => ({
  text, thinking: "", stopReason: "tool_use" as const, blocks: [{ type: "text" as const, text }],
  toolCalls: [{ id, name: "lookup", input: { q: id } }], inputTokens: 1, outputTokens: 1,
});

/** Two rounds around an app tool call; `gates` hold the stream at named points. */
function twoRounds(gates: Record<string, Promise<void>>, reached: Set<string>): typeof streamMessage {
  let round = 0;
  return (async (_provider, _messages, _model, cb) => {
    round++;
    if (round === 1) {
      cb.onBlockStart?.("text");
      cb.onText("alpha ");
      cb.onText("beta ");
      reached.add("first");
      await gates.first;
      cb.onText("gamma ");
      return toolRound("alpha beta gamma ", `call-${Date.now()}`);
    }
    cb.onBlockStart?.("text");
    cb.onText("delta ");
    reached.add("second");
    await gates.second;
    cb.onText("epsilon");
    return reply("delta epsilon");
  }) as typeof streamMessage;
}

async function createConversation(conn: Conn): Promise<string> {
  conn.send({
    type: "new_conversation", reqId: "c", provider: "openai", model: "gpt-5.4", lifetime: "temporary",
    tools: { app: [{ name: "lookup", description: "Looks it up.", inputSchema: { type: "object" } }] },
  });
  const created = await conn.wait(e => e.type === "conversation_created" && e.reqId === "c", "conversation_created");
  return created.convId;
}

/** Answer every app tool call this connection gets from now on. */
function answerTools(conn: Conn): void {
  let answered = 0;
  const timer = setInterval(() => {
    const calls = conn.events.filter(e => e.type === "app_tool_call");
    for (const call of calls.slice(answered)) conn.send({ type: "app_tool_result", convId: call.convId, callId: call.callId, output: "found" });
    answered = calls.length;
    if (conn.socket.destroyed) clearInterval(timer);
  }, 2);
}

describe("turn catch-ups", () => {
  test("a client that drops mid-stream gets the turn back exactly once, with what streamed while it was away", async () => {
    const first = gate(), second = gate();
    const reached = new Set<string>();
    script = twoRounds({ first: first.promise, second: second.promise }, reached);
    const { conn: a, welcome } = await connectApp();
    expect(welcome.turnCatchup).toBe(true);
    const convId = await createConversation(a);
    const startedAt = Date.now();
    a.send({ type: "send_message", reqId: "s", convId, text: "go", startedAt, awaitResult: true });
    await until(() => reached.has("first"), "the first round");
    await until(() => follow(a.events, convId).text === "alpha beta ", "the first chunks");
    const before = follow(a.events, convId).blocks;

    await drop(a);
    // While it is away: the rest of the round, then the tool call waits for its owner.
    first.open();
    await until(() => convStore.getTurnCatchup(convId)?.blocks.some(block => block.type === "tool_call") === true, "the tool call");

    const { conn: b, welcome: back } = await connectApp(welcome.session);
    expect(back.resumed).toBe(true);
    answerTools(b);
    b.send({ type: "send_message", reqId: "s2", convId, text: "go", startedAt, awaitResult: true });
    await until(() => reached.has("second"), "the second round");
    await until(() => follow(b.events, convId, before).text === "alpha beta gamma delta ", "the second round's first chunk");
    const caughtUp = follow(b.events, convId, before);
    expect(caughtUp.catchups).toHaveLength(1);
    expect(caughtUp.catchups[0]).toMatchObject({ turnId: String(startedAt), streamOffset: 0 });
    expect(textOf(caughtUp.catchups[0].blocks)).toBe("alpha beta gamma ");
    // The catch-up came after the welcome.
    const order = b.events.map(e => e.type);
    expect(order.indexOf("app_welcome")).toBeLessThan(order.indexOf("turn_catchup"));

    // Away again in the second round: the first one is committed now.
    await drop(b);
    const { conn: d } = await connectApp(welcome.session);
    d.send({ type: "send_message", reqId: "s3", convId, text: "go", startedAt, awaitResult: true });
    const again = await d.wait(e => e.type === "turn_catchup", "the second catch-up");
    expect(again.blocks.map((block: Block) => block.type)).toEqual(["text", "tool_call", "tool_result", "text"]);
    second.open();
    const result = await d.wait(e => e.type === "turn_result" && e.reqId === "s3", "turn_result");

    const view = follow(d.events, convId);
    expect(view.stale).toBe(0);
    expect(view.text).toBe("alpha beta gamma delta epsilon");
    expect(view.blocks).toEqual(result.blocks);
    expect(result.text).toBe("delta epsilon");
  });

  test("a turn that ends while its owner is away comes back whole with the held turn_result, then a running one catches up", async () => {
    const first = gate(), second = gate();
    const reached = new Set<string>();
    let turns = 0;
    const rounds = twoRounds({ first: first.promise, second: second.promise }, reached);
    const queuedTurn = gate();
    script = (async (...args: Parameters<typeof streamMessage>) => {
      if (turns < 2) { turns++; return rounds(...args); }
      // The queued follow-up turn: it streams, then holds.
      const cb = args[3];
      cb.onBlockStart?.("text");
      cb.onText("follow-up ");
      reached.add("queued");
      await queuedTurn.promise;
      cb.onText("done");
      return reply("follow-up done");
    }) as typeof streamMessage;
    const { conn: a, welcome } = await connectApp();
    const convId = await createConversation(a);
    answerTools(a);
    const startedAt = Date.now();
    a.send({ type: "send_message", reqId: "s", convId, text: "go", startedAt, awaitResult: true });
    await until(() => follow(a.events, convId).text === "alpha beta ", "the first chunks");
    // A message for after this turn: it starts the next turn while the owner is away.
    a.send({ type: "queue_message", reqId: "q", convId, text: "and then?", timing: "message-end", queueId: `q-${startedAt}` });
    await a.wait(e => e.type === "ack" && e.reqId === "q", "queued");
    first.open();
    await until(() => a.events.some(e => e.type === "app_tool_call"), "the tool call");
    await until(() => reached.has("second"), "the second round");
    const before = follow(a.events, convId).blocks;

    await drop(a);
    second.open();
    await until(() => reached.has("queued"), "the queued turn");

    const { conn: b } = await connectApp(welcome.session);
    const held = await b.wait(e => e.type === "turn_result" && e.turnId === String(startedAt), "the held turn_result");
    const catchup = await b.wait(e => e.type === "turn_catchup", "the running turn's catch-up");
    const types = b.events.map(e => e.type);
    expect(types.indexOf("app_welcome")).toBeLessThan(types.indexOf("turn_result"));
    expect(types.indexOf("turn_result")).toBeLessThan(types.indexOf("turn_catchup"));
    // The ended turn: what the client had, completed by the held copy.
    expect(textOf(held.blocks)).toBe("alpha beta gamma delta epsilon");
    expect(held.blocks.slice(0, before.length).map((block: Block) => block.type)).toEqual(before.map(block => block.type));
    expect(textOf(held.blocks).startsWith(textOf(before))).toBe(true);
    // The running one, from its catch-up on.
    expect(catchup.turnId).not.toBe(String(startedAt));
    queuedTurn.open();
    const next = await b.wait(e => e.type === "turn_result" && e.turnId === catchup.turnId, "the queued turn's result");
    const view = follow(b.events.slice(b.events.indexOf(catchup)), convId);
    expect(view.stale).toBe(0);
    expect(view.text).toBe("follow-up done");
    expect(next.blocks).toEqual(view.blocks);
  });

  test("attaching from another connection, re-attaching and a streaming_sync each catch up without gaps or repeats", async () => {
    const first = gate(), second = gate();
    const reached = new Set<string>();
    let round = 0;
    script = (async (_provider, _messages, _model, cb) => {
      round++;
      if (round === 1) {
        cb.onBlockStart?.("text");
        cb.onText("draft that ");
        cb.onText("goes away");
        reached.add("first");
        await first.promise;
        // The provider replaced what it streamed.
        cb.onBlocksUpdate?.([{ type: "text", text: "kept " }]);
        cb.onText("text");
        reached.add("second");
        await second.promise;
        cb.onText(" end");
        return reply("kept text end");
      }
      return reply("unused");
    }) as typeof streamMessage;
    const { conn: a } = await connectApp();
    const convId = await createConversation(a);
    const startedAt = Date.now();
    a.send({ type: "send_message", reqId: "s", convId, text: "go", startedAt, awaitResult: true });
    await until(() => reached.has("first"), "the first chunks");

    // Another connection of the app attaches mid-turn: it becomes the owner, caught up first.
    const { conn: c } = await connectApp();
    c.send({ type: "attach_app_conversation", reqId: "a1", convId });
    await c.wait(e => e.type === "app_conversation_attached", "attached");
    const types = c.events.map(e => e.type);
    expect(types.indexOf("turn_catchup")).toBeLessThan(types.indexOf("app_conversation_attached"));
    // And again on the same connection: a second catch-up, which only restates what it has.
    c.send({ type: "attach_app_conversation", reqId: "a2", convId });
    await c.wait(e => e.type === "app_conversation_attached" && e.reqId === "a2", "attached again");
    first.open();
    await until(() => reached.has("second"), "the sync");
    second.open();
    const result = await a.wait(e => e.type === "turn_result" && e.reqId === "s", "turn_result");
    await c.wait(e => e.type === "turn_result", "the owner's turn_result");

    const view = follow(c.events, convId);
    expect(view.catchups).toHaveLength(3);
    expect(textOf(view.catchups[0].blocks)).toBe("draft that goes away");
    expect(textOf(view.catchups[2].blocks)).toBe("kept ");
    expect(view.stale).toBe(0);
    expect(view.text).toBe("kept text end");
    expect(result.blocks).toEqual(view.blocks);
  });

  test("a replayed turn's catch-up starts with what the interrupted one showed", async () => {
    const hold = gate();
    const reached = new Set<string>();
    script = (async (_provider, _messages, _model, cb) => {
      cb.onBlockStart?.("text");
      cb.onText("and the rest");
      reached.add("replay");
      await hold.promise;
      return reply("and the rest");
    }) as typeof streamMessage;
    const { conn: a } = await connectApp();
    const convId = await createConversation(a);
    const startedAt = Date.now();
    // What a daemon restart left: the prompt and the part of the reply it saved.
    convStore.appendMessages(convId, [
      { role: "user", content: "go", metadata: { startedAt, endedAt: startedAt, model: "gpt-5.4", tokens: 0 } },
      { role: "assistant", content: [{ type: "text", text: "the first part, " }], metadata: { startedAt, endedAt: startedAt + 1, model: "gpt-5.4", tokens: 1 } },
    ]);
    const replay = orchestrateReplayConversation(server, null, undefined, convId, Date.now(), callbacks);
    await until(() => reached.has("replay"), "the replay");
    const catchup = await a.wait(e => e.type === "turn_catchup", "the replay's catch-up");
    expect(catchup).toMatchObject({ turnId: String(startedAt), streamOffset: 1, blocks: [{ type: "text", text: "the first part, " }] });
    hold.open();
    await replay;
    const result = await a.wait(e => e.type === "turn_result" && e.turnId === String(startedAt), "turn_result");
    const view = follow(a.events.slice(a.events.indexOf(catchup)), convId);
    expect(view.stale).toBe(0);
    expect(view.text).toBe("the first part, and the rest");
    expect(result.blocks).toEqual(view.blocks);
    expect(result.text).toBe("and the rest");
  });

  test("a client that did not ask gets no catch-ups and no turn blocks", async () => {
    const hold = gate();
    const reached = new Set<string>();
    script = (async (_provider, _messages, _model, cb) => {
      cb.onBlockStart?.("text");
      cb.onText("hello");
      reached.add("streaming");
      await hold.promise;
      return reply("hello");
    }) as typeof streamMessage;
    const { conn: a, welcome } = await connectApp(undefined, []);
    expect(welcome.turnCatchup).toBeUndefined();
    const convId = await createConversation(a);
    a.send({ type: "send_message", reqId: "s", convId, text: "go", startedAt: Date.now(), awaitResult: true });
    await until(() => reached.has("streaming"), "the stream");
    a.send({ type: "attach_app_conversation", reqId: "a", convId });
    await a.wait(e => e.type === "app_conversation_attached", "attached");
    hold.open();
    const result = await a.wait(e => e.type === "turn_result", "turn_result");
    expect(a.events.some(e => e.type === "turn_catchup")).toBe(false);
    expect(result.blocks).toBeUndefined();
  });
});
