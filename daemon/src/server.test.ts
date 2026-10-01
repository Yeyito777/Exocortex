import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer, type ConnectedClient } from "./server";
import type { Command } from "./protocol";

function client(): ConnectedClient {
  return {
    id: "test", buffer: "", capabilities: new Set(), subscriptions: new Set(),
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
