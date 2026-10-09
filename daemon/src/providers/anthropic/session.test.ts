import { afterEach, describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isDetachedTurnError } from "../../abort";
import { getConversationTasks, stopBackgroundTask } from "../../conversation-activity";
import type { ApiMessage } from "../../messages";
import type { ProviderRound, QueuedInput, QueuedInputSource, StreamCallbacks } from "../types";
import {
  claudeSessionKey,
  closeAllClaudeCodeSessions,
  configureClaudeCodeSessions,
  getClaudeCodeSession,
  openClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeRuntime,
  deliveryKey,
  historyMark,
} from "./session";
import type { ClaudeRelay } from "./relay-client";
import type { RelayHello, RelayResumePoint } from "./relay-protocol";
import { createClaudeStreamState } from "./stream";

const SESSION = "22222222-2222-2222-2222-222222222222";
const KEY = claudeSessionKey("claude-opus-5-5", "high", "/work");

/** Stands in for a Claude Code process: records what it is sent, emits what a test scripts. */
class FakeRuntime implements AsyncIterable<unknown> {
  prompts: SDKUserMessage[] = [];
  interrupts = 0;
  interruptOptions: unknown[] = [];
  withdrawn: string[] = [];
  /** What cancelAsyncMessage answers: false once Claude Code has taken the message in. */
  withdrawable = true;
  stopped: string[] = [];
  closed = false;
  private queue: unknown[] = [];
  private notify: (() => void) | null = null;

  constructor(input: AsyncIterable<SDKUserMessage>) {
    void (async () => {
      for await (const message of input) this.prompts.push(message);
    })();
  }

  emit(...messages: unknown[]): void {
    this.queue.push(...messages);
    this.notify?.();
  }

  async interrupt(options?: unknown) {
    this.interrupts++;
    this.interruptOptions.push(options);
    return { still_queued: [] };
  }

  async cancelAsyncMessage(uuid: string) {
    this.withdrawn.push(uuid);
    return this.withdrawable;
  }

  async stopTask(taskId: string) {
    this.stopped.push(taskId);
  }

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const init = { type: "system", subtype: "init", session_id: SESSION };
const text = (uuid: string, value: string) => ({ type: "assistant", uuid, session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "text", text: value }] } });
const call = (uuid: string, id: string, command: string) => ({ type: "assistant", uuid, session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const output = (uuid: string, id: string, value: string) => ({ type: "user", uuid, session_id: SESSION, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: value, is_error: false }] } });
const result = (promptUuid: string | null, origin?: string) => ({
  type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: SESSION,
  ...(promptUuid ? { user_message_uuid: promptUuid, user_message_uuids: [promptUuid] } : {}),
  ...(origin ? { origin: { kind: origin } } : {}),
});
const lifecycle = (uuid: string, state: string) => ({ type: "command_lifecycle", command_uuid: uuid, state, session_id: SESSION });
const answered = (...promptUuids: string[]) => ({ ...result(promptUuids[0]), user_message_uuids: promptUuids });
const tasks = (...live: Array<{ id: string; description: string; type?: string; parent?: string }>) => ({
  type: "system", subtype: "background_tasks_changed", session_id: SESSION,
  tasks: live.map(task => ({
    task_id: task.id, task_type: task.type ?? "local_bash", description: task.description,
    ...(task.parent ? { parent_task_id: task.parent } : {}),
  })),
});
const finished = (id: string) => ({
  type: "system", subtype: "task_notification", session_id: SESSION, task_id: id, status: "completed",
  summary: `Background command "${id}" completed (exit code 0)`, output_file: `/tmp/tasks/${id}.output`,
});

const callbacks = (rounds: ProviderRound[] = []): StreamCallbacks => ({
  onText: () => {},
  onThinking: () => {},
  onProviderRound: (round) => rounds.push(round),
});

