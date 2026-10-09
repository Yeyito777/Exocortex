import { afterEach, describe, expect, mock, test } from "bun:test";
import { appendMessages, clearActiveToolBackgrounder, clearGoal, clearHistoryUnwindPending, clearStreamHandoff, create, get, getActiveJob, getQueuedMessages, getSummary, isStreaming, isUnread, pin, pushQueuedMessage, remove, requestHistoryUnwind, setActiveToolBackgrounder, setGoal, steerActiveTurn, updateGoalStatus } from "./conversations";
import { load as loadPersisted } from "./persistence";
import { orchestrateCompactConversation, orchestrateGoalCycle, orchestrateReplayConversation, orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { streamMessage } from "./api";
import { chronoInternalsForTest, configureChronoService, listDeferredChronoSleeps } from "./chrono-service";
import { USER_MESSAGE_AUTOMATION_KINDS, createStoredUserMessage } from "./messages";
import { setBackgroundTaskActive } from "./conversation-activity";
import { getProviderAdapter } from "./providers/catalog";
import { invalidateCredentialsCache } from "./auth";
import { createOpenAIEventAccumulator } from "./providers/openai/stream";
import { getStaleStreams } from "./streaming";

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
  chronoInternalsForTest.reset();
  for (const convId of IDS.splice(0)) {
    clearHistoryUnwindPending(convId);
    remove(convId);
  }
});

describe("hidden provider progress reaches the app watchdog", () => {
  for (const [itemType, eventType] of [
    ["function_call", "response.function_call_arguments.delta"],
    ["custom_tool_call", "response.custom_tool_call_input.delta"],
  ] as const) {
    test(`${itemType} arguments do not trigger a rendering-based timeout`, async () => {
      const convId = id(`provider-activity-${itemType}`);
      create(convId, "openai", "gpt-5.6-sol");
      const events: Array<Record<string, unknown>> = [];
      const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
        const originalNow = Date.now;
        let now = originalNow();
        try {
          Date.now = () => now;
          const accumulator = createOpenAIEventAccumulator(streamCallbacks);
          accumulator.handle({
            type: "response.output_item.added", output_index: 0,
            item: { type: itemType, call_id: "call-1", name: "test-tool" },
          });
          for (let i = 0; i < 16; i++) {
            now += 60_000;
            accumulator.handle({ type: eventType, output_index: 0, delta: "a" });
          }
          expect(getStaleStreams().some(([id]) => id === convId)).toBe(false);
          expect(events.some(event => event.type === "tool_call")).toBe(false);
        } finally {
          Date.now = originalNow;
        }
        // Only completed calls are executable. This seam finishes without one.
        return { text: "", thinking: "", stopReason: "stop", blocks: [], toolCalls: [] };
      }) as typeof streamMessage;
      const outcome = await orchestrateSendMessage(
        server(events) as never, null, undefined, convId, "test", Date.now(), callbacks(fakeStream),
      );
      expect(outcome.ok).toBe(true);
      expect(isStreaming(convId)).toBe(false);
      expect(events.some(event => event.type === "stream_retry")).toBe(false);
    });
  }
});

