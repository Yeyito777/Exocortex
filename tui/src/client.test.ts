import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { unlinkSync } from "fs";
import { DaemonClient } from "./client";
import { turnRequestStartedAt } from "./request-ids";
import type { Command, DaemonShutdownMode } from "./protocol";

const testServers: Server[] = [];
const testSockets: string[] = [];

afterEach(async () => {
  for (const server of testServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const path of testSockets.splice(0)) {
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

describe("DaemonClient request-scoped events", () => {
  test("prewarms reserved drafts and existing conversations without creating either", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;
    client.prewarmConversation("reserved", true);
    client.prewarmConversation("existing");
    expect(writes.map(value => JSON.parse(value))).toEqual([
      { type: "prewarm_conversation", convId: "reserved", draft: true },
      { type: "prewarm_conversation", convId: "existing" },
    ]);
  });

  test("sends defaults mutations only to the active transport and never queues them offline", () => {
    const events: unknown[] = [];
    const client = new DaemonClient(event => events.push(event));
    const internal = client as any;
    const defaults = { provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false } as const;
    client.setConversationDefaults(defaults);
    client.resetConversationDefaults();
    expect(internal.pendingCommands).toEqual([]);
    expect(events).toHaveLength(2);
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;
    client.setConversationDefaults(defaults);
    client.resetConversationDefaults();
    expect(writes.map(value => JSON.parse(value))).toEqual([
      { type: "set_conversation_defaults", reqId: expect.any(String), defaults },
      { type: "reset_conversation_defaults", reqId: expect.any(String) },
    ]);
  });

  test("handles SSH status controls in the TUI without writing daemon protocol", () => {
    const events: unknown[] = [];
    const client = new DaemonClient(event => events.push(event), undefined, false, {
      localHostname: "localbox",
    });
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    client.ssh("status");
    client.ssh("cancel");

    expect(writes).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({ type: "ssh_status", mode: "local", state: "connected", switched: false }),
      expect.objectContaining({ type: "ssh_status", mode: "local", state: "connected", switched: false }),
    ]);
  });

  test("parses a fragmented event followed by another event in the same socket chunk", () => {
    const events: unknown[] = [];
    const client = new DaemonClient((event) => events.push(event));
    const internal = client as any;
    const first = JSON.stringify({ type: "error", message: "fragmented" });
    const split = Math.floor(first.length / 2);

    internal.onData(Buffer.from(first.slice(0, split)));
    expect(events).toEqual([]);

    internal.onData(Buffer.from(
      first.slice(split) + "\n" + JSON.stringify({ type: "error", message: "packed" }) + "\n",
    ));
    expect(events).toEqual([
      { type: "error", message: "fragmented" },
      { type: "error", message: "packed" },
    ]);
  });

  test("a throwing event handler never writes to the terminal and later events still flow", () => {
    const events: unknown[] = [];
    const client = new DaemonClient((event) => {
      if ((event as { message?: string }).message === "throws") throw new Error("handler bug");
      events.push(event);
    });
    const originalError = console.error;
    const originalWrite = process.stderr.write;
    const terminalWrites: unknown[] = [];
    console.error = (...args: unknown[]) => { terminalWrites.push(args); };
    process.stderr.write = ((chunk: unknown) => { terminalWrites.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      (client as any).onData(Buffer.from(
        JSON.stringify({ type: "error", message: "throws" }) + "\n" + JSON.stringify({ type: "error", message: "after" }) + "\n",
      ));
    } finally {
      console.error = originalError;
      process.stderr.write = originalWrite;
    }
    expect(terminalWrites).toEqual([]);
    expect(events).toEqual([{ type: "error", message: "after" }]);
  });

  test("does not forward transcription callback errors to the global handler", () => {
    const events: unknown[] = [];
    const errors: string[] = [];
    const client = new DaemonClient((event) => {
      events.push(event);
    });

    const internal = client as any;
    internal.transcriptionCallbacks.set("req-1", {
      onSuccess() {},
      onError(message: string) {
        errors.push(message);
      },
    });

    internal.onData(Buffer.from(JSON.stringify({
      type: "error",
      reqId: "req-1",
      message: "Voice transcription failed: OpenAI transcription returned a null result",
    }) + "\n"));

    expect(errors).toEqual([
      "Voice transcription failed: OpenAI transcription returned a null result",
    ]);
    expect(events).toEqual([]);
    expect(internal.transcriptionCallbacks.has("req-1")).toBe(false);
  });

  test("still forwards unmatched request errors to the global handler", () => {
    const events: unknown[] = [];
    const client = new DaemonClient((event) => {
      events.push(event);
    });

    const internal = client as any;
    internal.onData(Buffer.from(JSON.stringify({
      type: "error",
      reqId: "req-missing",
      message: "Something failed",
    }) + "\n"));

    expect(events).toEqual([
      { type: "error", reqId: "req-missing", message: "Something failed" },
    ]);
  });
});

describe("DaemonClient commands", () => {
  test("an image preview in flight fails when its daemon disconnects, so it is asked again", async () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const socket = { write: () => {} };
    internal.socket = socket;
    internal._connected = true;
    const pending = client.getImage({ imageId: "a".repeat(64), format: "png", width: 10, height: 10 });
    internal.handleSocketClose(socket, true);
    await expect(pending).rejects.toThrow("disconnected");
    expect(internal.imageCallbacks.size).toBe(0);
  });

  test("requests only the materialized tool-result ids", () => {
    const client = new DaemonClient(() => {}, undefined, false);
    const internal = client as any;

    client.loadToolOutputs("conv-1", ["visible-1", "visible-2"]);

    expect(internal.pendingCommands).toEqual([{
      type: "load_tool_outputs",
      reqId: expect.stringContaining("tool_outputs_"),
      convId: "conv-1",
      toolCallIds: ["visible-1", "visible-2"],
    }]);
  });

  test("binds abort commands to the stream visible at keypress time", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.abort("conv-1", 1234);

    expect(internal.pendingCommands).toEqual([{
      type: "abort",
      convId: "conv-1",
      expectedStartedAt: 1234,
    }]);
  });

  test("sends stable daemon-owned queue metadata", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.queueMessage("conv-1", "later", "message-end", undefined, {
      queueId: "queue-1",
      source: "global-idle",
      target: "conversation",
      waitTarget: { type: "conversation", convId: "dependency", label: "Build" },
    });
    client.unqueueMessage("queue-1");
    client.updateQueuedMessage("queue-1", "edited", "next-turn");
    client.moveQueuedMessage("queue-1", "up");

    expect(internal.pendingCommands).toEqual([
      {
        type: "queue_message",
        reqId: "queue_message:queue-1",
        convId: "conv-1",
        text: "later",
        timing: "message-end",
        queueId: "queue-1",
        source: "global-idle",
        target: "conversation",
        waitTarget: { type: "conversation", convId: "dependency", label: "Build" },
      },
      { type: "unqueue_message", reqId: "unqueue_message:queue-1", queueId: "queue-1" },
      { type: "update_queued_message", queueId: "queue-1", text: "edited", timing: "next-turn" },
      { type: "move_queued_message", queueId: "queue-1", direction: "up" },
    ]);
  });

  test("replays a connected enqueue after socket loss until a canonical snapshot settles it", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const firstWrites: string[] = [];
    internal.socket = { write: (value: string) => { firstWrites.push(value); } };
    internal._connected = true;

    client.queueMessage("conv-1", "durable intent", "message-end", undefined, { queueId: "queue-replay" });
    expect(firstWrites.map(line => JSON.parse(line))).toEqual([expect.objectContaining({
      type: "queue_message",
      queueId: "queue-replay",
    })]);
    expect(internal.unresolvedQueueCommands.size).toBe(1);

    const reconnectWrites: string[] = [];
    internal.socket = { write: (value: string) => { reconnectWrites.push(value); } };
    const replayed = internal.flushPendingCommands();
    expect(replayed).toEqual([expect.objectContaining({ type: "queue_message", queueId: "queue-replay" })]);
    expect(reconnectWrites.map(line => JSON.parse(line))).toEqual([expect.objectContaining({
      type: "queue_message",
      queueId: "queue-replay",
    })]);

    internal.onData(Buffer.from(JSON.stringify({
      type: "queue_updated",
      messages: [{
        id: "queue-replay",
        convId: "conv-1",
        text: "durable intent",
        timing: "message-end",
        source: "daemon",
        createdAt: 1,
      }],
    }) + "\n"));
    expect(internal.unresolvedQueueCommands.size).toBe(0);
  });

  test("replays unqueue until a targeted settled snapshot confirms removal", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    client.unqueueMessage("queue-remove-replay");
    internal.onData(Buffer.from(JSON.stringify({ type: "queue_updated", messages: [] }) + "\n"));
    expect(internal.unresolvedQueueCommands.size).toBe(1);

    writes.length = 0;
    const replayed = internal.flushPendingCommands();
    expect(replayed).toEqual([{ type: "unqueue_message", reqId: "unqueue_message:queue-remove-replay", queueId: "queue-remove-replay" }]);
    expect(writes.map(line => JSON.parse(line))).toEqual(replayed);

    internal.onData(Buffer.from(JSON.stringify({
      type: "queue_updated",
      messages: [],
      settledQueueIds: ["queue-remove-replay"],
    }) + "\n"));
    expect(internal.unresolvedQueueCommands.size).toBe(0);
  });

  test("preserves queue and ordinary command issuance order while replaying", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    internal.socket = { write: () => {} };
    internal._connected = true;
    client.queueMessage("conv-1", "before unwind", "message-end", undefined, { queueId: "queue-ordered" });

    internal.socket = null;
    internal._connected = false;
    client.send({ type: "unwind_conversation", operationId: "ordered-op", convId: "conv-1", userMessageIndex: 0 });
    client.unqueueMessage("queue-ordered");

    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;
    const replayed = internal.flushPendingCommands();
    expect(replayed.map((command: { type: string }) => command.type)).toEqual([
      "queue_message",
      "unwind_conversation",
      "unqueue_message",
    ]);
    expect(writes.map(line => JSON.parse(line).type)).toEqual([
      "queue_message",
      "unwind_conversation",
      "unqueue_message",
    ]);
  });

  test("replays an ambiguous unwind with the same operation id until correlated settlement", () => {
    const events: unknown[] = [];
    const client = new DaemonClient((event) => events.push(event));
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    const reqId = client.unwindConversation("conv-1", 1, 123);
    const original = JSON.parse(writes[0]) as Extract<Command, { type: "unwind_conversation" }>;
    expect(internal.unresolvedUnwindCommands.size).toBe(1);

    writes.length = 0;
    const replayed = internal.flushPendingCommands();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({
      type: "unwind_conversation",
      reqId,
      operationId: original.operationId,
    });

    internal.onData(Buffer.from(`${JSON.stringify({
      type: "error",
      reqId,
      convId: "conv-1",
      message: "settled",
    })}\n`));
    expect(internal.unresolvedUnwindCommands.size).toBe(0);
    expect(events).toHaveLength(1);
  });

  test("replays only the latest ambiguous BTW mutation until durable state settles it", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    client.startBtw("conv-1", "btw-1", "first", 100);
    client.closeBtw("conv-1", "btw-1");
    expect(internal.btwMutationReplay.size).toBe(1);

    writes.length = 0;
    const replayed = internal.flushPendingCommands();
    expect(replayed).toEqual([{ type: "btw_close", reqId: "btw:close:btw-1:btw-1", convId: "conv-1", sessionId: "btw-1" }]);
    expect(writes.map(line => JSON.parse(line))).toEqual(replayed);

    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_snapshot",
      convId: "conv-1",
      btw: null,
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(1);
    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_mutation_settled",
      convId: "conv-1",
      sessionId: "btw-1",
      mutation: "close",
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(0);
  });

  test("settles a replayable BTW start only from its matching durable session", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    internal.socket = { write() {} };
    internal._connected = true;

    client.startBtw("conv-1", "btw-new", "answer once", 100);
    internal.onData(Buffer.from(`${JSON.stringify({ type: "btw_closed", convId: "conv-1", sessionId: "btw-old" })}\n`));
    expect(internal.btwMutationReplay.size).toBe(1);

    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_snapshot",
      convId: "conv-1",
      btw: {
        sessionId: "btw-new",
        query: "answer once",
        provider: "openai",
        model: "gpt-5.6-sol",
        startedAt: 100,
        endedAt: null,
        phase: "running",
        text: "",
        status: "Thinking…",
      },
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(1);
    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_mutation_settled",
      convId: "conv-1",
      sessionId: "btw-new",
      mutation: "start",
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(0);
  });

  test("replays and settles a BTW follow-up by its turn id without replacing the panel id", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    client.followupBtw("conv-1", "panel-1", "turn-2", "clarify", 200);
    expect(JSON.parse(writes.at(-1)!)).toEqual({
      type: "btw_followup",
      reqId: "btw:followup:panel-1:turn-2",
      convId: "conv-1",
      sessionId: "panel-1",
      turnId: "turn-2",
      query: "clarify",
      startedAt: 200,
    });
    expect(internal.btwMutationReplay.size).toBe(1);

    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_mutation_settled",
      convId: "conv-1",
      sessionId: "panel-1",
      turnId: "other-turn",
      mutation: "followup",
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(1);

    internal.onData(Buffer.from(`${JSON.stringify({
      type: "btw_mutation_settled",
      convId: "conv-1",
      sessionId: "panel-1",
      turnId: "turn-2",
      mutation: "followup",
    })}\n`));
    expect(internal.btwMutationReplay.size).toBe(0);
  });

  test("does not let an enqueue settlement prematurely settle an unqueue for the same id", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    internal.socket = { write: () => {} };
    internal._connected = true;
    client.queueMessage("conv-1", "cancel me", "message-end", undefined, { queueId: "queue-cancel-race" });
    client.unqueueMessage("queue-cancel-race");

    internal.onData(Buffer.from(JSON.stringify({
      type: "queue_updated",
      messages: [{
        id: "queue-cancel-race",
        convId: "conv-1",
        text: "cancel me",
        timing: "message-end",
        source: "daemon",
        createdAt: 1,
      }],
      settledQueueIds: ["queue-cancel-race"],
    }) + "\n"));
    expect([...internal.unresolvedQueueCommands.keys()]).toEqual(["unqueue:queue-cancel-race"]);

    internal.onData(Buffer.from(JSON.stringify({
      type: "queue_updated",
      messages: [],
      settledQueueIds: ["queue-cancel-race"],
    }) + "\n"));
    expect(internal.unresolvedQueueCommands.size).toBe(0);
  });

  test("can create a conversation with an atomic initial message", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", "pending", "high", false, {
      text: "hello",
      startedAt: 456,
    });

    expect(internal.pendingCommands).toEqual([{
      type: "new_conversation",
      reqId: expect.stringMatching(/^turn_456_/),
      provider: "openai",
      model: "gpt-5.4",
      title: "pending",
      effort: "high",
      fastMode: false,
      initialMessage: { text: "hello", startedAt: 456 },
    }]);
  });

  test("can include a client-generated conversation id for early follow-up commands", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", "pending", "high", false, {
      text: "hello",
      startedAt: 456,
    }, null, undefined, "client-conv-1");

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "new_conversation",
      convId: "client-conv-1",
      initialMessage: { text: "hello", startedAt: 456 },
    });
  });

  test("can include a time limit when setting a goal", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.setGoal("conv-1", "set", "finish it", 3_600_000);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "set_goal",
      convId: "conv-1",
      action: "set",
      objective: "finish it",
      maxTimeMs: 3_600_000,
    });
  });

  test("turn-starting commands carry a reqId tied to their pending response", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.sendMessage("conv-1", "hi", 777);
    client.replayConversation("conv-1", 778);

    expect(turnRequestStartedAt(internal.pendingCommands[0].reqId)).toBe(777);
    expect(turnRequestStartedAt(internal.pendingCommands[1].reqId)).toBe(778);
    expect(internal.pendingCommands[0].reqId).not.toBe(internal.pendingCommands[1].reqId);
  });

  test("can request a manual conversation compaction", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.compactConversation("conv-1", 123_456);

    expect(internal.pendingCommands[0]).toEqual({
      type: "compact_conversation",
      reqId: expect.stringMatching(/^turn_123456_/),
      convId: "conv-1",
      startedAt: 123_456,
    });
  });

  test("a rejected enqueue is settled by its reqId and never replayed", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];
    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;

    client.queueMessage("conv-1", "never", "message-end", undefined, { queueId: "queue-bad" });
    client.queueMessage("conv-1", "fine", "message-end", undefined, { queueId: "queue-good" });
    expect(internal.unresolvedQueueCommands.size).toBe(2);

    internal.onData(Buffer.from(JSON.stringify({
      type: "error", reqId: "queue_message:queue-bad", convId: "conv-1", message: "NOT NULL constraint failed",
    }) + "\n"));

    expect([...internal.unresolvedQueueCommands.keys()]).toEqual(["enqueue:queue-good"]);
    writes.length = 0;
    expect(internal.flushPendingCommands().map((command: Command) => command.type === "queue_message" && command.queueId))
      .toEqual(["queue-good"]);
  });

  test("a BTW query the daemon rejected with its reqId is not replayed on reconnect", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    internal.socket = { write: () => {} };
    internal._connected = true;

    client.startBtw("conv-1", "btw-1", "question", 100);
    expect(internal.btwMutationReplay.size).toBe(1);

    // A persistence failure without reqId stays replayable.
    internal.onData(Buffer.from(JSON.stringify({ type: "error", convId: "conv-1", message: "Failed to persist BTW start; it will be retried after reconnect." }) + "\n"));
    expect(internal.btwMutationReplay.size).toBe(1);

    internal.onData(Buffer.from(JSON.stringify({ type: "error", reqId: "btw:query:btw-1:btw-1", convId: "conv-1", message: "boom" }) + "\n"));
    expect(internal.btwMutationReplay.size).toBe(0);
    expect(internal.flushPendingCommands()).toEqual([]);
  });

  test("closes a BTW through its owning conversation", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.closeBtw("conv-1", "btw-1");

    expect(internal.pendingCommands[0]).toEqual({
      type: "btw_close",
      reqId: "btw:close:btw-1:btw-1",
      convId: "conv-1",
      sessionId: "btw-1",
    });
  });

  test("can include a time limit when creating a goal conversation", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", undefined, "high", false, undefined, null, "finish it", undefined, undefined, 3_600_000);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "new_conversation",
      goalObjective: "finish it",
      goalMaxTimeMs: 3_600_000,
    });
  });

  test("can include title context for pending queued draft conversations", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", "pending", "high", false, undefined, "folder-1", undefined, "queued-draft-1", "queued prompt text");

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "new_conversation",
      convId: "queued-draft-1",
      title: "pending",
      titleContext: "queued prompt text",
      folderId: "folder-1",
    });
  });

  test("adds performance correlation fields when profiling is enabled", () => {
    const client = new DaemonClient(() => {}, undefined, true);
    const internal = client as any;

    client.loadConversation("conv-1");
    client.loadConversationHistory("conv-1", 40, 15);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "load_conversation",
      convId: "conv-1",
      turns: 5,
      requestedAt: expect.any(Number),
    });
    expect(internal.pendingCommands[0].reqId).toMatch(/^conversation_/);
    expect(internal.pendingCommands[1]).toMatchObject({
      type: "load_conversation_history",
      convId: "conv-1",
      beforeEntryIndex: 40,
      turns: 15,
      requestSource: "viewport",
    });
    expect(internal.pendingCommands[1].reqId).toMatch(/^history_/);
  });

  test("omits performance bookkeeping but preserves behavioral request fields when profiling is disabled", () => {
    const client = new DaemonClient(() => {}, undefined, false);
    const internal = client as any;

    client.loadConversation("conv-1");
    client.loadConversationHistory("conv-1", 40, 15);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "load_conversation",
      convId: "conv-1",
      turns: 5,
    });
    expect(internal.pendingCommands[0]).not.toHaveProperty("requestedAt");
    expect(internal.pendingCommands[1]).toMatchObject({
      type: "load_conversation_history",
      convId: "conv-1",
      beforeEntryIndex: 40,
      turns: 15,
      requestSource: "viewport",
    });
    expect(internal.pendingConversationLoads.size).toBe(0);
    expect(internal.pendingConversationHistoryLoads.size).toBe(0);
  });

  test("sends a screen-sized opening window as the plain turns field every daemon accepts", () => {
    const client = new DaemonClient(() => {}, undefined, false);
    const internal = client as any;

    client.loadConversation("conv-1", 40);

    // No new protocol field: daemons that predate screen sizing honor turns
    // (1..100) and still byte-bound the window for block-paginated clients.
    expect(internal.pendingCommands[0]).toEqual({
      type: "load_conversation",
      reqId: expect.stringMatching(/^conversation_/),
      convId: "conv-1",
      turns: 40,
    });
  });

  test("sends its history viewport so newer daemons size the opening window in rows", () => {
    const client = new DaemonClient(() => {}, undefined, false);
    const internal = client as any;

    client.loadConversation("conv-1", 20, { rows: 55, cols: 200 });

    // turns stays for daemons that predate viewport sizing.
    expect(internal.pendingCommands[0]).toEqual({
      type: "load_conversation",
      reqId: expect.stringMatching(/^conversation_/),
      convId: "conv-1",
      turns: 20,
      viewport: { rows: 55, cols: 200 },
    });
  });
});