/** Stands in for the turn's queue: next-turn messages a test queues, edits and removes. */
class FakeQueue implements QueuedInputSource {
  entries: QueuedInput[] = [];
  private listeners = new Set<() => void>();
  pending() {
    return this.entries.map(entry => ({ ...entry }));
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get subscribed() {
    return this.listeners.size > 0;
  }
  set(...entries: QueuedInput[]) {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

/** Callbacks that take queued input in the way the agent loop does, recording the order of events. */
function takingCallbacks(events: string[], rounds: ProviderRound[] = []): StreamCallbacks {
  return {
    ...callbacks(rounds),
    onProviderRound: (round) => {
      rounds.push(round);
      events.push(`round:${round.messages.map(message => message.role).join(",")}`);
    },
    onQueuedInput: async (inputs) => {
      events.push(`input:${inputs.map(input => input.text).join(",")}`);
      return inputs.map(input => ({ role: "user", content: input.text }));
    },
  };
}

const sentInput = (runtime: FakeRuntime) => runtime.prompts.filter(prompt => prompt.priority === "next");

let convCounter = 0;
const wakes: Array<{ convId: string; text: string; id: string }> = [];
const cancelled: string[] = [];
const changed: string[] = [];

function open(): { convId: string; session: ClaudeCodeSession; runtime: () => FakeRuntime } {
  const convId = `claude-session-test-${Date.now()}-${convCounter++}`;
  let runtime: FakeRuntime | null = null;
  const session = openClaudeCodeSession(convId, KEY, (input) => {
    runtime = new FakeRuntime(input);
    return runtime as unknown as ClaudeRuntime;
  });
  return { convId, session, runtime: () => runtime! };
}

/** Stands in for a relay: records the bookkeeping the session reports. */
class FakeRelay {
  commits: Array<{ through: string | null; resume: RelayResumePoint | null; interrupted?: { promptUuid: string | null } }> = [];
  deliveredKeys: string[] = [];
  detached = false;
  terminated = false;
  constructor(readonly hello: RelayHello | null = null) {}
  commit(through: string | null, resume: RelayResumePoint | null, interrupted?: { promptUuid: string | null }) {
    this.commits.push({ through, resume, ...(interrupted ? { interrupted } : {}) });
  }
  delivered(keys: string[]) {
    this.deliveredKeys.push(...keys);
  }
  detach() {
    this.detached = true;
  }
  async terminate() {
    this.terminated = true;
  }
}

function openWithRelay(relay: FakeRelay, resume: RelayResumePoint | null = null) {
  const convId = `claude-session-test-${Date.now()}-${convCounter++}`;
  let runtime: FakeRuntime | null = null;
  const session = openClaudeCodeSession(convId, KEY, (input) => {
    runtime = new FakeRuntime(input);
    return runtime as unknown as ClaudeRuntime;
  }, { relay: relay as unknown as ClaudeRelay, resume: resume ? { ...resume, cwd: "/work" } : null });
  return { convId, session, runtime: () => runtime! };
}

function adoptedHello(overrides: Partial<RelayHello> = {}): RelayHello {
  return {
    event: "hello",
    version: 1,
    pid: 1,
    meta: { convId: "unused", key: KEY, cwd: "/work", hostTools: [], resume: null },
    resume: { sessionId: SESSION, resumeAt: "u1" },
    delivered: [],
    pending: true,
    taskStarts: {},
    ...overrides,
  };
}

function wakeMessage(wake: { text: string; id: string }): ApiMessage {
  return { role: "user", content: wake.text, metadata: { automation: { kind: "background_task_completion", sourceId: wake.id } } as ApiMessage["metadata"] };
}

/** A first turn that leaves background task b1 running. */
async function startBackgroundTask(session: ClaudeCodeSession, runtime: () => FakeRuntime) {
  const state = createClaudeStreamState(callbacks(), "/work", "p1");
  const turn = session.run(state, [{ type: "text", text: "run it in the background" }], undefined, undefined);
  await tick();
  runtime().emit(init, call("a1", "t1", "sleep 20"), tasks({ id: "b1", description: "Sleep 20 seconds" }), output("u1", "t1", "Command running in background with ID: b1."), text("a2", "started"), result("p1"));
  return turn;
}

configureClaudeCodeSessions({
  tasksChanged: (convId) => changed.push(convId),
  wake: (convId, wakeText, id) => {
    wakes.push({ convId, text: wakeText, id });
    return true;
  },
  cancelWake: (_convId, id) => cancelled.push(id),
});

afterEach(() => {
  closeAllClaudeCodeSessions("test cleanup");
  wakes.length = 0;
  cancelled.length = 0;
  changed.length = 0;
});

describe("Claude Code processes outliving a turn", () => {
  test("a turn that leaves background tasks keeps its process and shows them as the conversation's tasks", async () => {
    const { convId, session, runtime } = open();
    const first = await startBackgroundTask(session, runtime);

    expect(runtime().prompts.map(prompt => String(prompt.uuid))).toEqual(["p1"]);
    expect(first.text).toBe("started");
    expect(session.isClosed).toBe(false);
    expect(getClaudeCodeSession(convId)).toBe(session);
    expect(getConversationTasks(convId)).toMatchObject([{ id: "b1", kind: "background", title: "Sleep 20 seconds" }]);
    expect(changed).toContain(convId);
    expect(session.canContinue(KEY, { sessionId: SESSION, resumeAt: "a2", cwd: "/work" })).toBe(true);

    expect(stopBackgroundTask("b1", true).result).toBe("stopping");
    await tick();
    expect(runtime().stopped).toEqual(["b1"]);
  });

  test("when a task finishes, the turn Claude Code starts is queued as a wake and shown without sending anything", async () => {
    const { convId, session, runtime } = open();
    await startBackgroundTask(session, runtime);

    runtime().emit(finished("b1"), tasks(), init, text("a3", "It finished."), result(null, "task-notification"));
    await tick();
    expect(getConversationTasks(convId)).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("[notification] Background task completed: b1");
    expect(wakes[0].text).toContain("Command: Sleep 20 seconds");
    expect(wakes[0].text).toContain("Output: /tmp/tasks/b1.output");

    expect(session.planInput([wakeMessage(wakes[0])])).toEqual({ kind: "wake" });
    const shown = await session.run(createClaudeStreamState(callbacks(), "/work", null), null, undefined, undefined);
    expect(shown.text).toBe("It finished.");
    expect(runtime().prompts).toHaveLength(1);
    expect(session.canContinue(KEY, { sessionId: SESSION, resumeAt: "a3", cwd: "/work" })).toBe(true);
  });

  test("a finished background agent is reported like an Exocortex subagent; the commands it ran stay its own", async () => {
    const { convId, session, runtime } = open();
    const state = createClaudeStreamState(callbacks(), "/work", "p1");
    const turn = session.run(state, [{ type: "text", text: "spawn an agent" }], undefined, undefined);
    await tick();
    const agent = { id: "a1", description: "JS engine core", type: "local_agent" };
    const command = { id: "b2", description: "Run engine tests", parent: "a1" };
    runtime().emit(init, tasks(agent), tasks(agent, command), text("a2", "spawned"), result("p1"));
    await turn;
    expect(getConversationTasks(convId)).toMatchObject([
      { id: "a1", kind: "background", title: "JS engine core", toolName: "Agent" },
      { id: "b2", kind: "background", title: "Run engine tests", toolName: "Bash" },
    ]);

    runtime().emit(
      finished("b2"),
      tasks(agent),
      { ...finished("a1"), summary: "The engine runs every test." },
      tasks(),
      init,
      text("a3", "The agent is done."),
      result(null, "task-notification"),
    );
    await tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toBe([
      "[notification] Agent completed: a1",
      "Task: JS engine core",
      "",
      "Result:",
      "The engine runs every test.",
      "",
      "Output: /tmp/tasks/a1.output",
    ].join("\n"));
  });

  test("a task Claude Code renames is renamed in the conversation's tasks without restarting its clock", async () => {
    const { convId, session, runtime } = open();
    await startBackgroundTask(session, runtime);
    const [before] = getConversationTasks(convId);
    await new Promise(resolve => setTimeout(resolve, 5));
    runtime().emit(tasks({ id: "b1", description: "Sleep twenty seconds" }));
    await tick();
    expect(getConversationTasks(convId)).toEqual([{ ...before, title: "Sleep twenty seconds" }]);
  });

  test("each turn Claude Code starts by itself gets its own wake, even when they queue up", async () => {
    const { session, runtime } = open();
    const state = createClaudeStreamState(callbacks(), "/work", "p1");
    const first = session.run(state, [{ type: "text", text: "start two" }], undefined, undefined);
    await tick();
    runtime().emit(init, tasks({ id: "b1", description: "build" }, { id: "b2", description: "test" }), text("a1", "started"), result("p1"));
    await first;

    runtime().emit(finished("b1"), init, text("a2", "Build done."), result(null, "task-notification"), finished("b2"), init, text("a3", "Tests done."), result(null, "task-notification"));
    await tick();
    expect(wakes).toHaveLength(1);
    expect(wakes[0].text).toContain("completed: b1");

    expect((await session.run(createClaudeStreamState(callbacks(), "/work", null), null, undefined, undefined)).text).toBe("Build done.");
    expect(wakes).toHaveLength(2);
    expect(wakes[1].text).toContain("completed: b2");
    expect(wakes[1].text).not.toContain("b1");
    expect((await session.run(createClaudeStreamState(callbacks(), "/work", null), null, undefined, undefined)).text).toBe("Tests done.");
  });

  test("later prompts go into the running process, without the notifications it raised itself", async () => {
    const { session, runtime } = open();
    await startBackgroundTask(session, runtime);
    runtime().emit(finished("b1"), init, text("a3", "It finished."), result(null, "task-notification"));
    await tick();
    await session.run(createClaudeStreamState(callbacks(), "/work", null), null, undefined, undefined);

    const deploy: ApiMessage = { role: "user", content: "now deploy" };
    const input = session.planInput([wakeMessage(wakes[0]), deploy]);
    expect(input).toEqual({ kind: "prompt", content: [{ type: "text", text: "now deploy" }], messages: [deploy] });
    expect(session.planInput([wakeMessage(wakes[0])])).toEqual({ kind: "none" });
  });

  test("a prompt turn shows work Claude Code started before it and withdraws that wake", async () => {
    const { session, runtime } = open();
    await startBackgroundTask(session, runtime);
    runtime().emit(finished("b1"), init, text("a3", "It finished."));
    await tick();
    expect(wakes).toHaveLength(1);

    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p2"), [{ type: "text", text: "status?" }], undefined, undefined);
    await tick();
    expect(cancelled).toEqual([wakes[0].id]);
    runtime().emit(result(null, "task-notification"), init, text("a4", "All done."), result("p2"));
    const shown = await turn;
    expect(shown.text).toBe("It finished.\n\nAll done.");
    expect(runtime().prompts.map(prompt => String(prompt.uuid))).toEqual(["p1", "p2"]);
  });

  test("an interrupt with background tasks running stops only the turn and drops the rest of it", async () => {
    const { session, runtime } = open();
    await startBackgroundTask(session, runtime);

    const rounds: ProviderRound[] = [];
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(callbacks(rounds), "/work", "p2"), [{ type: "text", text: "sleep 8" }], undefined, controller.signal);
    await tick();
    runtime().emit(init, call("a3", "t2", "sleep 8"));
    await tick();
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(runtime().interrupts).toBe(1);
    expect(session.isClosed).toBe(false);
    // The running call is kept with an interrupted result.
    expect(rounds.at(-1)?.messages.at(-1)).toMatchObject({ role: "user", content: [{ tool_use_id: "t2", is_error: true }] });

    runtime().emit(output("u3", "t2", "The user doesn't want to proceed with this tool use."), { ...result("p2"), subtype: "error_during_execution", is_error: true });
    await tick();
    expect(wakes).toHaveLength(0);

    const next = session.run(createClaudeStreamState(callbacks(), "/work", "p3"), [{ type: "text", text: "go on" }], undefined, undefined);
    await tick();
    runtime().emit(init, text("a4", "ok"), result("p3"));
    expect((await next).text).toBe("ok");
  });

  test("an interrupt without background tasks keeps the process for a steering message", async () => {
    const { session, runtime } = open();
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p1"), [{ type: "text", text: "write a long essay" }], undefined, controller.signal);
    await tick();
    runtime().emit(init, text("a1", "Once upon"));
    await tick();
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(runtime().interrupts).toBe(1);
    expect(session.isClosed).toBe(false);

    // The steering turn's prompt follows the interrupted turn's result.
    const steer = session.run(createClaudeStreamState(callbacks(), "/work", "p2"), [{ type: "text", text: "make it short" }], undefined, undefined);
    await tick();
    runtime().emit({ ...result("p1"), subtype: "error_during_execution", is_error: true }, init, text("a2", "Short."), result("p2"));
    expect((await steer).text).toBe("Short.");
    expect(runtime().prompts.map(prompt => String(prompt.uuid))).toEqual(["p1", "p2"]);
  });

  test("a failed turn ends the process and its tasks", async () => {
    const { convId, session, runtime } = open();
    await startBackgroundTask(session, runtime);
    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p2"), [{ type: "text", text: "again" }], undefined, undefined);
    await tick();
    runtime().emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], user_message_uuid: "p2", session_id: SESSION });
    await expect(turn).rejects.toThrow("boom");
    expect(session.isClosed).toBe(true);
    expect(getConversationTasks(convId)).toEqual([]);
  });

