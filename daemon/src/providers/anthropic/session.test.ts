import { afterEach, describe, expect, test } from "bun:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getConversationTasks, stopBackgroundTask } from "../../conversation-activity";
import type { ApiMessage } from "../../messages";
import type { ProviderRound, StreamCallbacks } from "../types";
import {
  claudeSessionKey,
  closeAllClaudeCodeSessions,
  configureClaudeCodeSessions,
  getClaudeCodeSession,
  openClaudeCodeSession,
  type ClaudeCodeSession,
  type ClaudeRuntime,
} from "./session";
import { createClaudeStreamState } from "./stream";

const SESSION = "22222222-2222-2222-2222-222222222222";
const KEY = claudeSessionKey("claude-opus-5-5", "high", "/work");

/** Stands in for a Claude Code process: records what it is sent, emits what a test scripts. */
class FakeRuntime implements AsyncIterable<unknown> {
  prompts: SDKUserMessage[] = [];
  interrupts = 0;
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

  async interrupt() {
    this.interrupts++;
    return { still_queued: [] };
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
const tasks = (...live: Array<{ id: string; description: string }>) => ({
  type: "system", subtype: "background_tasks_changed", session_id: SESSION,
  tasks: live.map(task => ({ task_id: task.id, task_type: "local_bash", description: task.description })),
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

    const input = session.planInput([wakeMessage(wakes[0]), { role: "user", content: "now deploy" }]);
    expect(input).toEqual({ kind: "prompt", content: [{ type: "text", text: "now deploy" }] });
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
