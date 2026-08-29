import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonServer, type ConnectedClient, type RawCommandRouter } from "./server";

const tempDirs: string[] = [];
const servers: DaemonServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon raw forwarding hook", () => {
  test("routes unknown future frames unchanged before local typed dispatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-server-forward-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.sock");
    const rawFrames: string[] = [];
    const locallyHandled: string[] = [];
    const router: RawCommandRouter = {
      route: (_client, raw, parsed) => {
        if (parsed.type !== "future_command") return false;
        rawFrames.push(raw);
        return true;
      },
    };
    const server = new DaemonServer(path, (_client, command) => {
      locallyHandled.push(command.type);
    }, router);
    servers.push(server);
    await server.start();

    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write('  {"type":"future_command","unknown":true}  \n');
    client.write('{"type":"ping"}\n');

    const deadline = Date.now() + 1_000;
    while (rawFrames.length < 1 || locallyHandled.length < 1) {
      if (Date.now() > deadline) throw new Error("server routing timed out");
      await Bun.sleep(1);
    }
    client.destroy();

    expect(rawFrames).toEqual(['  {"type":"future_command","unknown":true}  \n']);
    expect(locallyHandled).toEqual(["ping"]);
  });

  test("route switching creates a barrier against later local events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-server-barrier-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.sock");
    let connectedClient: ConnectedClient | null = null;
    const server = new DaemonServer(path, (client) => { connectedClient = client; });
    servers.push(server);
    await server.start();

    const client = connect(path);
    let output = "";
    client.on("data", chunk => { output += chunk.toString("utf8"); });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write('{"type":"ping"}\n');
    const deadline = Date.now() + 1_000;
    while (!connectedClient) {
      if (Date.now() > deadline) throw new Error("client was not dispatched");
      await Bun.sleep(1);
    }

    const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
    server.sendTo(connectedClient, {
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: true,
      message: "switched",
    });
    server.disconnectClients();
    // This models a local stream/sidebar broadcast racing the graceful close.
    server.broadcast({ type: "pong" });
    await closed;

    expect(output.trim().split("\n").map(line => JSON.parse(line))).toEqual([{
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: true,
      message: "switched",
    }]);
  });

  test("local daemon events cannot contaminate a forwarded protocol stream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-server-isolation-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.sock");
    let connectedClient: ConnectedClient | null = null;
    const server = new DaemonServer(path, (client) => { connectedClient = client; });
    servers.push(server);
    await server.start();

    const client = connect(path);
    let output = "";
    client.on("data", chunk => { output += chunk.toString("utf8"); });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write('{"type":"ping"}\n');
    const deadline = Date.now() + 1_000;
    while (!connectedClient) {
      if (Date.now() > deadline) throw new Error("client was not dispatched");
      await Bun.sleep(1);
    }

    const forwardedClient = connectedClient as ConnectedClient;
    forwardedClient.forwarding = true;
    server.broadcast({ type: "pong" });
    server.sendTransportTo(forwardedClient, {
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: false,
      message: "remote route",
    });
    await Bun.sleep(5);
    client.destroy();

    expect(output.trim().split("\n").map(line => JSON.parse(line))).toEqual([{
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: false,
      message: "remote route",
    }]);
  });
});