  test("other settings or a rewound history cannot continue the process", async () => {
    const { session, runtime } = open();
    await startBackgroundTask(session, runtime);
    expect(session.canContinue(claudeSessionKey("claude-sonnet-5-5", "high", "/work"), { sessionId: SESSION, resumeAt: "a2", cwd: "/work" })).toBe(false);
    expect(session.canContinue(KEY, { sessionId: SESSION, resumeAt: "u1", cwd: "/work" })).toBe(false);
    expect(session.canContinue(KEY, null)).toBe(false);
  });
});

describe("queued next-turn messages", () => {
  test("are sent once the turn has started and join it at Claude Code's next tool boundary", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    queue.set({ id: "q1", text: "use staging" });
    const events: string[] = [];
    const turn = session.run(createClaudeStreamState(takingCallbacks(events), "/work", "p1"), [{ type: "text", text: "deploy" }], undefined, undefined, [], queue);
    await tick();
    // The turn's own prompt is taken first.
    expect(sentInput(runtime())).toEqual([]);

    runtime().emit(lifecycle("p1", "queued"), lifecycle("p1", "started"), init, call("a1", "t1", "make deploy"));
    await tick();
    const [sent] = sentInput(runtime());
    expect(sent.message.content).toEqual([{ type: "text", text: "use staging" }]);

    runtime().emit(output("u1", "t1", "deploying"), lifecycle(String(sent.uuid), "started"), text("a2", "Switched to staging."), answered("p1", String(sent.uuid)));
    expect((await turn).text).toBe("Switched to staging.");
    expect(events).toEqual(["round:assistant,user", "input:use staging"]);
    expect(queue.subscribed).toBe(false);
  });

  test("a result before Claude Code takes one in does not end the turn: it goes on to answer it", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    const events: string[] = [];
    const rounds: ProviderRound[] = [];
    let ended = false;
    const turn = session.run(createClaudeStreamState(takingCallbacks(events, rounds), "/work", "p1"), [{ type: "text", text: "write it" }], undefined, undefined, [], queue);
    void turn.then(() => { ended = true; });
    await tick();
    runtime().emit(lifecycle("p1", "started"), init);
    await tick();
    queue.set({ id: "q1", text: "and test it" });
    await tick();
    const [sent] = sentInput(runtime());

    runtime().emit(text("a1", "Written."), result("p1"));
    await tick();
    expect(ended).toBe(false);

    runtime().emit(lifecycle("p1", "completed"), lifecycle(String(sent.uuid), "started"), init, text("a2", "Tested."), result(String(sent.uuid)));
    const shown = await turn;
    expect(shown.text).toBe("Tested.");
    expect(events).toEqual(["round:assistant", "input:and test it"]);
    // What came before the input is a round of its own, resumable after it.
    expect(rounds[0].messages[0]).toMatchObject({ role: "assistant", providerData: { anthropic: { sessionId: SESSION, resumeAt: "a1" } } });
  });

  test("one edited or unqueued before Claude Code takes it in is withdrawn", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    const events: string[] = [];
    const turn = session.run(createClaudeStreamState(takingCallbacks(events), "/work", "p1"), [{ type: "text", text: "build" }], undefined, undefined, [], queue);
    await tick();
    runtime().emit(lifecycle("p1", "started"), init, call("a1", "t1", "make"));
    await tick();
    queue.set({ id: "q1", text: "use clang" });
    await tick();
    queue.set({ id: "q1", text: "use gcc" });
    await tick();
    const [first, edited] = sentInput(runtime());
    expect(runtime().withdrawn).toEqual([String(first.uuid)]);
    expect(edited.message.content).toEqual([{ type: "text", text: "use gcc" }]);

    queue.set();
    await tick();
    expect(runtime().withdrawn).toEqual([String(first.uuid), String(edited.uuid)]);
    runtime().emit(lifecycle(String(edited.uuid), "cancelled"), output("u1", "t1", "built"), text("a2", "Built."), result("p1"));
    expect((await turn).text).toBe("Built.");
    expect(events).toEqual(["round:assistant,user"]);
  });

  test("one Claude Code took in before it could be withdrawn still joins the turn as it was sent", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    const events: string[] = [];
    const turn = session.run(createClaudeStreamState(takingCallbacks(events), "/work", "p1"), [{ type: "text", text: "build" }], undefined, undefined, [], queue);
    await tick();
    runtime().emit(lifecycle("p1", "started"), init, call("a1", "t1", "make"));
    await tick();
    queue.set({ id: "q1", text: "use clang" });
    await tick();
    runtime().withdrawable = false;
    queue.set();
    await tick();
    const [sent] = sentInput(runtime());
    runtime().emit(output("u1", "t1", "built"), lifecycle(String(sent.uuid), "started"), text("a2", "Built with clang."), answered("p1", String(sent.uuid)));
    expect((await turn).text).toBe("Built with clang.");
    expect(events).toEqual(["round:assistant,user", "input:use clang"]);
  });

  test("an interrupt withdraws queued messages Claude Code has not taken in", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(takingCallbacks([]), "/work", "p1"), [{ type: "text", text: "build" }], undefined, controller.signal, [], queue);
    await tick();
    runtime().emit(lifecycle("p1", "started"), init, call("a1", "t1", "make"));
    await tick();
    queue.set({ id: "q1", text: "use gcc" });
    await tick();
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(runtime().interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(queue.subscribed).toBe(false);
  });

  test("an interrupt while Claude Code answers queued input it ran after the result drops the rest of that turn", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(takingCallbacks([]), "/work", "p1"), [{ type: "text", text: "write it" }], undefined, controller.signal, [], queue);
    await tick();
    runtime().emit(lifecycle("p1", "started"), init);
    await tick();
    queue.set({ id: "q1", text: "and test it" });
    await tick();
    const [sent] = sentInput(runtime());
    runtime().emit(text("a1", "Written."), result("p1"), lifecycle(String(sent.uuid), "started"), init, text("a2", "Testing"));
    await tick();
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(runtime().interruptOptions).toEqual([undefined]);

    const next = session.run(createClaudeStreamState(callbacks(), "/work", "p2"), [{ type: "text", text: "go on" }], undefined, undefined);
    await tick();
    runtime().emit({ ...result(String(sent.uuid)), subtype: "error_during_execution", is_error: true }, init, text("a3", "ok"), result("p2"));
    expect((await next).text).toBe("ok");
    expect(session.isClosed).toBe(false);
  });

  test("wait for the turn to end when Claude Code does not report what becomes of what it is sent", async () => {
    const { session, runtime } = open();
    const queue = new FakeQueue();
    queue.set({ id: "q1", text: "use staging" });
    const turn = session.run(createClaudeStreamState(takingCallbacks([]), "/work", "p1"), [{ type: "text", text: "deploy" }], undefined, undefined, [], queue);
    await tick();
    runtime().emit(init, call("a1", "t1", "make deploy"), output("u1", "t1", "deployed"), text("a2", "Deployed."), result("p1"));
    expect((await turn).text).toBe("Deployed.");
    expect(sentInput(runtime())).toEqual([]);
    expect(queue.subscribed).toBe(false);
  });
});

