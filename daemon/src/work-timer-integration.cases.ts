import { expect, setSystemTime, test } from "bun:test";
import * as conversations from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER, type StoredMessage } from "./messages";
import { load } from "./persistence";
import { orchestrateReplayConversation, orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";

const OWNER_RELAY = "[notification] Discord/paramount · DM\nYeyito [ch:1]\n\n→ Yeyito <@3> [owner]:\nare you there?\n[msg:5]\n\nAction: answer on Discord.";

function fakeServer(events: any[]) {
  return {
    sendTo() {}, broadcast() {}, sendToSubscribers(_id: string, event: any) { events.push(event); },
    sendToSubscribersExcept(_id: string, event: any) { events.push(event); },
    hasSubscribers() { return true; }, hasLegacyHistorySubscribers() { return false; },
    sendHistoryUpdatedToSubscribers() {},
  } as any;
}

const reply = (text: string) => ({
  text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [],
  inputTokens: 10, outputTokens: 2,
});
const toolRound = (id: string, name: string, input: Record<string, unknown>) => ({
  text: "", thinking: "", stopReason: "tool_use" as const, blocks: [],
  toolCalls: [{ id, name, input }], inputTokens: 10, outputTokens: 2,
});
const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
const latestOrigin = (events: any[]) => events.findLast(event => event.type === "streaming_started").workTimerStartedAt;

/** Resolve once the conversation's whole turn chain is over; fail fast otherwise. */
async function untilIdle(id: string, ms = 2_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (conversations.isStreaming(id)) {
    if (performance.now() > deadline) throw new Error(`${id} still streaming after ${ms} ms`);
    await Bun.sleep(1);
  }
}

test("a run from idle starts at 0 whatever starts it, even seconds after the last run", async () => {
  const id = `work-timer-idle-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "openai", "gpt-6-sol");
  const now = Date.now();
  conversations.appendMessages(id, [{
    role: "assistant", content: "earlier work",
    metadata: {
      startedAt: now - 137_000, endedAt: now - 3_000,
      workTimerStartedAt: now - 137_000, model: "gpt-6-sol", tokens: 42,
      generationThroughput: { provider: "openai", model: "gpt-6-sol", rates: [100] },
    },
  }]);
  let expectedOrigin = 0;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async (_provider, _messages, _model, streamCallbacks) => {
      // Late joiners and the live event both see the run's timer.
      expect(conversations.getPendingStreamSnapshot(id)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
      expect(latestOrigin(events)).toBe(expectedOrigin);
      expect(conversations.getPendingStreamSnapshot(id)?.metadata?.generationThroughput?.rates).toEqual([]);
      streamCallbacks.onText("answer");
      advance(30_000);
      return reply("answer");
    },
  };
  try {
    for (const [label, text, automation] of [
      ["typed", "human follow-up", undefined],
      ["owner relay", OWNER_RELAY, { kind: "external_notification" }],
      ["someone else's notification", OWNER_RELAY.replace(" [owner]", ""), { kind: "external_notification" }],
      ["chrono wake", "[chrono wake]", { kind: "chrono_wake" }],
      ["subagent completion", "[subagent done]", { kind: "subagent_completion" }],
      ["background task", "[task done]", { kind: "background_task_completion" }],
    ] as const) {
      advance(5_000);
      expectedOrigin = Date.now();
      const result = await orchestrateSendMessage(server, null, undefined, id, text, expectedOrigin, callbacks,
        undefined, automation ? { automation } : {});
      expect(result.ok, `${label}: ${result.error}`).toBe(true);
      expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt, label).toBe(expectedOrigin);
      expect(load(id)!.messages.at(-1)?.metadata?.generationThroughput?.rates).toHaveLength(1);
      expect(conversations.getPendingStreamSnapshot(id)).toBeNull();
    }
    // A replay from idle (a durable sleep's wake, /replay) is a new run too.
    advance(5_000);
    expectedOrigin = Date.now();
    const replayed = await orchestrateReplayConversation(server, null, undefined, id, expectedOrigin, callbacks);
    expect(replayed.ok, replayed.error).toBe(true);
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});

test("messages steered into the running turn continue its timer, whoever sent them", async () => {
  const id = `work-timer-steer-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "openai", "gpt-6-sol");
  try {
    for (const [sender, text, automation] of [
      ["notification", "queued interjection", { kind: "chrono_wake" }],
      ["typed", "queued interjection", undefined],
      ["relayed", OWNER_RELAY, { kind: "external_notification" }],
    ] as const) {
      conversations.pushQueuedMessage(id, text, "next-turn",
        undefined, undefined, undefined, `queue-${sender}`, undefined, automation);
      const turnStart = Date.now() - 20_000;
      let calls = 0;
      const callbacks: OrchestrationCallbacks = {
        onHeaders() {}, onComplete() {},
        streamMessageFn: async () => {
          if (++calls === 1) return toolRound(`probe-${sender}`, "goal", { action: "show" });
          expect(load(id)!.messages.at(-1)!.content).toBe(text);
          expect(conversations.getPendingStreamSnapshot(id)?.metadata?.workTimerStartedAt).toBe(turnStart);
          return reply("after injection");
        },
      };
      const injected = await orchestrateSendMessage(server, null, undefined, id, "work before injection", turnStart, callbacks);
      expect(injected.ok, injected.error).toBe(true);
      expect(calls).toBe(2);
      expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(turnStart);
      const prefix = load(id)!.messages.filter(message => message.role === "assistant").at(-2)!;
      expect(prefix.metadata?.workTimerStartedAt).toBe(turnStart);
    }
  } finally {
    conversations.remove(id);
  }
});

