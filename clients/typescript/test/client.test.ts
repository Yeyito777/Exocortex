import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { connect, run, findSocket, ExocortexError, INSTALL_COMMAND, type AppTool, type Client, type StreamEvent } from "../src/index.ts";
import { startFake, type Fake } from "./fake.ts";

let fakes: Fake[] = [];
let clients: Client[] = [];
async function fake(args: string[] = []) { const f = await startFake(args); fakes.push(f); return f; }
async function client(socket: string, extra: Record<string, unknown> = {}) {
  const c = await connect({ app: "test-app", socket, ...extra });
  clients.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(clients.map(c => c.close()));
  clients = [];
  await Promise.all(fakes.map(f => f.stop()));
  fakes = [];
});

const schema = { type: "object", properties: { word: { type: "string" } }, required: ["word"] };
const lookup = (handler: AppTool["handler"]): AppTool => ({ name: "lookup", description: "Look a word up.", inputSchema: schema, handler });

/** Send a test-only command (fake_restart, fake_drop) on a connection of its own. */
function admin(socket: string, command: Record<string, unknown>): Promise<void> {
  return new Promise((done, fail) => {
    const conn = netConnect(socket, () => conn.write(JSON.stringify(command) + "\n"));
    conn.once("data", () => conn.destroy());
    conn.once("close", () => done());
    conn.once("error", fail);
  });
}