describe("DaemonClient reconnect behavior", () => {
  test("classifies a connection loss from the daemon's shutdown announcement", () => {
    const events: unknown[] = [];
    const shutdownModes: Array<DaemonShutdownMode | null> = [];
    const client = new DaemonClient((event) => events.push(event));
    const internal = client as any;
    const socket = {};
    internal.socket = socket;
    internal._connected = true;
    client.onConnectionLost((shutdownMode) => shutdownModes.push(shutdownMode));

    internal.onData(JSON.stringify({ type: "daemon_shutdown", mode: "restart" }) + "\n");
    internal.handleSocketClose(socket, true);

    expect(shutdownModes).toEqual(["restart"]);
    expect(events).toEqual([]);
  });

  test("sends restart only to the currently connected socket and never queues it", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];

    expect(client.restartDaemon()).toBe(false);
    expect(internal.pendingCommands).toEqual([]);

    internal.socket = { write: (value: string) => { writes.push(value); } };
    internal._connected = true;
    expect(client.restartDaemon()).toBe(true);
    expect(writes.map(line => JSON.parse(line))).toEqual([{ type: "restart_daemon" }]);

    internal.socket = null;
    internal._connected = false;
    expect(client.restartDaemon()).toBe(false);
    expect(internal.pendingCommands).toEqual([]);
  });

  test("queues commands while disconnected and flushes them on reconnect", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    const writes: string[] = [];

    client.send({ type: "ping" });
    client.send({ type: "list_conversations" });

    expect(internal.pendingCommands).toEqual([
      { type: "ping" },
      { type: "list_conversations" },
    ]);

    internal.socket = {
      write(payload: string) {
        writes.push(payload);
      },
    };
    internal._connected = true;
    const replayedCommands = internal.flushPendingCommands();

    expect(writes).toEqual([
      JSON.stringify({ type: "ping" }) + "\n",
      JSON.stringify({ type: "list_conversations" }) + "\n",
    ]);
    expect(internal.pendingCommands).toEqual([]);
    expect(replayedCommands).toEqual([
      { type: "ping" },
      { type: "list_conversations" },
    ]);
  });

  test("reports commands queued while the socket connection is in flight", async () => {
    const socketPath = `/tmp/exocortex-client-race-${process.pid}-${Date.now()}.sock`;
    testSockets.push(socketPath);
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (data) => received.push(data.toString("utf8")));
    });
    testServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    const client = new DaemonClient(() => {}, socketPath);
    const connecting = client.connect();
    // This command is queued after connect() starts but before its asynchronous
    // socket callback marks the client connected.
    const reqId = client.unwindConversation("conv-1", 2, 1234);

    const result = await connecting;
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.disconnect();

    expect(result.replayedCommands).toHaveLength(1);
    expect(result.replayedCommands[0]).toMatchObject({
      type: "unwind_conversation",
      reqId,
      convId: "conv-1",
      userMessageIndex: 2,
      expectedStartedAt: 1234,
    });
    const operationId = (result.replayedCommands[0] as Extract<Command, { type: "unwind_conversation" }>).operationId;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(received.join("")).toContain(JSON.stringify({
      type: "unwind_conversation",
      reqId,
      operationId,
      convId: "conv-1",
      userMessageIndex: 2,
      expectedStartedAt: 1234,
    }) + "\n");
  });

  test("manual disconnect does not fire the connection-lost callback", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;
    let disconnects = 0;

    client.onConnectionLost(() => {
      disconnects += 1;
    });

    internal.socket = {
      end() {},
      destroy() {},
    };
    internal._connected = true;

    client.disconnect();

    expect(internal.intentionalDisconnect).toBe(true);
    expect(disconnects).toBe(0);
  });
});

