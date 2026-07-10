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
