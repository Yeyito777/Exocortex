import { expect, setSystemTime, test } from "bun:test";
import * as conversations from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER } from "./messages";
import { load } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";

test("work timer survives canonical persistence, late join, automatic continuation and user reset", async () => {
  const id = `work-timer-${Date.now()}`;
  const events: any[] = [];
  const server = {
    sendTo() {}, broadcast() {}, sendToSubscribers(_id: string, event: any) { events.push(event); },
    sendToSubscribersExcept(_id: string, event: any) { events.push(event); },
    hasSubscribers() { return true; }, hasLegacyHistorySubscribers() { return false; },
    sendHistoryUpdatedToSubscribers() {},
  } as any;
  conversations.create(id, "openai", "gpt-6-sol");
  const startedAt = Date.now();
  conversations.appendMessages(id, [{
    role: "assistant", content: "earlier work",
    metadata: {
      startedAt: startedAt - 137_000, endedAt: startedAt - 3_000,
      workTimerStartedAt: startedAt - 137_000, model: "gpt-6-sol", tokens: 42,
      generationThroughput: { provider: "openai", model: "gpt-6-sol", rates: [100] },
    },
  }]);
  let expectedOrigin = startedAt - 134_000;
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async (_provider, _messages, _model, streamCallbacks) => {
      expect(conversations.getPendingStreamSnapshot(id)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
      expect(events.findLast(event => event.type === "streaming_started")?.workTimerStartedAt).toBe(expectedOrigin);
      expect(conversations.getPendingStreamSnapshot(id)?.metadata?.generationThroughput?.rates)
        .toEqual([]);
      expect(events.findLast(event => event.type === "streaming_started")?.generationThroughput?.rates)
        .toEqual([]);
      streamCallbacks.onText("continued answer");
      return {
        text: "continued answer", thinking: "", stopReason: "stop",
        blocks: [{ type: "text", text: "continued answer" }], toolCalls: [],
        inputTokens: 10, outputTokens: 3,
      };
    },
  };
  try {
    const result = await orchestrateSendMessage(server, null, undefined, id, "notification", startedAt, callbacks,
      undefined, { automation: { kind: "external_notification" } });
    expect(result.ok).toBe(true);
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
    expect(load(id)!.messages.at(-1)?.metadata?.generationThroughput?.rates).toHaveLength(1);
    expect(events.findLast(event => event.type === "message_complete")?.generationThroughput?.rates).toHaveLength(1);
    expect(conversations.getPendingStreamSnapshot(id)).toBeNull();
    expectedOrigin = Date.now();
    const next = await orchestrateSendMessage(server, null, undefined, id, "human follow-up", expectedOrigin, callbacks);
    expect(next.ok).toBe(true);
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
    expect(load(id)!.messages.at(-1)?.metadata?.generationThroughput?.rates).toHaveLength(1);
    for (const automated of [true, false]) {
      conversations.pushQueuedMessage(id, "queued interjection", "next-turn",
        undefined, undefined, undefined, `queue-${automated}`, undefined,
        automated ? { kind: "chrono_wake" } : undefined);
      const turnStart = Date.now() - 20_000;
      let calls = 0;
      callbacks.streamMessageFn = async () => {
        if (++calls === 1) return {
          text: "", thinking: "", stopReason: "tool_use", blocks: [],
          toolCalls: [{ id: `probe-${automated}`, name: "goal", input: { action: "show" } }],
          inputTokens: 10, outputTokens: 2,
        };
        const accepted = load(id)!.messages.at(-1)!;
        expect(accepted.content).toBe("queued interjection");
        expectedOrigin = automated ? turnStart : accepted.metadata!.startedAt;
        expect(conversations.getPendingStreamSnapshot(id)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
        return {
          text: "after injection", thinking: "", stopReason: "stop",
          blocks: [{ type: "text", text: "after injection" }], toolCalls: [],
          inputTokens: 20, outputTokens: 4,
        };
      };
      const injected = await orchestrateSendMessage(server, null, undefined, id, "work before injection", turnStart, callbacks);
      expect(injected.ok, injected.error).toBe(true);
      expect(calls).toBe(2);
      expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(expectedOrigin);
      expect(load(id)!.messages.at(-1)?.metadata?.generationThroughput?.rates).toHaveLength(2);
      const prefix = load(id)!.messages.filter(message => message.role === "assistant").at(-2)!;
      expect(prefix.metadata?.workTimerStartedAt).toBe(turnStart);
    }
  } finally {
    conversations.remove(id);
  }
});

test("a long chrono sleep inside a Claude Code call is not charged to the work timer", async () => {
  const id = `work-timer-inline-sleep-${Date.now()}`;
  const events: any[] = [];
  const server = {
    sendTo() {}, broadcast() {}, sendToSubscribers(_id: string, event: any) { events.push(event); },
    sendToSubscribersExcept(_id: string, event: any) { events.push(event); },
    hasSubscribers() { return true; }, hasLegacyHistorySubscribers() { return false; },
    sendHistoryUpdatedToSubscribers() {},
  } as any;
  conversations.create(id, "anthropic", DEFAULT_MODEL_BY_PROVIDER.anthropic);
  const startedAt = Date.now() - 20_000;
  let skew = 0;
  // Claude Code runs chrono over MCP inside its own call, never suspending.
  async function sleepInsideCall(callId: string, sleptMs: number, toolExecutor: any, signal?: AbortSignal) {
    const pending = toolExecutor([{ id: callId, name: "chrono", input: { action: "sleep", duration: "2h" } }], signal);
    while (conversations.getActiveBackgroundableToolName(id) !== "chrono") await Bun.sleep(1);
    skew += sleptMs;
    setSystemTime(new Date(Date.now() + sleptMs));
    conversations.backgroundActiveTool(id, "steer");
    await pending;
  }
  const workTimers: number[] = [];
  const callbacks: OrchestrationCallbacks = {
    onHeaders() {}, onComplete() {},
    streamMessageFn: async (_provider, _messages, _model, _streamCallbacks, options: any) => {
      await sleepInsideCall("toolu_short", 60_000, options.toolExecutor, options.signal);
      workTimers.push(events.findLast(event => event.type === "streaming_started").workTimerStartedAt);
      await sleepInsideCall("toolu_long", 30 * 60_000, options.toolExecutor, options.signal);
      workTimers.push(events.findLast(event => event.type === "streaming_started").workTimerStartedAt);
      return {
        text: "awake", thinking: "", stopReason: "stop",
        blocks: [{ type: "text", text: "awake" }], toolCalls: [],
        inputTokens: 10, outputTokens: 2,
      };
    },
  };
  try {
    const result = await orchestrateSendMessage(server, null, undefined, id, "sleep twice", startedAt, callbacks);
    expect(result.ok, result.error).toBe(true);
    // A short interrupted sleep keeps earlier work but not the minute slept.
    expect(workTimers[0]).toBeGreaterThanOrEqual(startedAt + 60_000);
    expect(workTimers[0]).toBeLessThan(startedAt + 60_000 + 1_000);
    // Past the idle buffer, the stretch restarts when the turn wakes.
    expect(workTimers[1]).toBeGreaterThanOrEqual(startedAt + skew + 20_000);
    expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(workTimers[1]);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});

test("overlapping chrono sleeps inside a Claude Code call are one idle stretch", async () => {
  const id = `work-timer-overlapping-sleeps-${Date.now()}`;
  const events: any[] = [];
  const server = {
    sendTo() {}, broadcast() {}, sendToSubscribers(_id: string, event: any) { events.push(event); },
    sendToSubscribersExcept(_id: string, event: any) { events.push(event); },
    hasSubscribers() { return true; }, hasLegacyHistorySubscribers() { return false; },
    sendHistoryUpdatedToSubscribers() {},
  } as any;
  conversations.create(id, "anthropic", DEFAULT_MODEL_BY_PROVIDER.anthropic);
  const startedAt = Date.now() - 20_000;
  const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
  const workTimer = () => events.findLast(event => event.type === "streaming_started").workTimerStartedAt;
  let afterFirst = 0;
  let afterBoth = 0;
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
      afterFirst = workTimer();
      advance(60_000);
      second.stop();
      await second.done;
      afterBoth = workTimer();
      return {
        text: "awake", thinking: "", stopReason: "stop",
        blocks: [{ type: "text", text: "awake" }], toolCalls: [],
        inputTokens: 10, outputTokens: 2,
      };
    },
  };
  try {
    const result = await orchestrateSendMessage(server, null, undefined, id, "sleep twice at once", startedAt, callbacks);
    expect(result.ok, result.error).toBe(true);
    // Still sleeping in the second call: nothing is charged or refunded yet.
    expect(afterFirst).toBe(startedAt);
    // Three minutes asleep in total, refunded once.
    expect(afterBoth).toBeGreaterThanOrEqual(startedAt + 3 * 60_000);
    expect(afterBoth).toBeLessThan(startedAt + 3 * 60_000 + 1_000);
  } finally {
    setSystemTime();
    conversations.remove(id);
  }
});