describe("DaemonClient Unicode transport", () => {
  test("reassembles multibyte characters split across socket or SSH reads", () => {
    const title = "🐋 café — año 日本語";
    const bytes = Buffer.from(`${JSON.stringify({ type: "system_prompt", systemPrompt: title })}\n`);
    for (let split = 1; split < bytes.length; split++) {
      const events: Array<{ type: string; systemPrompt?: string }> = [];
      const client = new DaemonClient(event => events.push(event as never));
      (client as any).onData(bytes.subarray(0, split));
      (client as any).onData(bytes.subarray(split));
      expect(events).toEqual([{ type: "system_prompt", systemPrompt: title }]);
    }
  });
});

describe("DaemonClient sidebar digest", () => {
  test("offers a digest only to the SSH host whose sidebar it holds, and rebuilds the answer", () => {
    const events: unknown[] = [];
    const client = new DaemonClient(event => events.push(event));
    const internal = client as any;
    expect(internal.probeCapabilities("whale").sidebarDigest).toBeUndefined();
    internal.sshAlias = "whale";
    const conversations = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
    internal.onData(Buffer.from(`${JSON.stringify({ type: "conversations_list", conversations, folders: [] })}\n`));
    expect(internal.probeCapabilities("laptop").sidebarDigest).toBeUndefined();
    const capabilities = internal.probeCapabilities("whale");
    expect(capabilities.capabilities).toContain("sidebar-digest-sync");
    expect(capabilities.sidebarDigest.buckets).toHaveLength(256);
    internal.onData(Buffer.from(`${JSON.stringify({ type: "conversations_list", conversations: [], sidebarBuckets: [] })}\n`));
    expect(events.at(-1)).toEqual({ type: "conversations_list", conversations, folders: [] });
  });
});
