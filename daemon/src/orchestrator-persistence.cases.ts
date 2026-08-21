import { afterEach, describe, expect, test } from "bun:test";
import { clearHistoryUnwindPending, create, getActiveJob, getQueuedMessages, isUnread, pushQueuedMessage, remove, requestHistoryUnwind, setGoal, updateGoalStatus } from "./conversations";
import { load as loadPersisted } from "./persistence";
import { orchestrateGoalCycle, orchestrateSendMessage, type OrchestrationCallbacks } from "./orchestrator";
import { streamMessage } from "./api";
import { chronoInternalsForTest, listDeferredChronoSleeps } from "./chrono-service";

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

  test("tags goal continuations in canonical history and the live user event", async () => {
    const convId = id("goal-automation");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "finish the migration");
    const events: Array<Record<string, unknown>> = [];
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      if (tools.some(tool => tool.name === "send_prompt")) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "goal-next", name: "send_prompt", input: { prompt: "Finish the migration verification." } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      updateGoalStatus(convId, "paused");
      streamCallbacks.onText("paused for review");
      return {
        text: "paused for review",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "paused for review" }],
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
    expect(loadPersisted(convId)!.messages[0]?.metadata?.automation).toEqual({ kind: "goal_continuation" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "user_message",
      automation: { kind: "goal_continuation" },
    }));
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
    const stopped = events.filter(event => event.type === "streaming_stopped");
    expect(stopped.map(event => event.reason)).toEqual(["handoff", undefined]);
    const summaryStreaming = events
      .filter(event => event.type === "conversation_updated")
      .map(event => (event.summary as { streaming: boolean }).streaming);
    expect(summaryStreaming.at(-1)).toBe(false);
    expect(summaryStreaming.slice(0, -1).every(Boolean)).toBe(true);
  });

  test("keeps summaries streaming across a hidden goal review and selected continuation", async () => {
    const convId = id("goal-chain-summary");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "finish the chain");
    const events: Array<Record<string, unknown>> = [];
    let streamCall = 0;
    let controllerCall = 0;
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      streamCall += 1;
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      const isController = tools.some(tool => tool.name === "send_prompt");
      if (isController) {
        controllerCall += 1;
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: controllerCall === 1
            ? [{ id: "goal-next", name: "send_prompt", input: { prompt: "Finish the focused verification." } }]
            : [{ id: "goal-pause", name: "goal_pause", input: { reason: "Need user review." } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      const text = controllerCall === 0 ? "working" : "verification ready";
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
          if (completeCalls === 4) resolveChain();
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

    expect(streamCall).toBe(4);
    expect(loadPersisted(convId)?.messages.some(message => message.role === "user" && message.content === "[goal continuation]\n\nActive goal: finish the chain\n\nFinish the focused verification.")).toBe(true);
    expect(loadPersisted(convId)?.goal).toMatchObject({ status: "paused", pausedBy: "controller" });
    const stopped = events.filter(event => event.type === "streaming_stopped");
    expect(stopped.map(event => event.reason)).toEqual(["handoff", "handoff"]);
    const summaryStreaming = events
      .filter(event => event.type === "conversation_updated")
      .map(event => (event.summary as { streaming: boolean }).streaming);
    expect(summaryStreaming.at(-1)).toBe(false);
    expect(summaryStreaming.slice(0, -1).every(Boolean)).toBe(true);
  });

  test("new input automatically resumes a controller-paused goal before the worker turn", async () => {
    const convId = id("controller-pause-resume");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "finish after approval");
    updateGoalStatus(convId, "paused", { pausedBy: "controller", reason: "Need approval." });
    const events: Array<Record<string, unknown>> = [];
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      if (tools.some(tool => tool.name === "send_prompt")) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "goal-complete", name: "goal_complete", input: { reason: "Approval applied." } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
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

    expect(events).toContainEqual(expect.objectContaining({
      type: "goal_updated",
      message: "Goal resumed from new input.",
      goal: expect.objectContaining({ status: "active" }),
    }));
    expect(loadPersisted(convId)?.goal ?? null).toBeNull();
  });

  test("queued user input supersedes a goal decision made from an older snapshot", async () => {
    const convId = id("goal-review-queue");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "keep the queue authoritative");
    let controllerCall = 0;
    let completeCalls = 0;
    let announceController!: () => void;
    let releaseController!: () => void;
    let resolveChain!: () => void;
    const controllerStarted = new Promise<void>(resolve => { announceController = resolve; });
    const controllerRelease = new Promise<void>(resolve => { releaseController = resolve; });
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      if (tools.some(tool => tool.name === "send_prompt")) {
        controllerCall += 1;
        if (controllerCall === 1) {
          announceController();
          await controllerRelease;
          return {
            text: "",
            thinking: "",
            stopReason: "tool_use" as const,
            blocks: [],
            toolCalls: [{ id: "stale-next", name: "send_prompt", input: { prompt: "This stale instruction must be discarded." } }],
            inputTokens: 10,
            outputTokens: 2,
          };
        }
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use" as const,
          blocks: [],
          toolCalls: [{ id: "pause-after-queue", name: "goal_pause", input: { reason: "Wait after handling queued input." } }],
          inputTokens: 10,
          outputTokens: 2,
        };
      }
      streamCallbacks.onText("worker answer");
      return {
        text: "worker answer",
        thinking: "",
        stopReason: "stop" as const,
        blocks: [{ type: "text" as const, text: "worker answer" }],
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
          if (completeCalls === 4) resolveChain();
        },
        streamMessageFn: fakeStream,
      },
    );
    await controllerStarted;
    pushQueuedMessage(
      convId,
      "new authoritative input",
      "message-end",
      undefined,
      undefined,
      undefined,
      "goal-queue-input",
      Date.now(),
      { kind: "chrono_wake", sourceId: "goal-review-queue-source" },
    );
    releaseController();
    await chainFinished;
    await new Promise(resolve => setTimeout(resolve, 0));

    const contents = loadPersisted(convId)!.messages.map(message => message.content);
    expect(contents).toContain("new authoritative input");
    expect(loadPersisted(convId)!.messages.find(message => message.content === "new authoritative input")?.metadata?.automation).toEqual({
      kind: "chrono_wake",
      sourceId: "goal-review-queue-source",
    });
    expect(contents).not.toContain("[goal continuation]\n\nActive goal: keep the queue authoritative\n\nThis stale instruction must be discarded.");
    expect(loadPersisted(convId)?.goal).toMatchObject({ status: "paused", pausedBy: "controller" });
  });

  test("drains queued input when a manual goal change aborts the hidden review", async () => {
    const convId = id("goal-review-abort-queue");
    create(convId, "openai", "gpt-5.6-sol");
    setGoal(convId, "keep queued input durable");
    let workerCalls = 0;
    let completeCalls = 0;
    let resolveChain!: () => void;
    const chainFinished = new Promise<void>(resolve => { resolveChain = resolve; });
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks, options) => {
      const tools = (options?.tools ?? []) as Array<{ name?: string }>;
      if (tools.some(tool => tool.name === "send_prompt")) {
        pushQueuedMessage(convId, "input queued before manual pause", "message-end", undefined, undefined, undefined, "goal-abort-queue-input");
        updateGoalStatus(convId, "paused", { pausedBy: "user" });
        getActiveJob(convId)!.abort("goal-state-changed");
        throw new Error("controller interrupted by manual pause");
      }
      workerCalls += 1;
      const text = workerCalls === 1 ? "initial answer" : "handled queued input";
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
      31_500,
      {
        onHeaders() {},
        onComplete() {
          completeCalls += 1;
          if (completeCalls === 3) resolveChain();
        },
        streamMessageFn: fakeStream,
      },
    );
    await chainFinished;
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(workerCalls).toBe(2);
    expect(getQueuedMessages(convId)).toEqual([]);
    expect(loadPersisted(convId)!.messages.map(message => message.content)).toContain("input queued before manual pause");
    expect(loadPersisted(convId)?.goal).toMatchObject({ status: "paused", pausedBy: "user" });
    expect(loadPersisted(convId)!.messages.some(message => message.role === "system" && String(message.content).includes("Goal controller failed"))).toBe(false);
  });

  test("stops a long Chrono sleep turn without marking it unread, then resumes it before a user message", async () => {
    const convId = id("deferred-chrono-sleep");
    create(convId, "openai", "gpt-5.6-sol");
    const events: Array<Record<string, unknown>> = [];
    const sleepStream = (async () => ({
      text: "",
      thinking: "",
      stopReason: "tool_use" as const,
      blocks: [],
      toolCalls: [{ id: "long-sleep-call", name: "chrono", input: { action: "sleep", duration: "10m" } }],
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
    expect(events).toContainEqual(expect.objectContaining({ type: "streaming_stopped", convId }));

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
      content: expect.stringContaining("Sleep interrupted after"),
    }));
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
