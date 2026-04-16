import { describe, expect, test } from "bun:test";
import { DaemonClient } from "./client";

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
    internal.flushPendingCommands();

    expect(writes).toEqual([
      JSON.stringify({ type: "ping" }) + "\n",
      JSON.stringify({ type: "list_conversations" }) + "\n",
    ]);
    expect(internal.pendingCommands).toEqual([]);
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
