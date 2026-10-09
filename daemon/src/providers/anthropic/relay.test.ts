import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE } from "../../abort";
import { ClaudeRelay, reconnectRelays } from "./relay-client";
import type { RelayMeta } from "./relay-protocol";

/** Stands in for Claude Code: prints the lines it is told to, echoes everything else it is sent. */
const FAKE_CLAUDE = `
import { createInterface } from "node:readline";
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "script") { for (const entry of message.lines) out(entry); return; }
  if (message.type === "exit") process.exit(message.code);
  out({ type: "echo", received: message });
});
process.stdin.on("end", () => process.exit(0));
`;

const dir = mkdtempSync(join(tmpdir(), "exocortex-relay-test-"));
const fakeClaude = join(dir, "fake-claude.mjs");
writeFileSync(fakeClaude, FAKE_CLAUDE);

const meta: RelayMeta = { convId: "relay-test", key: "key", cwd: dir, hostTools: [], resume: { sessionId: "s0", resumeAt: "r0" } };
const live: ClaudeRelay[] = [];

type Message = Record<string, unknown>;

/** Reads a relay's Claude Code output as messages. */
function reader(relay: ClaudeRelay) {
  const received: Message[] = [];
  let notify: (() => void) | null = null;
  createInterface({ input: relay.stdout }).on("line", (line) => {
    received.push(JSON.parse(line) as Message);
    notify?.();
  });
  return {
    received,
    async until(predicate: (message: Message) => boolean): Promise<Message> {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = received.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out; received ${JSON.stringify(received)}`);
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

function launch(): ClaudeRelay {
  const relay = new ClaudeRelay().launch({ command: process.execPath, args: [fakeClaude], cwd: dir, env: { ...process.env }, signal: new AbortController().signal }, meta);
  live.push(relay);
  return relay;
}

function write(relay: ClaudeRelay, message: Message): void {
  relay.stdin.write(`${JSON.stringify(message)}\n`);
}

async function reattach(): Promise<{ relay: ClaudeRelay; output: ReturnType<typeof reader> }> {
  const [relay] = await reconnectRelays();
  expect(relay).toBeDefined();
  live.push(relay);
  return { relay, output: reader(relay) };
}

const assistant = (uuid: string) => ({ type: "assistant", uuid, session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: uuid }] } });
const toolResult = (uuid: string) => ({ type: "user", uuid, session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
const delta = (uuid: string) => ({ type: "stream_event", uuid, session_id: "s1", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } });
const messageStart = (uuid: string) => ({ type: "stream_event", uuid, session_id: "s1", parent_tool_use_id: null, event: { type: "message_start", message: { usage: { input_tokens: 5 } } } });
const result = (uuid: string, promptUuid: string) => ({ type: "result", subtype: "success", uuid, session_id: "s1", user_message_uuids: [promptUuid] });
const running = { type: "system", subtype: "session_state_changed", state: "running", uuid: "state-running", session_id: "s1" };
const idle = { type: "system", subtype: "session_state_changed", state: "idle", uuid: "state-idle", session_id: "s1" };

afterEach(async () => {
  await Promise.all(live.splice(0).map(relay => relay.terminate()));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Claude Code relay", () => {
  test("passes traffic through, and keeps the process running when the daemon lets go", async () => {
    const first = launch();
    const output = reader(first);
    write(first, { type: "hello-claude" });
    expect(await output.until(message => message.type === "echo")).toMatchObject({ received: { type: "hello-claude" } });
    first.detach();
    expect(first.exitCode).toBe(0);

    const { relay, output: replayed } = await reattach();
    expect(relay.hello).toMatchObject({ meta, resume: meta.resume, delivered: [], pending: false });
    // The echo was never committed, so it is replayed.
    expect(await replayed.until(message => message.type === "echo")).toMatchObject({ exocortex_replayed: true });
    write(relay, { type: "still-there" });
    expect(await replayed.until(message => (message.received as Message | undefined)?.type === "still-there")).toBeDefined();
  });

  test("replays only what the daemon did not commit, without finished deltas", async () => {
    const first = launch();
    const output = reader(first);
    write(first, { type: "script", lines: [running, messageStart("m1"), delta("d1"), assistant("a1"), toolResult("u1"), messageStart("m2"), delta("d2"), assistant("a2"), delta("d3")] });
    await output.until(message => message.uuid === "d3");
    first.commit("u1", { sessionId: "s1", resumeAt: "u1" });
    first.delivered(["k1"]);
    first.detach();

    const { relay, output: replayed } = await reattach();
    expect(relay.hello).toMatchObject({ resume: { sessionId: "s1", resumeAt: "u1" }, delivered: ["k1"], pending: true });
    await replayed.until(message => message.uuid === "d3");
    expect(replayed.received.map(message => message.uuid)).toEqual(["m2", "a2", "d3"]);
    expect(replayed.received.every(message => message.exocortex_replayed === true)).toBe(true);

    // A commit with a new resume point forgets what was delivered before it.
    write(relay, { type: "script", lines: [toolResult("u2"), result("res1", "p1"), idle] });
    await replayed.until(message => message.uuid === "state-idle");
    relay.commit("res1", { sessionId: "s1", resumeAt: "u2" });
    relay.detach();
    const again = await reattach();
    expect(again.relay.hello).toMatchObject({ resume: { sessionId: "s1", resumeAt: "u2" }, delivered: [], pending: false });
  });

  test("a turn is pending from its prompt to its result, not while only background agents run", async () => {
    const first = launch();
    const output = reader(first);
    write(first, { type: "user", uuid: "p1", message: { role: "user", content: "go" }, parent_tool_use_id: null });
    await output.until(message => message.type === "echo");
    first.detach();

    const second = await reattach();
    expect(second.relay.hello).toMatchObject({ pending: true });
    const agents = { type: "system", subtype: "background_tasks_changed", uuid: "tasks", tasks: [{ task_id: "agent-1", task_type: "local_agent", description: "research" }] };
    write(second.relay, { type: "script", lines: [running, assistant("a1"), agents, result("res1", "p1")] });
    await second.output.until(message => message.uuid === "res1");
    second.relay.commit("res1", { sessionId: "s1", resumeAt: "a1" });
    second.relay.detach();

    const third = await reattach();
    expect(third.relay.hello).toMatchObject({ pending: false });
    expect(Object.keys(third.relay.hello!.taskStarts)).toEqual(["agent-1"]);
  });

  test("a queued message withdrawn before Claude Code took it in leaves no turn pending", async () => {
    const first = launch();
    const output = reader(first);
    write(first, { type: "user", uuid: "q1", priority: "next", message: { role: "user", content: "and test it" }, parent_tool_use_id: null });
    await output.until(message => message.type === "echo");
    write(first, { type: "script", lines: [{ type: "command_lifecycle", command_uuid: "q1", state: "cancelled", uuid: "c1", session_id: "s1" }] });
    await output.until(message => message.uuid === "c1");
    first.detach();

    const { relay } = await reattach();
    expect(relay.hello).toMatchObject({ pending: false });
  });

  test("drops the rest of an interrupted turn up to the result that ends it", async () => {
    const first = launch();
    const output = reader(first);
    write(first, { type: "script", lines: [running, assistant("a1")] });
    await output.until(message => message.uuid === "a1");
    first.commit("a1", null, { promptUuid: "p1" });
    write(first, { type: "script", lines: [assistant("a2"), result("res-other", "p0"), result("res1", "p1"), assistant("b1")] });
    await output.until(message => message.uuid === "b1");
    first.detach();

    const { output: replayed } = await reattach();
    await replayed.until(message => message.uuid === "b1");
    expect(replayed.received.map(message => message.uuid)).toEqual(["b1"]);
  });

  test("answers Exocortex tool calls a departed daemon was running, and redelivers other requests", async () => {
    const first = launch();
    const output = reader(first);
    const toolCall = { type: "control_request", request_id: "r1", request: { subtype: "mcp_message", server_name: "exocortex", message: { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "chrono" } } } };
    const listing = { type: "control_request", request_id: "r2", request: { subtype: "mcp_message", server_name: "exocortex", message: { jsonrpc: "2.0", id: 8, method: "tools/list" } } };
    write(first, { type: "script", lines: [toolCall, listing] });
    await output.until(message => message.request_id === "r2");
    first.detach();

    const { output: replayed } = await reattach();
    const answer = await replayed.until(message => message.type === "echo");
    expect(answer.received).toMatchObject({
      type: "control_response",
      response: { request_id: "r1", response: { mcp_response: { id: 7, result: { isError: true, content: [{ text: DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE }] } } } },
    });
    expect(await replayed.until(message => message.request_id === "r2")).toMatchObject(listing);
    expect(replayed.received.some(message => message.request_id === "r1")).toBe(false);
  });

  test("reports Claude Code's exit and goes away", async () => {
    const relay = launch();
    write(relay, { type: "exit", code: 3 });
    await relay.exited;
    expect(relay.exitCode).toBe(3);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await reconnectRelays()).toEqual([]);
  });
});
