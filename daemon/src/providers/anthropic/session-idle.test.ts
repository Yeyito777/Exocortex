import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { StreamCallbacks } from "../types";
import {
  claudeSessionKey,
  closeAllClaudeCodeSessions,
  configureClaudeCodeSessions,
  openClaudeCodeSession,
  processTreeRss,
  setClaudeIdlePolicyForTest,
  type ClaudeCodeSession,
  type ClaudeRuntime,
} from "./session";
import type { ClaudeRelay } from "./relay-client";
import type { RelayHello } from "./relay-protocol";
import { createClaudeStreamState } from "./stream";

const SESSION = "33333333-3333-3333-3333-333333333333";
const KEY = claudeSessionKey("claude-opus-5-5", "high", "/work");

/** Stands in for a Claude Code process: emits what a test scripts. */
class FakeRuntime implements AsyncIterable<unknown> {
  closed = false;
  private queue: unknown[] = [];
  private notify: (() => void) | null = null;
  constructor(input: AsyncIterable<SDKUserMessage>) {
    void (async () => { for await (const _ of input) { /* sent */ } })();
  }
  emit(...messages: unknown[]): void {
    this.queue.push(...messages);
    this.notify?.();
  }
  async interrupt() { return {}; }
  async stopTask() {}
  close(): void {
    this.closed = true;
    this.notify?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.queue.length > 0) {
        yield this.queue.shift();
        continue;
      }
      await new Promise<void>((resolve) => { this.notify = resolve; });
      this.notify = null;
    }
  }
}

const text = (uuid: string) => ({ type: "assistant", uuid, session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "text", text: "done" }] } });
const result = (promptUuid: string) => ({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: SESSION, user_message_uuid: promptUuid, user_message_uuids: [promptUuid] });
const tasks = (...ids: string[]) => ({ type: "system", subtype: "background_tasks_changed", session_id: SESSION, tasks: ids.map(id => ({ task_id: id, task_type: "local_bash", description: id })) });
const callbacks: StreamCallbacks = { onText: () => {}, onThinking: () => {} };

/** Polls until `done` holds, failing after about a second. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

let counter = 0;

/** A process (optionally behind a relay whose pid is `pid`) that has finished one turn. */
async function idleProcess(options: { pid?: number; extra?: unknown[] } = {}): Promise<{ session: ClaudeCodeSession; runtime: FakeRuntime }> {
  const convId = `claude-idle-test-${Date.now()}-${counter++}`;
  const relay = options.pid === undefined ? null : { hello: null as RelayHello | null, commit() {}, delivered() {}, detach() {}, async terminate() {} };
  let runtime: FakeRuntime | null = null;
  const session = openClaudeCodeSession(convId, KEY, (input) => {
    runtime = new FakeRuntime(input);
    return runtime as unknown as ClaudeRuntime;
  }, relay ? { relay: relay as unknown as ClaudeRelay } : {});
  // A launched relay says hello once it runs.
  if (relay) relay.hello = hello({ pid: options.pid, pending: false });
  const promptUuid = `p-${counter}`;
  const turn = session.run(createClaudeStreamState(callbacks, "/work", promptUuid), [{ type: "text", text: "hi" }], undefined, undefined);
  await Bun.sleep(0);
  runtime!.emit(...(options.extra ?? []), text(`a-${counter}`), result(promptUuid));
  await turn;
  return { session, runtime: runtime! };
}

function hello(overrides: Partial<RelayHello> = {}): RelayHello {
  return {
    event: "hello", version: 1, pid: 1,
    meta: { convId: "unused", key: KEY, cwd: "/work", hostTools: [], resume: null },
    resume: { sessionId: SESSION, resumeAt: "u1" }, delivered: [], pending: false, taskStarts: {},
    ...overrides,
  };
}

configureClaudeCodeSessions({ tasksChanged: () => {}, wake: () => true, cancelWake: () => {} });

