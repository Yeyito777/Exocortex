import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";
import { LineSplitter } from "./line-splitter";

function client(): ConnectedClient {
  return {
    id: "test", lines: new LineSplitter(), capabilities: new Set(), subscriptions: new Set(),
    socket: { destroyed: false, write: () => true } as unknown as Socket,
  };
}

describe("daemon JSON-lines Unicode transport", () => {
  test("preserves commands across every possible multibyte split", () => {
    const text = "🐋 café 日本語";
    const bytes = Buffer.from(JSON.stringify({ type: "send_message", convId: "test", text, startedAt: 1 }) + "\n");
    for (let split = 1; split < bytes.length; split++) {
      const commands: Command[] = [];
      const server = new DaemonServer("unused", (_client, command) => { commands.push(command); });
      const connection = client();
      (server as any).onData(connection, bytes.subarray(0, split));
      (server as any).onData(connection, bytes.subarray(split));
      expect(commands).toEqual([{ type: "send_message", convId: "test", text, startedAt: 1 }]);
    }
  });

  test("keeps incomplete characters isolated between clients", () => {
    const commands: Command[] = [];
    const server = new DaemonServer("unused", (_client, command) => { commands.push(command); });
    const first = client(), second = client();
    const bytes = Buffer.from('{"type":"rename_conversation","convId":"test","title":"🐋"}\n');
    const split = bytes.indexOf(Buffer.from("🐋")) + 1;
    (server as any).onData(first, bytes.subarray(0, split));
    (server as any).onData(second, bytes);
    (server as any).onData(first, bytes.subarray(split));
    expect(commands).toEqual([
      { type: "rename_conversation", convId: "test", title: "🐋" },
      { type: "rename_conversation", convId: "test", title: "🐋" },
    ]);
  });

  test("accepts fragmented Unicode over a real disposable socket/pipe", async () => {
    const root = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "exo-wire-"));
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\exo-wire-test-${process.pid}-${Math.random().toString(36).slice(2)}`
      : join(root, "test.sock");
    let received: Command | undefined;
    const server = new DaemonServer(endpoint, (client, command) => {
      received = command;
      server.sendTo(client, { type: "ack", reqId: "reqId" in command ? command.reqId : undefined });
    });
    let socket: Socket | undefined;
    try {
      await server.start();
      socket = connect(endpoint);
      await new Promise<void>((done, fail) => { socket!.once("connect", done); socket!.once("error", fail); });
      const result = new Promise<string>((done, fail) => {
        socket!.once("data", data => done(data.toString("utf8")));
        socket!.once("error", fail);
      });
      const bytes = Buffer.from('{"type":"rename_conversation","reqId":"unicode","convId":"test","title":"🐋 café"}\n');
      const split = bytes.indexOf(Buffer.from("🐋")) + 1;
      socket.write(bytes.subarray(0, split));
      await new Promise<void>(done => setTimeout(done, 10));
      socket.write(bytes.subarray(split));
      expect(JSON.parse(await result)).toMatchObject({ type: "ack", reqId: "unicode" });
      expect(received).toMatchObject({ title: "🐋 café" });
    } finally {
      socket?.destroy();
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("daemon command handler failures", () => {
  function recordingClient(): { connection: ConnectedClient; events: any[] } {
    const events: any[] = [];
    const connection: ConnectedClient = {
      id: "test", lines: new LineSplitter(), capabilities: new Set(), subscriptions: new Set(),
      socket: { destroyed: false, write: (payload: string) => { events.push(JSON.parse(payload)); return true; } } as unknown as Socket,
    };
    return { connection, events };
  }

  test("a rejected async handler answers the request with an error instead of leaving it pending", async () => {
    const server = new DaemonServer("unused", async () => { throw new Error("NOT NULL constraint failed: queued_messages.timing"); });
    const { connection, events } = recordingClient();
    (server as any).onData(connection, Buffer.from('{"type":"queue_message","reqId":"r1","convId":"c1","text":"hi"}\n'));
    await Bun.sleep(0);
    expect(events).toEqual([{ type: "error", reqId: "r1", convId: "c1", message: "NOT NULL constraint failed: queued_messages.timing" }]);
  });

  test("a synchronous handler throw is not misreported as invalid JSON", () => {
    const server = new DaemonServer("unused", () => { throw new Error("boom"); });
    const { connection, events } = recordingClient();
    (server as any).onData(connection, Buffer.from('{"type":"ping","reqId":"r2"}\n{"type":"ping","reqId":"r3"}\n'));
    expect(events).toEqual([
      { type: "error", reqId: "r2", message: "boom" },
      { type: "error", reqId: "r3", message: "boom" },
    ]);
  });
});