test("turns the daemon chains without going idle continue the run's timer", async () => {
  const id = `work-timer-chain-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "openai", "gpt-6-sol");
  try {
    // Messages queued for when the running turn ends: the next turn joins the run.
    for (const [sender, text, automation] of [
      ["typed", "queued while working", undefined],
      ["relayed", OWNER_RELAY, { kind: "external_notification" }],
      ["automated", "[task done]", { kind: "background_task_completion" }],
    ] as const) {
      const turnStart = Date.now() - 20_000;
      const origins: number[] = [];
      const callbacks: OrchestrationCallbacks = {
        onHeaders() {}, onComplete() {},
        streamMessageFn: async () => {
          origins.push(latestOrigin(events));
          if (origins.length === 1) {
            conversations.pushQueuedMessage(id, text, "message-end",
              undefined, undefined, undefined, `queued-${sender}`, undefined, automation);
          }
          advance(10_000);
          return reply(`answer ${origins.length}`);
        },
      };
      const result = await orchestrateSendMessage(server, null, undefined, id, `work ${sender}`, turnStart, callbacks);
      expect(result.ok, result.error).toBe(true);
      expect(origins).toEqual([turnStart, turnStart]);
      expect(load(id)!.messages.findLast(message => message.role === "user")!.content).toBe(text);
      expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(turnStart);
      await untilIdle(id);
    }

    // Goal continuations, and a queued message they hand off to, too.
    conversations.setGoal(id, "finish the chain");
    const turnStart = Date.now() - 20_000;
    const origins: number[] = [];
    let call = 0;
    const callbacks: OrchestrationCallbacks = {
      onHeaders() {}, onComplete() {},
      streamMessageFn: async () => {
        origins.push(latestOrigin(events));
        advance(10_000);
        switch (++call) {
          case 1: return reply("working");
          case 2:
            conversations.pushQueuedMessage(id, "queued during the continuation", "message-end",
              undefined, undefined, undefined, "queued-goal", undefined, undefined);
            return reply("continued");
          case 3: return toolRound("goal-complete", "goal", { action: "complete", reason: "Done." });
          default: return reply("verified");
        }
      },
    };
    const result = await orchestrateSendMessage(server, null, undefined, id, "start the goal", turnStart, callbacks);
    expect(result.ok, result.error).toBe(true);
    await untilIdle(id);
    expect(conversations.get(id)?.goal?.status).toBe("complete");
    expect(origins.length).toBeGreaterThanOrEqual(4);
    expect(new Set(origins)).toEqual(new Set([turnStart]));
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(turnStart);

    // Once idle, the next run starts again at 0, well within five minutes.
    advance(5_000);
    const nextStart = Date.now();
    callbacks.streamMessageFn = async () => {
      origins.push(latestOrigin(events));
      return reply("fresh");
    };
    const next = await orchestrateSendMessage(server, null, undefined, id, "[chrono wake]", nextStart, callbacks,
      undefined, { automation: { kind: "chrono_wake" } });
    expect(next.ok, next.error).toBe(true);
    expect(origins.at(-1)).toBe(nextStart);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});

test("a replay after a daemon restart continues the interrupted run without the downtime", async () => {
  const id = `work-timer-restart-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "openai", "gpt-6-sol");
  const now = Date.now();
  const interrupted: StoredMessage[] = [
    { role: "user", content: "long task", metadata: { startedAt: now - 100_000, endedAt: now - 100_000, model: "gpt-6-sol", tokens: 0 } },
    { role: "assistant", content: "partial", metadata: {
      startedAt: now - 100_000, endedAt: now - 40_000, workTimerStartedAt: now - 130_000, model: "gpt-6-sol", tokens: 5,
    } },
  ];
  conversations.appendMessages(id, interrupted);
  let origin = 0;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async () => {
      origin = latestOrigin(events);
      return reply("resumed");
    },
  };
  try {
    const resumedAt = Date.now();
    const result = await orchestrateReplayConversation(server, null, undefined, id, resumedAt, callbacks,
      { resumesInterruptedRun: true });
    expect(result.ok, result.error).toBe(true);
    // 90 s of the run's work before the daemon went down; its 40 s offline are not charged.
    expect(origin).toBe(resumedAt - 90_000);
  } finally {
    conversations.remove(id);
  }
});

