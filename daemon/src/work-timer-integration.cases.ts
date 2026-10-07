import { expect, test } from "bun:test";
import * as conversations from "./conversations";
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