describe("human-only sidebar bumps", () => {
  function targetBelowNewerConversation(suffix: string): { convId: string; newerId: string; originalOrder: number } {
    const convId = id(`sidebar-${suffix}`);
    const newerId = id(`sidebar-${suffix}-newer`);
    create(convId, "openai", "gpt-5.6-sol");
    create(newerId, "openai", "gpt-5.6-sol");
    const originalOrder = get(convId)!.sortOrder;
    expect(originalOrder).toBeGreaterThan(get(newerId)!.sortOrder);
    return { convId, newerId, originalOrder };
  }

  const answer = {
    text: "answer",
    thinking: "",
    stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text: "answer" }],
    toolCalls: [],
    inputTokens: 10,
    outputTokens: 2,
  };

  for (const kind of USER_MESSAGE_AUTOMATION_KINDS) {
    test(`${kind} persists and notifies without changing sidebar order`, async () => {
      const { convId, originalOrder } = targetBelowNewerConversation(kind);
      const events: Array<Record<string, unknown>> = [];
      const automation = { kind, sourceId: "sidebar-test-source" };
      const fakeStream = (async () => {
        expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
        expect(getSummary(convId)!.sortOrder).toBe(originalOrder);
        return answer;
      }) as typeof streamMessage;

      const outcome = await orchestrateSendMessage(
        server(events) as never, null, undefined, convId, "automatic prompt", Date.now(),
        callbacks(fakeStream), undefined, { automation },
      );

      expect(outcome.ok).toBe(true);
      expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
      expect(loadPersisted(convId)!.messages[0]?.metadata?.automation).toEqual(automation);
      expect(events).toContainEqual(expect.objectContaining({ type: "user_message", automation }));
      const summaries = events.filter(event => event.type === "conversation_updated");
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every(event => (event.summary as { sortOrder: number }).sortOrder === originalOrder)).toBe(true);
    });
  }

  for (const delivery of ["direct", "queued"] as const) {
    test(`${delivery} human input still bumps before provider work`, async () => {
      const { convId, newerId, originalOrder } = targetBelowNewerConversation(delivery);
      const queueEntryId = delivery === "queued"
        ? pushQueuedMessage(convId, "human prompt", "next-turn").id
        : undefined;
      const fakeStream = (async () => {
        expect(loadPersisted(convId)!.sortOrder).toBeLessThan(get(newerId)!.sortOrder);
        expect(getSummary(convId)!.sortOrder).toBe(loadPersisted(convId)!.sortOrder);
        expect(getQueuedMessages(convId)).toEqual([]);
        return answer;
      }) as typeof streamMessage;

      const outcome = await orchestrateSendMessage(
        server() as never, delivery === "direct" ? {} as never : null, undefined,
        convId, "human prompt", Date.now(), callbacks(fakeStream), undefined, { queueEntryId },
      );

      expect(outcome.ok).toBe(true);
      expect(loadPersisted(convId)!.sortOrder).toBeLessThan(originalOrder);
      expect(getQueuedMessages(convId)).toEqual([]);
    });
  }

  test("human input leaves pinned conversations in place", async () => {
    const { convId } = targetBelowNewerConversation("pinned");
    pin(convId, true);
    const pinnedOrder = get(convId)!.sortOrder;
    const outcome = await orchestrateSendMessage(
      server() as never, null, undefined, convId, "human prompt", Date.now(),
      callbacks((async () => answer) as typeof streamMessage),
    );
    expect(outcome.ok).toBe(true);
    expect(loadPersisted(convId)!.sortOrder).toBe(pinnedOrder);
  });

  for (const [name, startTurn] of [
    ["replay", orchestrateReplayConversation],
    ["manual compaction", orchestrateCompactConversation],
  ] as const) {
    test(`${name} without new human input preserves sidebar order`, async () => {
      const { convId, originalOrder } = targetBelowNewerConversation(name.replaceAll(" ", "-"));
      appendMessages(convId, [createStoredUserMessage("earlier human input", "gpt-5.6-sol", 1_000)]);
      const fakeStream = (async () => {
        expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
        return answer;
      }) as typeof streamMessage;

      const outcome = await startTurn(
        server() as never, null, undefined, convId, Date.now(), callbacks(fakeStream),
      );

      expect(outcome.ok).toBe(true);
      expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
    });
  }

  test("a daemon-authored preflight error preserves sidebar order", async () => {
    const { convId, originalOrder } = targetBelowNewerConversation("preflight-error");
    const outcome = await orchestrateReplayConversation(
      server() as never, null, undefined, convId, Date.now(),
      callbacks((async () => { throw new Error("provider should not run"); }) as typeof streamMessage),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("No conversation history to replay");
    expect(loadPersisted(convId)!.messages.at(-1)?.role).toBe("system");
    expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
  });

  for (const timing of ["next-turn", "message-end"] as const) {
    for (const automated of [true, false]) {
      test(`${timing} ${automated ? "automatic" : "human"} input ${automated ? "preserves" : "bumps"} sidebar order`, async () => {
        const { convId } = targetBelowNewerConversation(`queue-${timing}-${automated}`);
        const newerId = id("sidebar-newer-during-stream");
        let orderBeforeQueuedInput = 0;
        let streamCalls = 0;
        const fakeStream = (async () => {
          streamCalls += 1;
          if (streamCalls === 1) {
            // Another conversation can move above the target while it streams.
            create(newerId, "openai", "gpt-5.6-sol");
            orderBeforeQueuedInput = get(convId)!.sortOrder;
            pushQueuedMessage(
              convId, "queued prompt", timing, undefined, undefined, undefined, undefined, undefined,
              automated ? { kind: "background_task_completion", sourceId: "queued-sidebar-test" } : undefined,
            );
            if (timing === "next-turn") {
              return {
                ...answer, text: "", stopReason: "tool_use" as const, blocks: [],
                toolCalls: [{ id: "sidebar-read-hosts", name: "read", input: { file_path: "/etc/hosts" } }],
              };
            }
          } else {
            const persisted = loadPersisted(convId)!;
            expect(persisted.messages.some(message => message.content === "queued prompt")).toBe(true);
            if (automated) expect(persisted.sortOrder).toBe(orderBeforeQueuedInput);
            else expect(persisted.sortOrder).toBeLessThan(get(newerId)!.sortOrder);
          }
          return answer;
        }) as typeof streamMessage;

        const outcome = await orchestrateSendMessage(
          server() as never, null, undefined, convId, "initial human prompt", Date.now(), callbacks(fakeStream),
        );
        expect(outcome.ok).toBe(true);
        expect(streamCalls).toBe(2);
        if (automated) expect(loadPersisted(convId)!.sortOrder).toBe(orderBeforeQueuedInput);
        else expect(loadPersisted(convId)!.sortOrder).toBeLessThan(get(newerId)!.sortOrder);
      });
    }
  }
});