describe("Claude Code processes outliving the daemon", () => {
  test("a daemon restart detaches the turn instead of interrupting it", async () => {
    const relay = new FakeRelay();
    const { convId, session, runtime } = openWithRelay(relay);
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p1"), [{ type: "text", text: "build it" }], undefined, controller.signal);
    await tick();
    runtime().emit(init, call("a1", "t1", "make"));
    await tick();
    controller.abort("daemon-restart");
    const error = await turn.catch((caught: unknown) => caught);
    expect(isDetachedTurnError(error)).toBe(true);
    expect(runtime().interrupts).toBe(0);
    expect(relay.detached).toBe(true);
    expect(session.isClosed).toBe(true);
    expect(getClaudeCodeSession(convId)).toBeUndefined();
  });

  test("reports each saved round and turn to the relay, with the messages it was sent", async () => {
    const relay = new FakeRelay();
    const { session, runtime } = openWithRelay(relay);
    const prompt: ApiMessage = { role: "user", content: "build it", metadata: { startedAt: 1 } as ApiMessage["metadata"] };
    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p1"), [{ type: "text", text: "build it" }], undefined, undefined, [prompt]);
    await tick();
    expect(relay.deliveredKeys).toEqual([deliveryKey(prompt)]);
    runtime().emit(init, call("a1", "t1", "make"), output("u1", "t1", "built"), text("a2", "done"), { ...result("p1"), uuid: "r1" });
    await turn;
    expect(relay.commits).toEqual([
      { through: "u1", resume: { sessionId: SESSION, resumeAt: "u1" } },
      { through: "r1", resume: { sessionId: SESSION, resumeAt: "a2" } },
    ]);
  });

  test("a new session continues while history still starts as it was started with", async () => {
    const first: ApiMessage = { role: "user", content: "build it", metadata: { startedAt: 1 } as ApiMessage["metadata"] };
    const convId = `claude-session-test-${Date.now()}-${convCounter++}`;
    const session = openClaudeCodeSession(convId, KEY, (input) => new FakeRuntime(input) as unknown as ClaudeRuntime, { history: historyMark([first]) });
    const followUp: ApiMessage = { role: "user", content: "and test it" };
    expect(session.canContinue(KEY, null, [first, followUp])).toBe(true);
    expect(session.canContinue(KEY, null, [{ ...first, content: "edited" }, followUp])).toBe(false);
    expect(session.canContinue(KEY, { sessionId: SESSION, resumeAt: "a1", cwd: "/work" }, [followUp])).toBe(false);
  });

  test("a process forked at a resume point continues from it before its first commit", async () => {
    const { session } = openWithRelay(new FakeRelay(), { sessionId: "forked-from", resumeAt: "r0" });
    expect(session.canContinue(KEY, { sessionId: "forked-from", resumeAt: "r0", cwd: "/work" })).toBe(true);
    expect(session.canContinue(KEY, { sessionId: "forked-from", resumeAt: "older", cwd: "/work" })).toBe(false);
  });

  test("an adopted process's running turn is held for the replay, which shows it without resending its prompt", async () => {
    const sentBefore: ApiMessage = { role: "user", content: "build it", metadata: { startedAt: 1 } as ApiMessage["metadata"] };
    const relay = new FakeRelay(adoptedHello({ delivered: [deliveryKey(sentBefore), "wake:old-wake"] }));
    const { session, runtime } = openWithRelay(relay);
    expect(session.canContinue(KEY, { sessionId: SESSION, resumeAt: "u1", cwd: "/work" })).toBe(true);

    // Replayed and live output of the turn the previous daemon was showing.
    runtime().emit({ ...call("a2", "t2", "make test"), exocortex_replayed: true }, output("u2", "t2", "passed"));
    await tick();
    expect(wakes).toHaveLength(0);

    expect(session.planInput([sentBefore])).toEqual({ kind: "wake" });
    const rounds: ProviderRound[] = [];
    const shown = session.run(createClaudeStreamState(callbacks(rounds), "/work", null), null, undefined, undefined);
    await tick();
    expect(cancelled).toEqual(["old-wake"]);
    runtime().emit(text("a3", "All green."), result("p-old"));
    expect((await shown).text).toBe("All green.");
    expect(rounds[0].messages.at(-1)).toMatchObject({ role: "user", content: [{ tool_use_id: "t2" }] });
    expect(runtime().prompts).toHaveLength(0);
  });

  test("interrupting an adopted process without background tasks closes it, so the next turn starts a fresh one", async () => {
    const relay = new FakeRelay(adoptedHello({ pending: false }));
    const { session, runtime } = openWithRelay(relay);
    const controller = new AbortController();
    const turn = session.run(createClaudeStreamState(callbacks(), "/work", "p1"), [{ type: "text", text: "go" }], undefined, controller.signal);
    await tick();
    runtime().emit(init, text("a1", "Working"));
    await tick();
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(relay.commits.at(-1)).toEqual({ through: "a1", resume: null, interrupted: { promptUuid: "p1" } });
    expect(session.isClosed).toBe(false);
    runtime().emit({ ...result("p1"), subtype: "error_during_execution", is_error: true });
    await tick();
    expect(session.isClosed).toBe(true);
  });
});