beforeEach(() => setClaudeIdlePolicyForTest({ keepMs: 60_000, maxIdle: 10, maxRssBytes: 1e15 }, () => 0));
afterEach(() => {
  closeAllClaudeCodeSessions("test cleanup");
  setClaudeIdlePolicyForTest(null);
});

describe("idle Claude Code processes", () => {
  test("stay after their turn and close once idle for the policy's time", async () => {
    setClaudeIdlePolicyForTest({ keepMs: 40, maxIdle: 10, maxRssBytes: 1e15 }, () => 0);
    const { session } = await idleProcess();
    expect(session.isClosed).toBe(false);
    expect(session.idleFor).not.toBeNull();
    await until(() => session.isClosed);
  });

  test("past the count cap, the one idle longest closes", async () => {
    setClaudeIdlePolicyForTest({ keepMs: 60_000, maxIdle: 2, maxRssBytes: 1e15 }, () => 0);
    const first = await idleProcess();
    await Bun.sleep(2);
    const second = await idleProcess();
    await Bun.sleep(2);
    expect(first.session.isClosed).toBe(false);
    const third = await idleProcess();
    expect(first.session.isClosed).toBe(true);
    expect(second.session.isClosed).toBe(false);
    expect(third.session.isClosed).toBe(false);
  });

  test("past the memory cap, idle processes close idle longest first; busy ones only count", async () => {
    const rss = new Map([[101, 300], [102, 300], [103, 300], [104, 300]]);
    setClaudeIdlePolicyForTest({ keepMs: 60_000, maxIdle: 10, maxRssBytes: 1000 }, pid => rss.get(pid) ?? null);
    // A process with a background task is busy: never closed for room.
    const busy = await idleProcess({ pid: 101, extra: [tasks("b1")] });
    expect(busy.session.idleFor).toBeNull();
    const a = await idleProcess({ pid: 102 });
    await Bun.sleep(2);
    const b = await idleProcess({ pid: 103 });
    await Bun.sleep(2);
    expect([busy, a, b].map(p => p.session.isClosed)).toEqual([false, false, false]);
    // 4 × 300 > 1000: the oldest idle one goes.
    const c = await idleProcess({ pid: 104 });
    expect([busy, a, b, c].map(p => p.session.isClosed)).toEqual([false, true, false, false]);
  });

  test("an idle timer leaves a process that has since become busy, and going idle again does not extend it", async () => {
    setClaudeIdlePolicyForTest({ keepMs: 60, maxIdle: 10, maxRssBytes: 1e15 }, () => 0);
    const { session, runtime } = await idleProcess();
    const idleAt = Date.now();
    runtime.emit(tasks("b1"));
    await until(() => session.idleFor === null);
    await Bun.sleep(90);
    expect(session.isClosed).toBe(false);
    // The task ends: a fresh idle wait starts now.
    runtime.emit(tasks());
    await until(() => session.idleFor !== null);
    runtime.emit(tasks());
    await until(() => session.isClosed);
    expect(Date.now() - idleAt).toBeGreaterThanOrEqual(150);
  });

  test("an adopted process with nothing running is idle from adoption; one whose relay saw tasks is not", async () => {
    setClaudeIdlePolicyForTest({ keepMs: 40, maxIdle: 10, maxRssBytes: 1e15 }, () => 0);
    const adopt = (taskStarts: Record<string, number>) => {
      const relay = { hello: hello({ pending: false, taskStarts }), commit() {}, delivered() {}, detach() {}, async terminate() {} };
      return openClaudeCodeSession(`claude-idle-adopted-${counter++}`, KEY, input => new FakeRuntime(input) as unknown as ClaudeRuntime, { relay: relay as unknown as ClaudeRelay });
    };
    const quiet = adopt({});
    const working = adopt({ b1: Date.now() });
    await until(() => quiet.isClosed);
    await Bun.sleep(60);
    expect(working.isClosed).toBe(false);
  });

  test("measures a process tree's memory from /proc", () => {
    if (process.platform !== "linux") return;
    expect(processTreeRss(process.pid)).toBeGreaterThan(1024 * 1024);
    expect(processTreeRss(2 ** 30)).toBeNull();
  });
});
