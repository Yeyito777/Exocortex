import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "net";
import { unlinkSync } from "fs";
import { DaemonClient } from "./client";

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
        convId: "conv-1",
        text: "later",
        timing: "message-end",
        queueId: "queue-1",
        source: "global-idle",
        target: "conversation",
        waitTarget: { type: "conversation", convId: "dependency", label: "Build" },
      },
      { type: "unqueue_message", queueId: "queue-1" },
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
    expect(replayed).toEqual([{ type: "unqueue_message", queueId: "queue-remove-replay" }]);
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
    client.send({ type: "unwind_conversation", convId: "conv-1", userMessageIndex: 0 });
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

  test("can include goal permission flags when setting a goal", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.setGoal("conv-1", "set", "finish it", false, true);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "set_goal",
      convId: "conv-1",
      action: "set",
      objective: "finish it",
      pausable: false,
      completable: true,
    });
  });

  test("can request a manual conversation compaction", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.compactConversation("conv-1", 123_456);

    expect(internal.pendingCommands[0]).toEqual({
      type: "compact_conversation",
      convId: "conv-1",
      startedAt: 123_456,
    });
  });

  test("can include goal permission flags when creating a goal conversation", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", undefined, "high", false, undefined, null, "finish it", undefined, false, false);

    expect(internal.pendingCommands[0]).toMatchObject({
      type: "new_conversation",
      goalObjective: "finish it",
      goalPausable: false,
      goalCompletable: false,
    });
  });

  test("can include title context for pending queued draft conversations", () => {
    const client = new DaemonClient(() => {});
    const internal = client as any;

    client.createConversation("openai", "gpt-5.4", "pending", "high", false, undefined, "folder-1", undefined, "queued-draft-1", undefined, undefined, "queued prompt text");

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

  test("omits performance bookkeeping and correlation fields when profiling is disabled", () => {
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
    });
    expect(internal.pendingCommands[1]).not.toHaveProperty("requestSource");
    expect(internal.pendingConversationLoads.size).toBe(0);
    expect(internal.pendingConversationHistoryLoads.size).toBe(0);
  });
});

describe("DaemonClient reconnect behavior", () => {
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
    client.unwindConversation("conv-1", 2);

    const result = await connecting;
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.disconnect();

    expect(result).toEqual({ replayedCommands: [{
      type: "unwind_conversation",
      convId: "conv-1",
      userMessageIndex: 2,
    }] });
    expect(received.join("")).toContain(JSON.stringify({
      type: "unwind_conversation",
      convId: "conv-1",
      userMessageIndex: 2,
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
