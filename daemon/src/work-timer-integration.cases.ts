import { expect, setSystemTime, test } from "bun:test";
import * as conversations from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER } from "./messages";
import { load } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";

const OWNER_RELAY = "[notification] Discord/paramount · DM\nYeyito [ch:1]\n\n→ Yeyito <@3> [owner]:\nare you there?\n[msg:5]\n\nAction: answer on Discord.";

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
    // Whoever sent it, a prompt injected mid-turn continues the stretch.
    for (const [sender, text, automation] of [
      ["notification", "queued interjection", { kind: "chrono_wake" }],
      ["typed", "queued interjection", undefined],
      ["relayed", OWNER_RELAY, { kind: "external_notification" }],
    ] as const) {
      conversations.pushQueuedMessage(id, text, "next-turn",
        undefined, undefined, undefined, `queue-${sender}`, undefined, automation);
      const turnStart = Date.now() - 20_000;
      let calls = 0;
      callbacks.streamMessageFn = async () => {
        if (++calls === 1) return {
          text: "", thinking: "", stopReason: "tool_use", blocks: [],
          toolCalls: [{ id: `probe-${sender}`, name: "goal", input: { action: "show" } }],
          inputTokens: 10, outputTokens: 2,
        };
        const accepted = load(id)!.messages.at(-1)!;
        expect(accepted.content).toBe(text);
        expect(accepted.metadata?.arrivedWhileWorking).toBe(true);
        expectedOrigin = turnStart;
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

test("a prompt queued during a turn continues the stretch when that turn ends; the owner's words while idle restart it", async () => {
  const id = `work-timer-queued-${Date.now()}`;
  const events: any[] = [];
  const server = {
    sendTo() {}, broadcast() {}, sendToSubscribers(_id: string, event: any) { events.push(event); },
    sendToSubscribersExcept(_id: string, event: any) { events.push(event); },
    hasSubscribers() { return true; }, hasLegacyHistorySubscribers() { return false; },
    sendHistoryUpdatedToSubscribers() {},
  } as any;
  conversations.create(id, "openai", "gpt-6-sol");
  const reply = (text: string) => ({
    text, thinking: "", stopReason: "stop" as const, blocks: [{ type: "text" as const, text }], toolCalls: [],
    inputTokens: 10, outputTokens: 2,
  });
  try {
    for (const [sender, text, automation] of [
      ["typed", "queued while working", undefined],
      ["relayed", OWNER_RELAY, { kind: "external_notification" }],
    ] as const) {
      const turnStart = Date.now() - 20_000;
      const origins: number[] = [];
      const callbacks: OrchestrationCallbacks = {
        onHeaders() {}, onComplete() {},
        streamMessageFn: async () => {
          origins.push(events.findLast(event => event.type === "streaming_started").workTimerStartedAt);
          if (origins.length === 1) {
            conversations.pushQueuedMessage(id, text, "message-end",
              undefined, undefined, undefined, `queued-${sender}`, undefined, automation);
          }
          return reply(`answer ${origins.length}`);
        },
      };
      const result = await orchestrateSendMessage(server, null, undefined, id, `work ${sender}`, turnStart, callbacks);
      expect(result.ok, result.error).toBe(true);
      expect(origins).toHaveLength(2);
      expect(origins[0]).toBe(turnStart);
      const accepted = load(id)!.messages.findLast(message => message.role === "user")!;
      expect(accepted.content).toBe(text);
      expect(accepted.metadata?.arrivedWhileWorking).toBe(true);
      // Only the moment between the turns is uncharged.
      expect(origins[1]).toBeGreaterThanOrEqual(turnStart);
      expect(origins[1]).toBeLessThan(turnStart + 1_000);
      expect(load(id)!.messages.at(-1)?.metadata?.workTimerStartedAt).toBe(origins[1]);
    }

    // The owner relayed a message to an idle conversation, a minute after it went idle.
    const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
    let origin = 0;
    const idleCallbacks: OrchestrationCallbacks = {
      onHeaders() {}, onComplete() {},
      streamMessageFn: async () => {
        origin = events.findLast(event => event.type === "streaming_started").workTimerStartedAt;
        advance(30_000);
        return reply("relay answer");
      },
    };
    advance(60_000);
    const relayedAt = Date.now();
    const relayed = await orchestrateSendMessage(server, null, undefined, id, OWNER_RELAY, relayedAt, idleCallbacks,
      undefined, { automation: { kind: "external_notification" } });
    expect(relayed.ok, relayed.error).toBe(true);
    expect(origin).toBe(relayedAt);
    // Someone else's message is a notification: it continues the stretch.
    advance(60_000);
    const otherAt = Date.now();
    const other = await orchestrateSendMessage(server, null, undefined, id,
      OWNER_RELAY.replace(" [owner]", ""), otherAt, idleCallbacks,
      undefined, { automation: { kind: "external_notification" } });
    expect(other.ok, other.error).toBe(true);
    expect(origin).toBeLessThanOrEqual(otherAt - 30_000);
    expect(origin).toBeGreaterThan(otherAt - 31_000);
  } finally {
    setSystemTime();
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