test("a long chrono sleep inside a Claude Code call is never charged: work after it starts at 0", async () => {
  const id = `work-timer-inline-sleep-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "anthropic", DEFAULT_MODEL_BY_PROVIDER.anthropic);
  const startedAt = Date.now() - 20_000;
  // Claude Code runs chrono over MCP inside its own call, never suspending.
  async function sleepInsideCall(callId: string, sleptMs: number, toolExecutor: any, signal?: AbortSignal) {
    const pending = toolExecutor([{ id: callId, name: "chrono", input: { action: "sleep", duration: "2h" } }], signal);
    while (conversations.getActiveBackgroundableToolName(id) !== "chrono") await Bun.sleep(1);
    advance(sleptMs);
    conversations.backgroundActiveTool(id, "steer");
    await pending;
  }
  const workTimers: number[] = [];
  const wokeAt: number[] = [];
  let calls = 0;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async (_provider, _messages, _model, _streamCallbacks, options: any) => {
      if (++calls > 1) {
        // A message queued for the end of the turn joins the same run.
        workTimers.push(latestOrigin(events));
        return reply("queued answer");
      }
      for (const [callId, sleptMs] of [["toolu_short", 60_000], ["toolu_long", 30 * 60_000]] as const) {
        await sleepInsideCall(callId, sleptMs, options.toolExecutor, options.signal);
        wokeAt.push(Date.now());
        workTimers.push(latestOrigin(events));
        advance(15_000);
      }
      conversations.pushQueuedMessage(id, "after the sleeps", "message-end",
        undefined, undefined, undefined, "queued-after-sleep", undefined, undefined);
      return reply("awake");
    },
  };
  try {
    const result = await orchestrateSendMessage(server, null, undefined, id, "sleep twice", startedAt, callbacks);
    expect(result.ok, result.error).toBe(true);
    for (const [index, origin] of workTimers.slice(0, 2).entries()) {
      expect(origin).toBeGreaterThanOrEqual(wokeAt[index] - 1);
      expect(origin).toBeLessThanOrEqual(wokeAt[index] + 1_000);
    }
    expect(workTimers[2]).toBe(workTimers[1]);
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(workTimers[1]);
    await untilIdle(id);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});

test("overlapping chrono sleeps inside a Claude Code call are one sleep", async () => {
  const id = `work-timer-overlapping-sleeps-${Date.now()}`;
  const events: any[] = [];
  const server = fakeServer(events);
  conversations.create(id, "anthropic", DEFAULT_MODEL_BY_PROVIDER.anthropic);
  const startedAt = Date.now() - 20_000;
  let afterFirst = 0;
  let afterBoth = 0;
  let bothEndedAt = 0;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async (_provider, _messages, _model, _streamCallbacks, options: any) => {
      // Claude Code may issue host tool calls concurrently.
      const sleep = (callId: string) => {
        const stop = new AbortController();
        const done = options.toolExecutor([{ id: callId, name: "chrono", input: { action: "sleep", duration: "2h" } }], stop.signal)
          .catch(() => {});
        return { stop: () => stop.abort(), done };
      };
      const sleeping = (callId: string) => conversations.getSummary(id)?.tasks?.some(task => task.id === `chrono:sleep:${callId}`);
      const first = sleep("toolu_first");
      while (!sleeping("toolu_first")) await Bun.sleep(1);
      advance(60_000);
      const second = sleep("toolu_second");
      while (!sleeping("toolu_second")) await Bun.sleep(1);
      advance(60_000);
      first.stop();
      await first.done;
      afterFirst = latestOrigin(events);
      advance(60_000);
      bothEndedAt = Date.now();
      second.stop();
      await second.done;
      afterBoth = latestOrigin(events);
      return reply("awake");
    },
  };
  try {
    const result = await orchestrateSendMessage(server, null, undefined, id, "sleep twice at once", startedAt, callbacks);
    expect(result.ok, result.error).toBe(true);
    // Still sleeping in the second call: the timer is untouched.
    expect(afterFirst).toBe(startedAt);
    // Restarted once, when the last sleep ended.
    expect(afterBoth).toBeGreaterThanOrEqual(bothEndedAt);
    expect(afterBoth).toBeLessThan(bothEndedAt + 1_000);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});