describe("instant steering", () => {
  const finalAnswer = (text: string) => ({
    text, thinking: "", stopReason: "stop" as const,
    blocks: [{ type: "text" as const, text }], toolCalls: [], inputTokens: 10, outputTokens: 2,
  });

  function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_, reject) => {
      const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) rejectAbort();
      else signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  }

  test("a user steer preempts the live response and is answered in the same turn", async () => {
    const convId = id("steer-preempts");
    create(convId, "openai", "gpt-5.6-sol");
    const events: Array<Record<string, unknown>> = [];
    const requests: Array<Array<{ role: string; content: unknown }>> = [];
    const fakeStream = (async (_provider, messages, _model, streamCallbacks, options) => {
      requests.push(messages.map(message => ({ role: message.role, content: message.content })));
      if (requests.length > 1) return finalAnswer("Three ducks it is!");
      streamCallbacks.onBlockStart?.("text");
      streamCallbacks.onText("I'll draw a cozy cat");
      pushQueuedMessage(convId, "3 ducks!", "next-turn", undefined, undefined, undefined, "steer-ducks");
      steerActiveTurn(convId);
      expect(options?.signal?.aborted).toBe(true);
      return waitForAbort(options?.signal);
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server(events) as never, null, undefined, convId, "draw a cat", Date.now(), callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual([
      { role: "user", content: "draw a cat" },
      { role: "assistant", content: [{ type: "text", text: "I'll draw a cozy cat" }] },
      { role: "user", content: "3 ducks!" },
    ]);
    const persisted = loadPersisted(convId)!.messages;
    expect(persisted.map(message => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(persisted[2]?.metadata?.queueEntryId).toBe("steer-ducks");
    expect(persisted[3]?.content).toEqual([{ type: "text", text: "Three ducks it is!" }]);
    expect(getQueuedMessages(convId)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "user_message", queueId: "steer-ducks" }));
    expect(events.some(event => event.type === "stream_retry" || event.type === "system_message")).toBe(false);
  });

  test("automated next-turn input waits for the tool boundary", async () => {
    const convId = id("steer-automation");
    create(convId, "openai", "gpt-5.6-sol");
    const requests: unknown[][] = [];
    const fakeStream = (async (_provider, messages, _model, _streamCallbacks, options) => {
      requests.push(messages.map(message => message.content));
      if (requests.length > 1) return finalAnswer("done");
      pushQueuedMessage(convId, "wake up", "next-turn", undefined, undefined, undefined, undefined, undefined,
        { kind: "chrono_wake", sourceId: "chrono:steer-test" });
      steerActiveTurn(convId);
      expect(options?.signal?.aborted).toBe(false);
      return {
        text: "", thinking: "", stopReason: "tool_use" as const, blocks: [],
        toolCalls: [{ id: "steer-automation-read", name: "read", input: { file_path: "/etc/hosts" } }],
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never, null, undefined, convId, "inspect", Date.now(), callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.at(-1)).toBe("wake up");
    expect(loadPersisted(convId)!.messages.map(message => message.role)).toEqual([
      "user", "assistant", "user", "user", "assistant",
    ]);
  });

  test("a steer backgrounds a running tool and preempts only after provider-run tools settle", async () => {
    const convId = id("steer-provider-tool");
    create(convId, "openai", "gpt-5.6-sol");
    const backgroundReasons: unknown[] = [];
    let requests = 0;
    const fakeStream = (async (_provider, messages, _model, streamCallbacks, options) => {
      requests += 1;
      if (requests > 1) {
        expect(messages.at(-1)?.content).toBe("use the staging config");
        return finalAnswer("switched to staging");
      }
      // A provider that runs its own tools (Claude Code) reports them live.
      streamCallbacks.onToolCall?.({ type: "tool_call", toolCallId: "provider-bash", toolName: "bash", input: {}, summary: "deploy" });
      setActiveToolBackgrounder(convId, {
        toolName: "bash",
        background: (reason) => { backgroundReasons.push(reason); return true; },
      });
      pushQueuedMessage(convId, "use the staging config", "next-turn");
      steerActiveTurn(convId);
      expect(backgroundReasons).toEqual(["steer"]);
      expect(options?.signal?.aborted).toBe(false);
      clearActiveToolBackgrounder(convId);
      streamCallbacks.onToolResult?.({ type: "tool_result", toolCallId: "provider-bash", toolName: "bash", output: "deployed", isError: false });
      expect(options?.signal?.aborted).toBe(false);
      return waitForAbort(options?.signal);
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never, null, undefined, convId, "deploy it", Date.now(), callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(requests).toBe(2);
    expect(getQueuedMessages(convId)).toEqual([]);
  });

  test("a steer that arrives before the request is sent joins it without a wasted request", async () => {
    const convId = id("steer-before-request");
    create(convId, "openai", "gpt-5.6-sol");
    const daemonServer = server();
    const sendToSubscribers = daemonServer.sendToSubscribers;
    daemonServer.sendToSubscribers = (target, event) => {
      sendToSubscribers(target, event);
      // No provider request is running yet, as during pre-turn compaction.
      if (event.type === "streaming_started" && event.snapshotKind === "start") {
        pushQueuedMessage(convId, "and keep it short", "next-turn", undefined, undefined, undefined, "steer-early");
        steerActiveTurn(convId);
      }
    };
    const requests: unknown[][] = [];
    const fakeStream = (async (_provider, messages) => {
      requests.push(messages.map(message => message.content));
      return finalAnswer("short answer");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      daemonServer as never, null, undefined, convId, "explain it", Date.now(), callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(requests).toEqual([["explain it", "and keep it short"]]);
    expect(loadPersisted(convId)!.messages.map(message => message.role)).toEqual(["user", "user", "assistant"]);
  });

  test("input queued before the turn started waits so the turn's own prompt is sampled first", async () => {
    const convId = id("steer-queued-earlier");
    create(convId, "openai", "gpt-5.6-sol");
    pushQueuedMessage(convId, "queued earlier", "next-turn", undefined, undefined, undefined, "steer-earlier");
    const requests: unknown[][] = [];
    const fakeStream = (async (_provider, messages) => {
      requests.push(messages.map(message => message.content));
      if (requests.length > 1) return finalAnswer("done");
      return {
        text: "", thinking: "", stopReason: "tool_use" as const, blocks: [],
        toolCalls: [{ id: "steer-earlier-read", name: "read", input: { file_path: "/etc/hosts" } }],
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never, null, undefined, convId, "own prompt", Date.now(), callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(requests[0]).toEqual(["own prompt"]);
    expect(requests[1]?.at(-1)).toBe("queued earlier");
  });
});

describe("DB-first orchestrator persistence", () => {
  test("atomically reserves async preflight so a peer send queues and is delivered once", async () => {
    const parentId = id("admission-parent");
    const convId = id("admission-race");
    create(parentId, "openai", "gpt-5.6-sol");
    create(convId, "openai", "gpt-5.6-sol");
    const events: Array<Record<string, unknown>> = [];
    const daemonServer = server(events);
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCalls += 1;
      if (streamCalls === 1) await firstMayFinish;
      const text = streamCalls === 1 ? "first response" : "peer response";
      streamCallbacks.onText(text);
      return {
        text,
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 3,
      };
    }) as typeof streamMessage;
    const ext = callbacks(fakeStream);

    // The first call reserves ownership synchronously, before custom-tool
    // preflight yields. This is the window where Chrono replay and exo send
    // previously both observed idle.
    const firstTurn = orchestrateSendMessage(
      daemonServer as never,
      null,
      undefined,
      convId,
      "wake the sleeping target",
      Date.now(),
      ext,
    );
    // Cross-conversation messages now use daemon queue IPC, not the native tool.
    pushQueuedMessage(convId, "peer message during wake", "next-turn", undefined,
      undefined, undefined, undefined, undefined, { kind: "exo_send", sourceId: parentId });

    releaseFirst();
    expect((await firstTurn).ok).toBe(true);

    const persisted = loadPersisted(convId)!;
    expect(persisted.messages.map(message => message.role)).toEqual([
      "user", "assistant", "user", "assistant",
    ]);
    expect(persisted.messages.filter(message => message.role === "user").map(message => message.content)).toEqual([
      "wake the sleeping target",
      "peer message during wake",
    ]);
    expect(persisted.messages.some(message => (
      message.role === "system" && String(message.content).includes("Already streaming")
    ))).toBe(false);
    expect(streamCalls).toBe(2);
  });

  test("a losing direct producer reports Already streaming without persisting or stealing ownership", async () => {
    const convId = id("direct-admission-race");
    create(convId, "openai", "gpt-5.6-sol");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fakeStream = (async () => {
      await gate;
      return {
        text: "winner",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "winner" }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;
    const ext = callbacks(fakeStream);

    const winner = orchestrateSendMessage(
      server() as never, null, undefined, convId, "winner prompt", Date.now(), ext,
    );
    const loser = await orchestrateSendMessage(
      server() as never, null, undefined, convId, "loser prompt", Date.now(), ext,
    );
    expect(loser).toMatchObject({ ok: false, error: "Already streaming" });
    expect(loadPersisted(convId)?.messages.some(message => message.content === "loser prompt")).toBe(false);

    release();
    expect((await winner).ok).toBe(true);
    expect(loadPersisted(convId)?.messages.map(message => message.content)).toEqual([
      "winner prompt",
      [{ type: "text", text: "winner" }],
    ]);
  });

  test("releases an admission reservation after genuine preflight cancellation", async () => {
    const convId = id("cancelled-admission");
    create(convId, "openai", "gpt-5.6-sol");
    expect(requestHistoryUnwind(convId, "test-unwind", null)).toBe(true);
    let streamCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      throw new Error("provider should not run during unwind");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "blocked by unwind",
      Date.now(),
      callbacks(fakeStream),
    );

    expect(outcome).toMatchObject({ ok: false, error: "Conversation unwind in progress" });
    expect(streamCalls).toBe(0);
    expect(isStreaming(convId)).toBe(false);
    expect(loadPersisted(convId)?.messages).toEqual([]);
  });

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

  test("tags goal continuations in canonical history and the live user event", async () => {
    const convId = id("goal-automation");
    create(convId, "openai", "gpt-5.6-sol");
    const originalOrder = get(convId)!.sortOrder;
    create(id("goal-automation-newer"), "openai", "gpt-5.6-sol");
    setGoal(convId, "finish the migration");
    const events: Array<Record<string, unknown>> = [];
    const offeredToolNames: string[][] = [];
    let streamCall = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      offeredToolNames.push(tools.flatMap(tool => tool.name ? [tool.name] : []));
      streamCall += 1;
      if (streamCall === 1) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "goal-blocked", name: "goal", input: { action: "blocked", reason: "Need migration credentials." } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      streamCallbacks.onText("Blocked pending credentials.");
      return {
        text: "Blocked pending credentials.",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "Blocked pending credentials." }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 3,
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateGoalCycle(
      server(events) as never,
      convId,
      callbacks(fakeStream),
    );

    expect(outcome.ok).toBe(true);
    expect(streamCall).toBe(2);
    expect(offeredToolNames.every(names => names.includes("goal"))).toBe(true);
    expect(offeredToolNames.flat()).not.toContain("send_prompt");
    expect(loadPersisted(convId)!.sortOrder).toBe(originalOrder);
    expect(loadPersisted(convId)!.messages[0]?.metadata?.automation).toEqual({ kind: "goal_continuation" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "user_message",
      automation: { kind: "goal_continuation" },
    }));
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Need migration credentials.",
    });
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
    pushQueuedMessage(
      convId,
      "queued interjection",
      "next-turn",
      undefined,
      undefined,
      undefined,
      "queued-injection-id",
      undefined,
      { kind: "chrono_wake", sourceId: "chrono:test" },
    );
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
    expect(loadPersisted(convId)!.messages.at(-2)?.metadata).toMatchObject({
      queueEntryId: "queued-injection-id",
      automation: { kind: "chrono_wake", sourceId: "chrono:test" },
    });
  });

  test("keeps summaries streaming across a daemon-owned queued-turn handoff", async () => {
    const convId = id("queued-chain-summary");
    create(convId, "openai", "gpt-5.6-sol");
    get(convId)!.subagentMaxDepth = 3;
    const events: Array<Record<string, unknown>> = [];
    let streamCall = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCall += 1;
      const text = streamCall === 1 ? "first answer" : "queued answer";
      if (streamCall === 1) {
        pushQueuedMessage(convId, "queued follow-up", "message-end", undefined, undefined, undefined, "queued-chain-id");
      }
      streamCallbacks.onText(text);
      return {
        text,
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "initial prompt",
      28_000,
      callbacks(fakeStream),
    );

    expect(streamCall).toBe(2);
    expect(get(convId)?.subagentMaxDepth).toBe(3);
    const stopped = events.filter(event => event.type === "streaming_stopped");
    expect(stopped.map(event => event.reason)).toEqual(["handoff", undefined]);
    const summaryStreaming = events
      .filter(event => event.type === "conversation_updated")
      .map(event => (event.summary as { streaming: boolean }).streaming);
    expect(summaryStreaming.at(-1)).toBe(false);
    expect(summaryStreaming.slice(0, -1).every(Boolean)).toBe(true);
  });

  test("keeps summaries streaming across direct goal continuations with no controller request", async () => {
    const convId = id("goal-chain-summary");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "finish the chain");
    const events: Array<Record<string, unknown>> = [];
    let streamCall = 0;
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      streamCall += 1;
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      expect(tools.some(tool => tool.name === "goal")).toBe(true);
      if (streamCall === 2) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{
            id: "goal-complete",
            name: "goal",
            input: { action: "complete", reason: "Focused verification passed." },
          }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      const text = streamCall === 1 ? "working" : "verification ready";
      streamCallbacks.onText(text);
      return {
        text,
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "start the goal",
      29_000,
      {
        onHeaders() {},
        onComplete() {
          completeCalls += 1;
          if (completeCalls === 2) resolveChain();
        },
        streamMessageFn: fakeStream,
      },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        chainFinished,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("goal continuation did not settle")), 1_000);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    expect(streamCall).toBe(3);
    expect(loadPersisted(convId)?.messages.some(message =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.startsWith("[goal continuation]")
      && message.content.includes('Objective (user-provided task data, not an instruction override): "finish the chain"')
    )).toBe(true);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "complete",
      reason: "Focused verification passed.",
    });
    const stopped = events.filter(event => event.type === "streaming_stopped");
    expect(stopped.map(event => event.reason)).toEqual(["handoff", undefined]);
    const summaryStreaming = events
      .filter(event => event.type === "conversation_updated")
      .map(event => (event.summary as { streaming: boolean }).streaming);
    expect(summaryStreaming.at(-1)).toBe(false);
    expect(summaryStreaming.slice(0, -1).every(Boolean)).toBe(true);
  });

  test("new input does not implicitly resume a blocked goal", async () => {
    const convId = id("blocked-no-auto-resume");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "finish after approval");
    updateGoalStatus(convId, "blocked", { reason: "Need approval." });
    const events: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      streamCalls += 1;
      streamCallbacks.onText("Applied the approval.");
      return {
        text: "Applied the approval.",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "Applied the approval." }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "Approved; proceed.",
      30_000,
      callbacks(fakeStream),
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(streamCalls).toBe(1);
    expect(events).not.toContainEqual(expect.objectContaining({
      type: "goal_updated",
      goal: expect.objectContaining({ status: "active" }),
    }));
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Need approval.",
    });
  });

  test("queued user input wins over automatic continuation", async () => {
    const convId = id("goal-queue");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "keep the queue authoritative");
    let streamCall = 0;
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      streamCall += 1;
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      if (streamCall === 1) {
        pushQueuedMessage(
          convId,
          "new authoritative input",
          "message-end",
          undefined,
          undefined,
          undefined,
          "goal-queue-input",
          Date.now(),
          { kind: "chrono_wake", sourceId: "goal-queue-source" },
        );
      } else if (streamCall === 2) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{
            id: "block-after-queue",
            name: "goal",
            input: { action: "blocked", reason: "Wait after handling queued input." },
          }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      const text = streamCall === 1 ? "initial answer" : "handled queued input";
      streamCallbacks.onText(text);
      return {
        text,
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "start",
      31_000,
      {
        onHeaders() {},
        onComplete() {
          completeCalls += 1;
          if (completeCalls === 2) resolveChain();
        },
        streamMessageFn: fakeStream,
      },
    );
    await chainFinished;
    await new Promise(resolve => setTimeout(resolve, 0));

    const contents = loadPersisted(convId)!.messages.map(message => message.content);
    expect(contents).toContain("new authoritative input");
    expect(loadPersisted(convId)!.messages.find(message => message.content === "new authoritative input")?.metadata?.automation).toEqual({
      kind: "chrono_wake",
      sourceId: "goal-queue-source",
    });
    expect(contents.some(content => typeof content === "string" && content.startsWith("[goal continuation]"))).toBe(false);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Wait after handling queued input.",
    });
  });

  test("drains queued input when Stop cancels a continuation during async preflight", async () => {
    const convId = id("goal-preflight-queue-stop");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "old objective");
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCalls += 1;
      streamCallbacks.onText("handled queued input");
      return {
        text: "handled queued input",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "handled queued input" }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    // ensureConversationCustomTools always yields. Reproduce input queueing and
    // Stop synchronously while the selected continuation is still in preflight.
    const pending = orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));
    pushQueuedMessage(
      convId,
      "authoritative input queued before Stop",
      "message-end",
      undefined,
      undefined,
      undefined,
      "goal-preflight-stop-queue",
    );
    updateGoalStatus(convId, "paused", { reason: "Paused by user." });
    clearStreamHandoff(convId);

    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    expect(streamCalls).toBe(1);
    expect(getQueuedMessages(convId)).toEqual([]);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "paused",
      reason: "Paused by user.",
      turns: 0,
    });
    const persisted = loadPersisted(convId)!.messages;
    expect(persisted.some(message => message.content === "authoritative input queued before Stop")).toBe(true);
    expect(persisted.some(message =>
      message.role === "user" && message.metadata?.automation?.kind === "goal_continuation"
    )).toBe(false);
  });

  for (const action of ["clear", "complete"] as const) {
    test(`${action} during goal preflight preserves queued input without interrupting its handoff`, async () => {
      const convId = id(`goal-preflight-${action}`);
      create(convId, "openai", "gpt-5.6-sol");
      setGoal(convId, "old objective");
      let streamCalls = 0;
      const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
        streamCalls++;
        streamCallbacks.onText("handled queued input");
        return {
          text: "handled queued input", thinking: "", stopReason: "stop" as const,
          blocks: [{ type: "text" as const, text: "handled queued input" }],
          toolCalls: [], inputTokens: 10, outputTokens: 2,
        };
      }) as typeof streamMessage;

      const pending = orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));
      pushQueuedMessage(convId, "queued user input", "message-end");
      if (action === "clear") clearGoal(convId);
      else updateGoalStatus(convId, "complete", { reason: "Marked complete by user." });

      expect((await pending).ok).toBe(true);
      expect(streamCalls).toBe(1);
      expect(getQueuedMessages(convId)).toEqual([]);
      const persisted = loadPersisted(convId)!;
      expect(persisted.messages.some(message => message.content === "queued user input")).toBe(true);
      expect(persisted.messages.some(message => message.metadata?.automation?.kind === "goal_continuation")).toBe(false);
      if (action === "clear") expect(persisted.goal).toBeFalsy();
      else expect(persisted.goal?.status).toBe("complete");
    });
  }

  test("replacement during goal preflight refreshes the prompt without another handoff", async () => {
    const convId = id("goal-preflight-live-replacement");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "obsolete objective");
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCalls++;
      streamCallbacks.onText("worked on replacement");
      return {
        text: "worked on replacement", thinking: "", stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "worked on replacement" }],
        toolCalls: [], inputTokens: 10, outputTokens: 2,
      };
    }) as typeof streamMessage;
    const pending = orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));
    setGoal(convId, "replacement objective", { maxTurns: 1 });

    expect((await pending).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(streamCalls).toBe(1);
    const persisted = loadPersisted(convId)!;
    const prompts = persisted.messages.filter(message => message.metadata?.automation?.kind === "goal_continuation");
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]?.content)).toContain('"replacement objective"');
    expect(String(prompts[0]?.content)).not.toContain("obsolete objective");
    expect(persisted.goal).toMatchObject({
      objective: "replacement objective", status: "blocked", turns: 1, maxTurns: 1,
      reason: "Continuation budget exhausted. Set the goal with a larger budget to continue.",
    });
  });

  test("a stale preflight cannot consume a newer goal handoff after Stop and replacement", async () => {
    const convId = id("goal-preflight-replacement");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "obsolete objective");
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCalls += 1;
      streamCallbacks.onText("worked only on the replacement");
      return {
        text: "worked only on the replacement",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "worked only on the replacement" }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    const stale = orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));
    updateGoalStatus(convId, "paused", { reason: "Stopped by user." });
    clearStreamHandoff(convId);
    setGoal(convId, "replacement objective", { maxTurns: 1 });
    const replacement = orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));

    const [staleOutcome, replacementOutcome] = await Promise.all([stale, replacement]);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(staleOutcome).toMatchObject({ ok: false, error: "Turn handoff cancelled." });
    expect(replacementOutcome.ok).toBe(true);
    expect(streamCalls).toBe(1);
    const continuationMessages = loadPersisted(convId)!.messages.filter(message =>
      message.role === "user" && message.metadata?.automation?.kind === "goal_continuation"
    );
    expect(continuationMessages).toHaveLength(1);
    expect(String(continuationMessages[0]?.content)).toContain('"replacement objective"');
    expect(String(continuationMessages[0]?.content)).not.toContain("obsolete objective");
    expect(loadPersisted(convId)?.goal).toMatchObject({
      objective: "replacement objective",
      status: "blocked",
      turns: 1,
      maxTurns: 1,
      reason: "Continuation budget exhausted. Set the goal with a larger budget to continue.",
    });
  });

  test("an explicit abort pauses an active goal instead of continuing it", async () => {
    const convId = id("goal-abort-pause");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "pause on interruption");
    let streamCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, _streamCallbacks, options) => {
      streamCalls += 1;
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      getActiveJob(convId)!.abort("user");
      throw new Error("interrupted");
    }) as typeof streamMessage;

    const outcome = await orchestrateSendMessage(
      server() as never,
      null,
      undefined,
      convId,
      "start",
      31_500,
      callbacks(fakeStream),
    );
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(outcome).toMatchObject({ ok: false, aborted: true });
    expect(streamCalls).toBe(1);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "paused",
      reason: "Interrupted. Resume explicitly to continue.",
    });
    expect(loadPersisted(convId)!.messages.some(message =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.startsWith("[goal continuation]")
    )).toBe(false);
  });

  test("a daemon-restart abort leaves an active goal resumable", async () => {
    const convId = id("goal-daemon-restart");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "survive daemon restart");
    let streamCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      getActiveJob(convId)!.abort("daemon-restart");
      throw new Error("transport closed for restart");
    }) as typeof streamMessage;

    const outcome = await orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(outcome).toMatchObject({
      ok: false,
      aborted: true,
      daemonRestart: true,
      error: "✗ Daemon restarted",
    });
    expect(streamCalls).toBe(1);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "active",
      objective: "survive daemon restart",
      turns: 1,
    });
  });

  test("blocks after two consecutive empty successful continuation turns", async () => {
    const convId = id("goal-empty");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "do not spin");
    let streamCalls = 0;
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, _streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      streamCalls += 1;
      return {
        text: "",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 0,
      };
    }) as typeof streamMessage;

    await orchestrateGoalCycle(server() as never, convId, {
      onHeaders() {},
      onComplete() {
        completeCalls += 1;
        if (completeCalls === 2) resolveChain();
      },
      streamMessageFn: fakeStream,
    });
    await chainFinished;
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(streamCalls).toBe(2);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      turns: 2,
      emptyTurns: 2,
      reason: "Two consecutive empty responses. Check the provider before resuming.",
    });
  });

  test("counts the final allowed continuation and blocks before exceeding maxTurns", async () => {
    const convId = id("goal-budget");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "make bounded progress", { maxTurns: 2 });
    const events: Array<Record<string, unknown>> = [];
    let streamCalls = 0;
    let completeCalls = 0;
    let resolveAllowedTurns!: () => void;
    const allowedTurnsFinished = new Promise<void>(resolve => { resolveAllowedTurns = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "goal")).toBe(true);
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      streamCalls += 1;
      const text = `bounded turn ${streamCalls}`;
      streamCallbacks.onText(text);
      return {
        text,
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text }],
        toolCalls: [],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    await orchestrateGoalCycle(server(events) as never, convId, {
      onHeaders() {},
      onComplete() {
        completeCalls += 1;
        if (completeCalls === 2) resolveAllowedTurns();
      },
      streamMessageFn: fakeStream,
    });
    await allowedTurnsFinished;
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(streamCalls).toBe(2);
    expect(loadPersisted(convId)?.messages.filter(message =>
      message.role === "user"
      && message.metadata?.automation?.kind === "goal_continuation"
    )).toHaveLength(2);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      turns: 2,
      maxTurns: 2,
      reason: "Continuation budget exhausted. Set the goal with a larger budget to continue.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "goal_updated",
      message: "Goal continuation budget exhausted.",
      goal: expect.objectContaining({ status: "blocked", turns: 2 }),
    }));
  });

  test("terminal continuation errors block the goal", async () => {
    const convId = id("goal-error");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "stop on terminal errors");
    const fakeStream = (async () => {
      throw new Error("terminal provider failure");
    }) as typeof streamMessage;

    const outcome = await orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));

    expect(outcome.ok).toBe(false);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Error: terminal provider failure",
    });
  });

  test("chat-only models block goal continuation before provider work", async () => {
    const convId = id("goal-tool-excluded");
    const conv = create(convId, "openrouter", "nousresearch/hermes-4-405b");
    conv.toolPolicy = { internal: [], external: [] };
    setGoal(convId, "must have a status tool");
    let streamCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      throw new Error("provider must not be called");
    }) as typeof streamMessage;

    const outcome = await orchestrateGoalCycle(server() as never, convId, callbacks(fakeStream));

    expect(outcome).toMatchObject({
      ok: false,
      error: "Goal cannot continue without its status tool.",
    });
    expect(streamCalls).toBe(0);
    expect(loadPersisted(convId)?.goal).toMatchObject({
      status: "blocked",
      turns: 0,
      reason: "Select a tool-capable model, then resume.",
    });
  });

  test.each(["sleep", "wait"] as const)("a goal suspended by Chrono %s remains active and is not auto-continued", async (operation) => {
    const convId = id("goal-suspended");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "wait rather than spin");
    setBackgroundTaskActive(convId, "bash:goal-build", true, { title: "build", startedAt: 1 });
    let streamCalls = 0;
    const sleepStream = (async (_provider, _messages, _model, _streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      expect(tools.some(tool => tool.name === "send_prompt")).toBe(false);
      streamCalls += 1;
      return {
        text: "",
        thinking: "",
        stopReason: "tool_use" as const,
        blocks: [],
        toolCalls: [{ id: "goal-sleep", name: "chrono", input: operation === "sleep"
          ? { action: "sleep", duration: "10m" } : { action: "wait", task_id: "bash:goal-build", max_wait: "10m" } }],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    const outcome = await orchestrateGoalCycle(server() as never, convId, callbacks(sleepStream));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(outcome).toMatchObject({ ok: true, suspended: true });
    expect(streamCalls).toBe(1);
    expect(loadPersisted(convId)?.goal).toMatchObject({ status: "active", turns: 1 });
    expect(listDeferredChronoSleeps(convId)).toHaveLength(1);
  });

  test.each(["sleep", "wait"] as const)("orchestrateGoalCycle does not wake an already deferred Chrono %s", async (operation) => {
    const convId = id("goal-already-sleeping");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "wait for the scheduled wake");
    setBackgroundTaskActive(convId, "bash:goal-build", true, { title: "build", startedAt: 1 });
    let streamCalls = 0;
    const sleepStream = (async () => {
      streamCalls += 1;
      return {
        text: "",
        thinking: "",
        stopReason: "tool_use" as const,
        blocks: [],
        toolCalls: [{ id: "existing-goal-sleep", name: "chrono", input: operation === "sleep"
          ? { action: "sleep", duration: "10m" } : { action: "wait", task_id: "bash:goal-build", max_wait: "10m" } }],
        inputTokens: 10,
        outputTokens: 2,
      };
    }) as typeof streamMessage;

    const sleeping = await orchestrateGoalCycle(server() as never, convId, callbacks(sleepStream));
    expect(sleeping).toMatchObject({ ok: true, suspended: true });
    const [deferred] = listDeferredChronoSleeps(convId);
    expect(deferred).toBeTruthy();

    const skipped = await orchestrateGoalCycle(server() as never, convId, callbacks(sleepStream));

    expect(skipped.ok).toBe(true);
    expect(skipped.suspended).toBeUndefined();
    expect(streamCalls).toBe(1);
    expect(listDeferredChronoSleeps(convId)).toEqual([deferred!]);
    expect(loadPersisted(convId)?.goal).toMatchObject({ status: "active", turns: 1 });
  });

  test.each(["sleep", "wait"] as const)("suspends a long Chrono %s without marking it unread, then resumes it before a user message", async (operation) => {
    const convId = id("deferred-chrono-sleep");
    create(convId, "openai", "gpt-5.6-sol");
    setBackgroundTaskActive(convId, "bash:build", true, { title: "build", startedAt: 1 });
    const events: Array<Record<string, unknown>> = [];
    const sleepStream = (async () => ({
      text: "",
      thinking: "",
      stopReason: "tool_use" as const,
      blocks: [],
      toolCalls: [{ id: "long-sleep-call", name: "chrono", input: operation === "sleep"
        ? { action: "sleep", duration: "10m" } : { action: "wait", task_id: "bash:build", max_wait: "10m" } }],
      inputTokens: 10,
      outputTokens: 2,
    })) as typeof streamMessage;

    const sleeping = await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "sleep for ten minutes",
      28_000,
      callbacks(sleepStream),
    );

    expect(sleeping).toMatchObject({ ok: true, suspended: true });
    expect(getActiveJob(convId)).toBeUndefined();
    expect(isUnread(convId)).toBe(false);
    expect(listDeferredChronoSleeps(convId)).toHaveLength(1);
    expect(loadPersisted(convId)!.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "streaming_stopped", convId, reason: "suspended" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "conversation_updated",
      streamStopReason: "suspended",
      summary: expect.objectContaining({ id: convId, streaming: false }),
    }));

    let resumedInput: import("./messages").ApiMessage[] | null = null;
    const resumeStream = (async (_provider, messages) => {
      resumedInput = structuredClone(messages);
      return {
        text: "resumed after interruption",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "resumed after interruption" }],
        toolCalls: [],
        inputTokens: 20,
        outputTokens: 4,
      };
    }) as typeof streamMessage;
    const resumed = await orchestrateSendMessage(
      server(events) as never,
      null,
      undefined,
      convId,
      "wake up early",
      Date.now(),
      callbacks(resumeStream),
    );

    expect(resumed.ok).toBe(true);
    expect(listDeferredChronoSleeps(convId)).toHaveLength(0);
    expect(resumedInput!.map(message => message.role)).toEqual(["user", "assistant", "user", "user"]);
    const toolResultMessage = resumedInput![2]!;
    expect(toolResultMessage.content).toContainEqual(expect.objectContaining({
      type: "tool_result",
      tool_use_id: "long-sleep-call",
      content: expect.stringContaining(operation === "sleep" ? "Sleep interrupted after" : "wait_interrupted"),
    }));
    expect(loadPersisted(convId)!.messages.map(message => message.role)).toEqual([
      "user", "assistant", "user", "user", "assistant",
    ]);
  });

  test.each(["sleep", "wait"] as const)("Chrono %s suspension destroys rather than parks the provider transport", async (operation) => {
    const convId = id(`transport-${operation}`);
    create(convId, "openai", "gpt-5.6-sol");
    setBackgroundTaskActive(convId, "bash:transport-test", true, { title: "build", startedAt: 1 });
    const adapter = getProviderAdapter("openai");
    const originalStream = adapter.streamMessage;
    const originalSession = adapter.createTurnSession;
    const originalCredentials = adapter.auth.hasConfiguredCredentials;
    const session = { close: mock(() => {}), destroy: mock(() => {}) };
    // These cases run in an isolated child process. Replace the transport at
    // the adapter boundary, leaving real orchestrator session ownership intact.
    adapter.auth.hasConfiguredCredentials = () => true;
    invalidateCredentialsCache("openai");
    adapter.createTurnSession = () => session;
    adapter.streamMessage = async (_messages, _model, _callbacks, options) => {
      expect(options?.turnSession).toBe(session);
      return {
        text: "", thinking: "", stopReason: "tool_use", blocks: [], inputTokens: 10, outputTokens: 2,
        toolCalls: [{ id: "transport-call", name: "chrono", input: operation === "sleep"
          ? { action: "sleep", duration: "10m" }
          : { action: "wait", task_id: "bash:transport-test", max_wait: "10m" } }],
      };
    };
    try {
      const outcome = await orchestrateSendMessage(
        server() as never, null, undefined, convId, "suspend transport", Date.now(),
        { onHeaders() {}, onComplete() {} },
      );
      expect(outcome).toMatchObject({ ok: true, suspended: true });
      expect(session.destroy).toHaveBeenCalledTimes(1);
      expect(session.close).not.toHaveBeenCalled();
    } finally {
      adapter.streamMessage = originalStream;
      adapter.createTurnSession = originalSession;
      adapter.auth.hasConfiguredCredentials = originalCredentials;
      invalidateCredentialsCache("openai");
    }
  });

  test("a detached peer wake owns the interrupted sleep through completion without a false failure", async () => {
    const parentId = id("sleep-peer-parent");
    const convId = id("sleep-peer-target");
    create(parentId, "openai", "gpt-5.6-sol");
    create(convId, "openai", "gpt-5.6-sol");
    const daemonServer = server();
    const sleepStream = (async () => ({
      text: "",
      thinking: "",
      stopReason: "tool_use" as const,
      blocks: [],
      toolCalls: [{ id: "peer-wake-sleep-call", name: "chrono", input: { action: "sleep", duration: "15m" } }],
      inputTokens: 10,
      outputTokens: 2,
    })) as typeof streamMessage;
    expect(await orchestrateSendMessage(
      daemonServer as never,
      null,
      undefined,
      convId,
      "sleep for fifteen minutes",
      Date.now(),
      callbacks(sleepStream),
    )).toMatchObject({ ok: true, suspended: true });

    let releasePeer!: () => void;
    const peerMayFinish = new Promise<void>((resolve) => { releasePeer = resolve; });
    let peerStarted!: () => void;
    const peerDidStart = new Promise<void>((resolve) => { peerStarted = resolve; });
    const peerStream = (async (_provider, _messages, _model, streamCallbacks) => {
      peerStarted();
      await peerMayFinish;
      streamCallbacks.onText("peer work accepted");
      return {
        text: "peer work accepted",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "peer work accepted" }],
        toolCalls: [],
        inputTokens: 20,
        outputTokens: 4,
      };
    }) as typeof streamMessage;
    const ext = callbacks(peerStream);
    const beginParentNotification = mock(() => {});
    const completeParentNotification = mock((
      _convId: string,
      _outcome: import("./orchestrator").AssistantTurnOutcome,
    ) => {});
    let peerTurn: Promise<import("./orchestrator").AssistantTurnOutcome> | undefined;
    let chronoReplayCalls = 0;
    configureChronoService(null, async (sleep) => {
      chronoReplayCalls += 1;
      const outcome = await orchestrateReplayConversation(
        daemonServer as never,
        null,
        undefined,
        sleep.conversationId,
        Date.now(),
        ext,
      );
      if (!outcome.suspended) completeParentNotification(sleep.conversationId, outcome);
    });

    // Existing-target work now enters through direct daemon IPC.
    beginParentNotification();
    peerTurn = orchestrateSendMessage(daemonServer as never, null, undefined, convId,
      "implement the narrow receipt fix", Date.now(), ext, undefined,
      { automation: { kind: "exo_send", sourceId: parentId } });
    void peerTurn.then(outcome => {
      if (!outcome.suspended) completeParentNotification(convId, outcome);
    });
    await peerDidStart;

    // Drive the durable 30-second recovery deadline without sleeping in the
    // test. The active peer turn owns this early wake, so Chrono must not start
    // a replay or settle its detached notification.
    await chronoInternalsForTest.processPendingAndDue(Date.now() + 31_000);
    await Bun.sleep(0);
    expect(chronoReplayCalls).toBe(0);
    expect(completeParentNotification).not.toHaveBeenCalled();
    expect(listDeferredChronoSleeps(convId)).toHaveLength(1);

    releasePeer();
    expect(await peerTurn!).toMatchObject({ ok: true });
    await Bun.sleep(0);
    expect(completeParentNotification).toHaveBeenCalledTimes(1);
    expect(completeParentNotification).toHaveBeenCalledWith(
      convId,
      expect.objectContaining({ ok: true }),
    );
    expect((completeParentNotification.mock.calls[0]?.[1] as { error?: string }).error).toBeUndefined();
    expect(listDeferredChronoSleeps(convId)).toHaveLength(0);
    expect(loadPersisted(convId)!.messages.filter(message => message.role === "user").map(message => (
      typeof message.content === "string" ? message.content : "tool_result"
    ))).toEqual([
      "sleep for fifteen minutes",
      "tool_result",
      "implement the narrow receipt fix",
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
