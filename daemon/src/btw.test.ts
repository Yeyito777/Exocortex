import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { BTW_READ_ONLY_TOOLS, BtwSessionManager } from "./btw";
import * as convStore from "./conversations";
import type { Event } from "./protocol";
import type { ConnectedClient, DaemonServer } from "./server";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, initStreamingState, setActiveJob } from "./streaming";
import { buildExecutor, getToolDefs } from "./tools/registry";

type RunAgentLoop = typeof import("./agent").runAgentLoop;

describe("BTW read-only tool boundary", () => {
  test("advertises exactly the four approved read-only tools", () => {
    expect(getToolDefs(BTW_READ_ONLY_TOOLS).map(tool => tool.name)).toEqual([
      "read",
      "glob",
      "grep",
      "browse",
    ]);
  });

  test("executor rejects a mutating tool even if a provider fabricates the call", async () => {
    const executor = buildExecutor(undefined, BTW_READ_ONLY_TOOLS);
    const [result] = await executor([{
      id: "forbidden-write",
      name: "write",
      input: { file_path: "/tmp/btw-must-not-write", content: "nope" },
    }]);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Tool unavailable in this session: write");
  });
});

describe("BTW session isolation", () => {
  test("freezes context, copies model settings, streams privately, and aborts on explicit close", async () => {
    const convId = `test-btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = convStore.create(convId, "deepseek", "deepseek-v4-pro", "BTW source", "high", true);
    conv.messages.push({ role: "user", content: "frozen source text", metadata: null });
    const sourceAbort = new AbortController();
    setActiveJob(convId, sourceAbort, 100);
    initStreamingState(convId);
    appendToStreamingBlock(convId, "text", "unfinished source assistant output");

    const events: Event[] = [];
    const server = {
      sendTo(_client: ConnectedClient, event: Event) {
        events.push(event);
        return 0;
      },
    } as unknown as DaemonServer;
    const socket = new EventEmitter() as ConnectedClient["socket"];
    const client = {
      id: "btw-test-client",
      socket,
      subscriptions: new Set<string>(),
      buffer: "",
      capabilities: new Set<"history-pagination">(),
    };

    type CapturedRun = {
      messages: Parameters<RunAgentLoop>[0];
      provider: Parameters<RunAgentLoop>[1];
      model: Parameters<RunAgentLoop>[2];
      options: NonNullable<Parameters<RunAgentLoop>[4]>;
    };
    let captured: CapturedRun | null = null;
    const fakeRunAgentLoop = ((messages, provider, model, callbacks, options) => {
      if (!options) throw new Error("BTW must pass agent options");
      captured = { messages, provider, model, options };
      callbacks.onBlockStart("text");
      callbacks.onTextChunk("partial answer");
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;

    let settledCount = 0;
    const manager = new BtwSessionManager(server, {
      onHeaders() {},
      onComplete() { settledCount += 1; },
    }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
    });

    try {
      manager.start(client, {
        type: "btw_query",
        sessionId: "session-1",
        convId,
        query: "answer from the snapshot",
        startedAt: 123,
      });

      expect(captured).not.toBeNull();
      const run = captured as unknown as CapturedRun;
      expect(run.provider).toBe("deepseek");
      expect(run.model).toBe("deepseek-v4-pro");
      expect(run.options.effort).toBe("high");
      expect(run.options.serviceTier).toBe("fast");
      expect(run.options.promptCacheKey).toBe(`${convId}:btw:session-1`);
      expect(run.options.getCodexWindowId?.()).toBe(`${convId}:0:btw:session-1`);
      expect((run.options.tools as Array<{ name: string }>).map(tool => tool.name)).toEqual([
        "read", "glob", "grep", "browse",
      ]);
      expect(run.messages.at(-1)).toEqual({ role: "user", content: "answer from the snapshot" });
      expect(JSON.stringify(run.messages)).not.toContain("unfinished source assistant output");

      // The model input is a deep snapshot, not an alias of the live transcript.
      conv.messages[0].content = "source changed after BTW started";
      expect(run.messages[0].content).toBe("frozen source text");
      expect(events.some(event => event.type === "btw_text_chunk" && event.text === "partial answer")).toBe(true);
      expect(manager.hasRunningProvider("deepseek")).toBe(true);

      expect(manager.close(client, "session-1")).toBe(true);
      expect(run.options.signal?.aborted).toBe(true);
      expect(sourceAbort.signal.aborted).toBe(false);
      expect(events.at(-1)).toEqual({ type: "btw_closed", sessionId: "session-1" });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(manager.hasRunningProvider("deepseek")).toBe(false);
      expect(settledCount).toBe(1);
      expect(events.some(event => event.type === "btw_error")).toBe(false);

      manager.start(client, {
        type: "btw_query",
        sessionId: "session-2",
        convId,
        query: "a second isolated copy",
        startedAt: 456,
      });
      const secondRun = captured as unknown as CapturedRun;
      expect(secondRun.options.promptCacheKey).toBe(`${convId}:btw:session-2`);
      expect(secondRun.options.promptCacheKey).not.toBe(run.options.promptCacheKey);
      const eventsBeforeDisconnect = events.length;
      socket.emit("close");
      expect(secondRun.options.signal?.aborted).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(settledCount).toBe(2);
      expect(events).toHaveLength(eventsBeforeDisconnect);
      expect(events.some(event => event.type === "btw_finished" || event.type === "btw_error")).toBe(false);
    } finally {
      clearActiveJob(convId);
      clearCurrentStreamingBlocks(convId);
      convStore.remove(convId);
    }
  });
});