/** Resolves once `check` holds; fails fast after `ms`. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

describe("one-shot", () => {
  test("run() connects, runs an ephemeral conversation and closes", async () => {
    const { socket } = await fake();
    const result = await run("hello", { app: "test-app", socket, system: "Be brief." });
    expect(result.text).toBe("echo: hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
    const c = await client(socket);
    expect(await c.list()).toEqual([]);
  });

  test("run with an app tool, sync and async handlers", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const seen: unknown[] = [];
    const sync = await c.run('tool lookup {"word":"zorp"}', { tools: { app: [lookup(input => { seen.push(input); return `${input.word}: a small blue frog`; })] } });
    expect(sync.text).toBe("lookup -> zorp: a small blue frog");
    expect(seen).toEqual([{ word: "zorp" }]);
    const asyncResult = await c.run('tool lookup {"word":"x"}', { tools: { app: [lookup(async () => ({ count: 2 }))] } });
    expect(asyncResult.text).toBe('lookup -> {"count":2}');
  });

  test("a throwing handler and an explicit isError reach the model as errors", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const thrown = await c.run('tool lookup {"word":"x"}', { tools: { app: [lookup(async () => { throw new Error("boom"); })] } });
    expect(thrown.text).toBe("lookup error -> boom");
    const flagged = await c.run('tool lookup {"word":"x"}', { tools: { app: [lookup(() => ({ output: "nope", isError: true }))] } });
    expect(flagged.text).toBe("lookup error -> nope");
  });

  test("runStream yields text deltas and tool events", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const stream = c.runStream('tool lookup {"word":"a"}', { tools: { app: [lookup(() => "b")] } });
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    expect(events.map(e => e.type)).toEqual(["tool_call", "tool_result", "text", "text"]);
    expect(events.filter(e => e.type === "text").map(e => (e as any).text).join("")).toBe(result.text);
  });

  test("failed turns and validation errors", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const failed = await c.run("fail");
    expect(failed.stopReason).toBe("error");
    expect(failed.error).toBe("fake failure");
    const bad = c.run("hi", { tools: { builtin: ["teleport"] } });
    await expect(bad).rejects.toThrow(/teleport/);
  });
});

describe("conversations", () => {
  test("send keeps history; stream text(); abort", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "temporary", title: "t", model: "m1" });
    expect(conv.info.lifetime).toBe("temporary");
    expect((await conv.send("count")).text).toBe("turns: 1");
    let streamed = "";
    for await (const piece of conv.stream("count").text()) streamed += piece;
    expect(streamed).toBe("turns: 2");

    const hanging = conv.stream("hang");
    for await (const event of hanging) { if (event.type === "text") break; }
    await conv.abort();
    expect((await hanging.result).stopReason).toBe("aborted");

    const busy = conv.send("hang");
    await expect(conv.send("again")).rejects.toThrow(/Already streaming/);
    await conv.abort();
    await busy;
  });

  test("tool calls are cancelled on timeout", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    let reason: unknown;
    const tool: AppTool = { ...lookup(() => ""), timeoutMs: 150, handler: (_input, ctx) => new Promise(done => ctx.signal.addEventListener("abort", () => { reason = ctx.signal.reason; done("late"); })) };
    const conv = await c.conversation({ lifetime: "ephemeral", tools: { app: [tool] } });
    expect((await conv.send('tool lookup {"word":"x"}')).text).toBe("lookup error -> lookup timed out");
    expect(reason).toBe("timeout");
  });

  test("saved conversations outlive the client; attach and list from another; delete", async () => {
    const { socket } = await fake();
    const first = await client(socket);
    const conv = await first.conversation({ lifetime: "saved", tools: { builtin: ["read"], app: [lookup(() => "one")] } });
    expect((await conv.send('tool lookup {"word":"x"}')).text).toBe("lookup -> one");
    await first.close();

    const second = await client(socket);
    expect((await second.list()).map(i => i.convId)).toEqual([]);
    expect((await second.list({ includeSaved: true })).map(i => i.convId)).toEqual([conv.id]);
    const again = await second.attach(conv.id, { tools: [lookup(() => "two")] });
    expect((await again.send('tool lookup {"word":"x"}')).text).toBe("lookup -> two");
    expect((await again.send("count")).text).toBe("turns: 3");
    await again.delete();
    expect(again.ended).toBe("deleted");
    expect(await second.list({ includeSaved: true })).toEqual([]);
    await expect(again.send("hi")).rejects.toThrow(/ended/);
  });

  test("an ephemeral conversation ends with its connection", async () => {
    const { socket } = await fake();
    const owner = await client(socket);
    const watcher = await client(socket);
    const conv = await owner.conversation({ lifetime: "ephemeral" });
    expect((await watcher.list()).map(i => i.convId)).toEqual([conv.id]);
    await expect(watcher.attach(conv.id)).rejects.toThrow(/ephemeral/);
    await owner.close();
    for (let i = 0; i < 50 && (await watcher.list()).length; i++) await Bun.sleep(20);
    expect(await watcher.list()).toEqual([]);
  });
});

describe("reconnect", () => {
  {
    test("a daemon restart mid-turn: re-attach, the tool runs, send resolves from the owner turn_result", async () => {
      const { socket } = await fake();
      const c = await client(socket);
      let calls = 0;
      const conv = await c.conversation({ lifetime: "temporary", tools: { app: [lookup(input => { calls++; return `got ${input.word}`; })] } });
      const result = await conv.send('restart tool lookup {"word":"w"}');
      expect(result.text).toBe("lookup -> got w");
      expect(calls).toBe(1);
      expect(result.turnId).toBeDefined();
      expect((await conv.send("count")).text).toBe("turns: 2");
    });
  }

  test("a turn that ended while the client was away resolves from the attach answer", async () => {
    const { socket } = await fake(["--refuse-after-restart-ms", "400"]);
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "saved" });
    const result = await conv.send("restart echo quick");
    expect(result.text).toBe("echo: echo quick");
    expect(result.turnId).toBeDefined();
  });

  test("an ephemeral conversation and a one-shot run survive a graceful restart", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const session = c.session;
    expect(session).toBeTruthy();
    const conv = await c.conversation({ lifetime: "ephemeral" });
    expect((await conv.send("restart echo")).text).toBe("echo: echo");
    expect(c.session).toBe(session!);
    expect((await conv.send("count")).text).toBe("turns: 2");
    expect((await c.run("restart again")).text).toBe("echo: again");
  });

  test("requests and sends made while reconnecting wait for the connection", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "ephemeral" });
    await admin(socket, { type: "fake_restart", downMs: 600 });
    await until(() => (c as any).connected === false);
    expect((await conv.send("count")).text).toBe("turns: 1");
    expect((await c.list()).map(i => i.convId)).toEqual([conv.id]);
    const fresh = await c.conversation({ lifetime: "temporary" });
    await admin(socket, { type: "fake_drop" });
    expect((await fresh.send("count")).text).toBe("turns: 1");
    expect((await c.list()).map(i => i.convId).sort()).toEqual([conv.id, fresh.id].sort());
  });

  test("a dropped connection keeps the ephemeral conversation and its running tool call", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const answered: string[] = [];
    let started = false;
    const slow = lookup(async input => { started = true; await Bun.sleep(300); answered.push(input.word); return `kept ${input.word}`; });
    const conv = await c.conversation({ lifetime: "ephemeral", tools: { app: [slow] } });
    const turn = conv.stream('tool lookup {"word":"q"}');
    await until(() => started);
    await admin(socket, { type: "fake_drop" });
    expect((await turn.result).text).toBe("lookup -> kept q");
    expect(answered).toEqual(["q"]);
  });

  test("a crash loses the conversations; a one-shot run runs again on a new one", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "ephemeral" });
    const hanging = conv.stream("hang");
    for await (const event of hanging) if (event.type === "text") break;
    const calls: unknown[] = [];
    const crashOnce = lookup(async input => {
      calls.push(input);
      if (calls.length > 1) return "second try";
      await admin(socket, { type: "fake_restart", crash: true, downMs: 200 });
      await Bun.sleep(200);
      return "too late";
    });
    const result = await c.run('tool lookup {"word":"x"}', { tools: { app: [crashOnce] } });
    expect(result.text).toBe("lookup -> second try");
    expect(calls.length).toBe(2);
    const error = await hanging.result.catch(e => e);
    expect(error.code).toBe("lost");
    expect(conv.ended).toBe("lost");
  });

  test("a connection that drops again while conversations are re-attached still reconnects", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const convs = await Promise.all([1, 2, 3, 4].map(() => c.conversation({ lifetime: "temporary" })));
    let armed = 0;
    c.onEvent(event => {
      // The first re-attach answer after the first drop: drop again while the others are in flight.
      if (event.type === "app_conversation_attached" && armed === 1) { armed = 2; void admin(socket, { type: "fake_drop" }); }
    });
    armed = 1;
    await admin(socket, { type: "fake_drop" });
    const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error("send hung")), 6000));
    expect((await Promise.race([convs[0].send("count"), timeout])).text).toBe("turns: 1");
    expect(armed).toBe(2);
  });

  test("route passes through to the conversation", async () => {
    const { socket } = await fake();
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "temporary", route: { credits: "never", whenLimited: "error" } });
    expect(conv.info.route).toEqual({ credits: "never", whenLimited: "error" });
    expect((await c.run("hi", { route: { credits: "allow" } })).text).toBe("echo: hi");
    const state = await c.request({ type: "fake_state" }, e => e.type === "fake_state");
    expect(state.received.find((cmd: any) => cmd.type === "app_run").route).toEqual({ credits: "allow" });
  });

  test("close() ends the session's ephemeral conversations at once", async () => {
    const { socket } = await fake();
    const owner = await client(socket);
    const watcher = await client(socket);
    await owner.conversation({ lifetime: "ephemeral" });
    await owner.close();
    expect(await watcher.list()).toEqual([]);
  });
});

describe("reconnect to a daemon without sessions", () => {
  test("a turn whose result it did not keep is reported lost, not hung", async () => {
    const { socket } = await fake(["--refuse-after-restart-ms", "400", "--no-owner-results", "--no-sessions"]);
    const c = await client(socket);
    expect(c.session).toBeNull();
    const conv = await c.conversation({ lifetime: "saved" });
    const error = await conv.send("restart echo quick").catch(e => e);
    expect(error.code).toBe("result_lost");
    expect((await conv.send("count")).text).toBe("turns: 2");
  });

  test("an ephemeral conversation is lost on a restart; the client keeps working", async () => {
    const { socket } = await fake(["--no-sessions"]);
    const c = await client(socket);
    const conv = await c.conversation({ lifetime: "ephemeral" });
    const error = await conv.send("restart echo").catch(e => e);
    expect(error.code).toBe("lost");
    expect((await c.run("after")).text).toBe("echo: after");
  });
});

describe("connecting", () => {
  test("refuses a daemon with another app API version", async () => {
    const { socket } = await fake(["--api-version", "2"]);
    const error = await connect({ app: "test-app", socket }).catch(e => e);
    expect(error).toBeInstanceOf(ExocortexError);
    expect(error.code).toBe("incompatible");
  });

  test("a daemon that never answers app_welcome is too old", async () => {
    const { socket } = await fake(["--no-welcome"]);
    const error = await connect({ app: "test-app", socket, welcomeTimeoutMs: 200 }).catch(e => e);
    expect(error.code).toBe("too_old");
    expect(error.message).toContain(INSTALL_COMMAND);
  });

  test("discovery: EXOCORTEX_SOCKET, then `exocortexd socket`, else the install line", async () => {
    const f = await fake();
    const saved = { socket: process.env.EXOCORTEX_SOCKET, path: process.env.PATH };
    try {
      process.env.EXOCORTEX_SOCKET = f.socket;
      expect(await findSocket()).toBe(f.socket);
      delete process.env.EXOCORTEX_SOCKET;
      process.env.PATH = f.dir;
      const missing = await findSocket().catch(e => e);
      expect(missing.code).toBe("not_installed");
      expect(missing.message).toContain(INSTALL_COMMAND);
      const bin = join(f.dir, "exocortexd");
      writeFileSync(bin, `#!/bin/sh\n[ "$1" = socket ] && echo ${f.socket}\n`);
      chmodSync(bin, 0o755);
      expect(await findSocket()).toBe(f.socket);
      const c = await connect({ app: "test-app" });
      clients.push(c);
      expect(c.welcome.instance).toBe("fake");
      writeFileSync(bin, `#!/bin/sh\n[ "$1" = socket ] && echo ${f.dir}/gone.sock\n[ "$1" = doctor ] && echo '{"ok":false,"problems":[{"id":"daemon","severity":"error","message":"The daemon is not running.","fix":"exocortexd start"}]}'\nexit 0\n`);
      const down = await connect({ app: "test-app" }).catch(e => e);
      expect(down.code).toBe("not_running");
      expect(down.message).toContain("The daemon is not running. Fix: exocortexd start");
    } finally {
      if (saved.socket === undefined) delete process.env.EXOCORTEX_SOCKET; else process.env.EXOCORTEX_SOCKET = saved.socket;
      process.env.PATH = saved.path;
    }
  });

  test("a stopped daemon is reported as not running", async () => {
    const f = await fake();
    await f.stop();
    const error = await connect({ app: "test-app", socket: f.socket }).catch(e => e);
    expect(error.code).toBe("not_running");
  });
});
