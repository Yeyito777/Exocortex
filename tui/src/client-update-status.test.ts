import { afterEach, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonClient } from "./client";
import { queryLocalUpdateStatus } from "./update-status";
import type { Command, Event } from "./protocol";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function server(onCommand: (command: Command, socket: Socket) => void) {
  const dir = mkdtempSync(join(tmpdir(), "exo-status-"));
  const path = join(dir, "daemon.sock");
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        onCommand(JSON.parse(line), socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

test("status requests are correlated read-only pings, and do not reach the UI event handler", async () => {
  const received: Command[] = [];
  const events: Event[] = [];
  const path = await server((command, socket) => {
    received.push(command);
    if (command.type === "ping") {
      socket.write(JSON.stringify({ type: "pong", reqId: "another-request", updateStatus: "none" }) + "\n");
      const reply = JSON.stringify({ type: "pong", reqId: command.reqId, updateStatus: "restart_needed" }) + "\n";
      socket.write(reply.slice(0, 15));
      socket.write(reply.slice(15));
    }
  });
  const client = new DaemonClient(event => events.push(event), path);
  cleanups.push(() => client.disconnect());
  await client.connect();
  expect(await client.requestUpdateStatus()).toBe("restart_needed");
  expect(received.filter(cmd => cmd.type === "ping")).toMatchObject([{ type: "ping", updateStatusOnly: true }]);
  expect(events).not.toContainEqual(expect.objectContaining({ updateStatus: "restart_needed" }));
});

test("older daemons without status report Unknown, not None", async () => {
  const path = await server((command, socket) => {
    if (command.type === "ping") socket.write(JSON.stringify({ type: "pong", reqId: command.reqId }) + "\n");
  });
  expect(await queryLocalUpdateStatus(path)).toBe("unknown");
});

test("SSH's independent local probe reads the local daemon and handles missing local daemon", async () => {
  const path = await server((command, socket) => {
    if (command.type === "ping") socket.write(JSON.stringify({ type: "pong", reqId: command.reqId, updateStatus: "none" }) + "\n");
  });
  expect(await queryLocalUpdateStatus(path)).toBe("none");
  expect(await queryLocalUpdateStatus(path + "-missing")).toBe("unknown");
});

test("timeouts and disconnects finish quietly and never queue status requests", async () => {
  const received: Command[] = [];
  const path = await server(command => received.push(command));
  const client = new DaemonClient(() => {}, path);
  cleanups.push(() => client.disconnect());
  expect(await client.requestUpdateStatus()).toBe("unknown");
  await client.connect();
  expect(await client.requestUpdateStatus(10)).toBe("unknown");
  const pending = client.requestUpdateStatus();
  client.disconnect();
  expect(await pending).toBe("unknown");
  const pings = received.filter(cmd => cmd.type === "ping");
  expect(pings.length).toBeLessThanOrEqual(2);
  expect(pings.every(cmd => cmd.updateStatusOnly)).toBe(true);
});
