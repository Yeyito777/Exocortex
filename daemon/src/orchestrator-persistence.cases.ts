import { afterEach, describe, expect, test } from "bun:test";
import { clearHistoryUnwindPending, create, getActiveJob, getQueuedMessages, pushQueuedMessage, remove, requestHistoryUnwind } from "./conversations";
import { load as loadPersisted } from "./persistence";
import { orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { streamMessage } from "./api";

const IDS: string[] = [];

function id(suffix: string): string {
  const value = `orchestrator-persistence-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(value);
  return value;
}

function server(events: Array<Record<string, unknown>> = []) {
  return {
    sendTo: () => {},
    broadcast: (event: Record<string, unknown>) => { events.push(event); },
    sendToSubscribers: (_convId: string, event: Record<string, unknown>) => { events.push(event); },
    sendToSubscribersExcept: (_convId: string, event: Record<string, unknown>) => { events.push(event); },
    subscribe: () => {},
    unsubscribe: () => {},
    hasSubscribers: () => false,
    hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers: (
      _convId: string,
      _legacy: Record<string, unknown>,
      paginated: Record<string, unknown>,
    ) => { events.push(paginated); },
  };
}

function callbacks(streamMessageFn: typeof streamMessage): OrchestrationCallbacks {
  return {
    onHeaders() {},
    onComplete() {},
    streamMessageFn,
  };
}

afterEach(() => {
  for (const convId of IDS.splice(0)) {
    clearHistoryUnwindPending(convId);
    remove(convId);
  }
});

describe("DB-first orchestrator persistence", () => {
  test("commits the user before provider work and appends a successful assistant exactly once", async () => {
    const convId = id("success");
    create(convId, "openai", "gpt-5.6-sol");
    const startedAt = 10_000;
    let durableAtProviderStart: unknown = null;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      durableAtProviderStart = loadPersisted(convId)?.messages.map(message => message.content);
      streamCallbacks.onText("durable answer");
      return {
        text: "durable answer",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "durable answer" }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 3,
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "durable prompt",
      startedAt,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(durableAtProviderStart).toEqual(["durable prompt"]);
    const persisted = loadPersisted(convId)!;
    expect(persisted.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(persisted.messages.map(message => message.content)).toEqual([
      "durable prompt",
      [{ type: "text", text: "durable answer" }],
    ]);
    expect(persisted.messages[1]?.metadata).toMatchObject({ startedAt, tokens: 3 });
  });

  test("makes retry markers canonical immediately and preserves their final ordering", async () => {
    const convId = id("retry-marker");
    create(convId, "openai", "gpt-5.6-sol");
    const observed: { afterRetry: string[] | null } = { afterRetry: null };
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCallbacks.onRetry?.(1, 8, "temporary transport failure", 0, { kind: "transient" });
      observed.afterRetry = loadPersisted(convId)!.messages.map(message => message.role);
      streamCallbacks.onText("answer after retry");
      return {
        text: "answer after retry",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "answer after retry" }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 4,
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "retry prompt",
      15_000,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(observed.afterRetry).toEqual(["user", "system"]);
    const persisted = loadPersisted(convId)!;
    expect(persisted.messages.map(message => message.role)).toEqual(["user", "system", "assistant"]);
    expect(persisted.messages[1]?.content).toContain("temporary transport failure");
    expect(persisted.messages[2]?.content).toEqual([{ type: "text", text: "answer after retry" }]);
  });

  test("durably appends a salvageable partial and its error marker before publishing the marker", async () => {
    const convId = id("partial-error");
    create(convId, "openai", "gpt-5.6-sol");
    const events: Array<Record<string, unknown>> = [];
    const observed: { durableWhenErrorPublished: string[] | null } = { durableWhenErrorPublished: null };
    const fakeServer = server(events);
    fakeServer.sendToSubscribers = (_convId: string, event: Record<string, unknown>) => {
      events.push(event);
      if (event.type === "system_message") {
        observed.durableWhenErrorPublished = loadPersisted(convId)!.messages.map(message => message.role);
      }
    };
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCallbacks.onText("salvaged partial");
      throw new Error("provider exploded");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      fakeServer as never,
      null,
      undefined,
      convId,
      "prompt before failure",
      20_000,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(false);
    expect(observed.durableWhenErrorPublished).toEqual(["user", "assistant", "system"]);
    const persisted = loadPersisted(convId)!;
    expect(persisted.messages.map(message => message.role)).toEqual(["user", "assistant", "system"]);
    expect(persisted.messages[1]?.content).toEqual([{ type: "text", text: "salvaged partial" }]);
    expect(persisted.messages[2]?.content).toBe("✗ provider exploded");
    expect(persisted.messages[1]?.metadata).toMatchObject({ startedAt: 20_000 });
  });

  test("commits a completed tool round before the next provider request and preserves abort metadata", async () => {
    const convId = id("tool-round-abort");
    create(convId, "openai", "gpt-5.6-sol");
    let streamCall = 0;
    const observed: { durableBeforeSecondRequest: string[] | null } = { durableBeforeSecondRequest: null };
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCall += 1;
      if (streamCall === 1) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "read-hosts", name: "read", input: { file_path: "/etc/hosts" } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      observed.durableBeforeSecondRequest = loadPersisted(convId)!.messages.map(message => message.role);
      streamCallbacks.onText("partial after tool");
      throw new Error("second request failed");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "read hosts",
      25_000,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(false);
    expect(observed.durableBeforeSecondRequest).toEqual(["user", "assistant", "user"]);
    const persisted = loadPersisted(convId)!;
    expect(persisted.messages.map(message => message.role)).toEqual([
      "user", "assistant", "user", "assistant", "system",
    ]);
    expect(persisted.messages[1]?.metadata).toMatchObject({ startedAt: 25_000, tokens: 2 });
    expect(persisted.messages[3]?.content).toEqual([{ type: "text", text: "partial after tool" }]);
    expect(persisted.messages[4]?.content).toBe("✗ second request failed");
  });

  test("commits a queued next-turn injection before removing its durable queue copy", async () => {
    const convId = id("queued-injection");
    create(convId, "openai", "gpt-5.6-sol");
    pushQueuedMessage(convId, "queued interjection", "next-turn", undefined, undefined, undefined, "queued-injection-id");
    let streamCall = 0;
    const observed: { secondRequestContents: unknown[] | null; queueAfterCommit: number | null } = {
      secondRequestContents: null,
      queueAfterCommit: null,
    };
    const fakeStream = (async () => {
      streamCall += 1;
      if (streamCall === 1) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "read-hosts-queued", name: "read", input: { file_path: "/etc/hosts" } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      observed.secondRequestContents = loadPersisted(convId)!.messages.map(message => message.content);
      observed.queueAfterCommit = getQueuedMessages(convId).length;
      return {
        text: "final after queued turn",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "final after queued turn" }],
        toolCalls: [],
        inputTokens: 20,
        outputTokens: 5,
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "initial tool prompt",
      27_000,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(observed.secondRequestContents?.at(-1)).toBe("queued interjection");
    expect(observed.queueAfterCommit).toBe(0);
    expect(loadPersisted(convId)!.messages.map(message => message.role)).toEqual([
      "user", "assistant", "user", "user", "assistant",
    ]);
  });

  test("does not append an interrupted suffix while a targeted unwind owns the replacement", async () => {
    const convId = id("unwind-race");
    create(convId, "openai", "gpt-5.6-sol");
    const events: Array<Record<string, unknown>> = [];
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      const active = getActiveJob(convId)!;
      expect(requestHistoryUnwind(convId, "unwind-owner", active)).toBe(true);
      streamCallbacks.onText("must not become canonical");
      active.abort("history-unwind");
      throw new Error("interrupted for unwind");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "turn to replace",
      30_000,
      callbacks(fakeStream),
    );

    expect(outcome.aborted).toBe(true);
    expect(loadPersisted(convId)!.messages.map(message => message.content)).toEqual(["turn to replace"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "streaming_stopped", reason: "unwind" }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "system_message" }));
  });
});
