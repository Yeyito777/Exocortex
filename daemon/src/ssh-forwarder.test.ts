import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import type { Event } from "./protocol";
import type { ConnectedClient } from "./server";
import {
  SshForwarder,
  sshProxyArgs,
  validateSshAlias,
  type SshProcess,
} from "./ssh-forwarder";

class FakeProcess extends EventEmitter implements SshProcess {
  stdin: PassThrough;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  constructor(stdinHighWaterMark?: number) {
    super();
    this.stdin = new PassThrough(stdinHighWaterMark ? { highWaterMark: stdinHighWaterMark } : undefined);
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

function fakeClient(id = "client-1") {
  const socket = new PassThrough();
  const output: string[] = [];
  socket.on("data", chunk => output.push(chunk.toString("utf8")));
  const client: ConnectedClient = {
    id,
    socket: socket as unknown as Socket,
    subscriptions: new Set(),
    capabilities: new Set(),
    buffer: "",
    routeClosing: false,
    forwarding: false,
  };
  return { client, output };
}

function fakeHost() {
  const direct: Event[] = [];
  const broadcasts: Event[] = [];
  let disconnects = 0;
  return {
    direct,
    broadcasts,
    get disconnects() { return disconnects; },
    host: {
      sendTo: (_client: ConnectedClient, event: Event) => { direct.push(event); return 0; },
      broadcast: (event: Event) => { broadcasts.push(event); },
      disconnectClients: () => { disconnects += 1; },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(1);
  }
}

function respondingProbe(): FakeProcess {
  const child = new FakeProcess();
  let input = "";
  child.stdin.on("data", chunk => {
    input += chunk.toString("utf8");
    const newline = input.indexOf("\n");
    if (newline === -1) return;
    const command = JSON.parse(input.slice(0, newline));
    child.stdout.write(`${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`);
  });
  return child;
}

describe("SSH forwarding", () => {
  test("validates aliases and keeps the destination in one ssh argv", () => {
    expect(validateSshAlias("whale-dev_2.example")).toBeNull();
    expect(validateSshAlias("-oProxyCommand=oops")).not.toBeNull();
    expect(validateSshAlias("host name")).not.toBeNull();
    expect(validateSshAlias("user@host")).not.toBeNull();
    expect(sshProxyArgs("whale")).toEqual([
      "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "whale", "exocortexd", "proxy",
    ]);
  });

  test("probes, switches globally, and forwards ordinary frames byte-for-byte", async () => {
    const spawned: FakeProcess[] = [];
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, {
      localHostname: "localbox",
      localPid: 42,
      localSocketPath: "/tmp/local.sock",
      spawnProcess: () => {
        const child = spawned.length === 0 ? respondingProbe() : new FakeProcess();
        spawned.push(child);
        return child;
      },
    });
    const { client } = fakeClient();

    expect(forwarder.route(client, '{"type":"ssh","action":"connect","alias":"whale"}\n', {
      type: "ssh",
      action: "connect",
      alias: "whale",
    } as any)).toBe(true);
    await waitFor(() => host.broadcasts.some(event => event.type === "ssh_status"));

    expect(forwarder.alias).toBe("whale");
    expect(host.disconnects).toBe(1);
    expect(host.broadcasts.at(-1)).toMatchObject({
      type: "ssh_status",
      mode: "remote",
      state: "connected",
      alias: "whale",
      switched: true,
    });

    const remoteSession = fakeClient("client-2");
    forwarder.onClientConnected(remoteSession.client);
    expect(remoteSession.client.forwarding).toBe(true);
    const raw = '  {"type":"future_command","newField":true}  \n';
    expect(forwarder.route(remoteSession.client, raw, { type: "future_command" })).toBe(true);
    expect(spawned).toHaveLength(2);
    let forwarded = "";
    spawned[1].stdin.on("data", chunk => { forwarded += chunk.toString("utf8"); });
    // The write happened before this observer was attached; PassThrough retains
    // it in its readable side, so consume that side as well.
    spawned[1].stdin.resume();
    await waitFor(() => forwarded.length > 0);
    expect(forwarded).toBe(raw);

    spawned[1].stdout.write('{"type":"future_event","value":7}\n');
    await waitFor(() => remoteSession.output.length > 0);
    expect(remoteSession.output.join("")).toBe('{"type":"future_event","value":7}\n');
  });

  test("cancel is intercepted in remote mode and returns all clients to local", async () => {
    const spawned: FakeProcess[] = [];
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, {
      spawnProcess: () => {
        const child = respondingProbe();
        spawned.push(child);
        return child;
      },
    });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "whale" } as any);
    await waitFor(() => forwarder.alias === "whale");
    forwarder.route(client, "ignored\n", { type: "ssh", action: "cancel" } as any);

    expect(forwarder.alias).toBeNull();
    expect(host.broadcasts.at(-1)).toMatchObject({ type: "ssh_status", mode: "local", switched: true });
    expect(host.disconnects).toBe(2);
    expect(forwarder.route(client, '{"type":"ping"}\n', { type: "ping" })).toBe(false);
  });

  test("failed probe retains the current local route and reports stderr", async () => {
    const child = new FakeProcess();
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, {
      probeTimeoutMs: 100,
      spawnProcess: () => child,
    });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "missing" } as any);
    child.stderr.write("Permission denied");
    child.emit("close", 255, null);
    await waitFor(() => host.direct.some(event => event.type === "ssh_status" && event.state === "failed"));

    expect(forwarder.alias).toBeNull();
    expect(host.disconnects).toBe(0);
    expect(host.direct.at(-1)).toMatchObject({ type: "ssh_status", mode: "local", state: "failed" });
    expect((host.direct.at(-1) as Extract<Event, { type: "ssh_status" }>).message).toContain("Permission denied");
  });

  test("cancel aborts an in-flight probe and retains the current route", async () => {
    const probe = new FakeProcess();
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, { spawnProcess: () => probe });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "slowbox" } as any);
    forwarder.route(client, "ignored\n", { type: "ssh", action: "cancel" } as any);
    await waitFor(() => probe.killed);

    expect(forwarder.alias).toBeNull();
    expect(host.disconnects).toBe(0);
    expect(host.broadcasts.at(-1)).toMatchObject({
      type: "ssh_status",
      mode: "local",
      state: "connected",
      switched: false,
    });
    expect((host.broadcasts.at(-1) as Extract<Event, { type: "ssh_status" }>).message).toContain("cancelled");
    expect(forwarder.route(client, '{"type":"ping"}\n', { type: "ping" })).toBe(false);
  });

  test("a probe cannot switch routes after its requesting client disconnects", async () => {
    const probe = new FakeProcess();
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, { spawnProcess: () => probe });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "slowbox" } as any);
    forwarder.onClientDisconnected(client);
    await waitFor(() => probe.killed);

    expect(forwarder.alias).toBeNull();
    expect(host.disconnects).toBe(0);
    expect(host.broadcasts).toEqual([]);
    expect(forwarder.route(client, '{"type":"ping"}\n', { type: "ping" })).toBe(false);
  });

  test("pauses local input while SSH stdin applies backpressure", async () => {
    const spawned: FakeProcess[] = [];
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, {
      spawnProcess: () => {
        const child = spawned.length === 0 ? respondingProbe() : new FakeProcess(1);
        spawned.push(child);
        return child;
      },
    });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "whale" } as any);
    await waitFor(() => forwarder.alias === "whale");
    forwarder.route(client, `${JSON.stringify({ type: "message", text: "x".repeat(4096) })}\n`, { type: "message" });

    await waitFor(() => client.socket.isPaused());
    spawned[1].stdin.resume();
    await waitFor(() => !client.socket.isPaused());
    expect(forwarder.alias).toBe("whale");
  });

  test("remote bridge loss closes the client without falling back to local", async () => {
    const spawned: FakeProcess[] = [];
    const host = fakeHost();
    const forwarder = new SshForwarder(host.host, {
      spawnProcess: () => {
        const child = spawned.length === 0 ? respondingProbe() : new FakeProcess();
        spawned.push(child);
        return child;
      },
    });
    const { client } = fakeClient();

    forwarder.route(client, "ignored\n", { type: "ssh", action: "connect", alias: "whale" } as any);
    await waitFor(() => forwarder.alias === "whale");
    forwarder.route(client, '{"type":"ping"}\n', { type: "ping" });
    const bridge = spawned[1];
    bridge.stderr.write("network unreachable");
    bridge.emit("close", 255, null);
    await waitFor(() => host.direct.some(event => event.type === "ssh_status" && event.state === "failed"));

    expect(forwarder.alias).toBe("whale");
    expect(client.socket.writableEnded).toBe(true);
    expect((host.direct.at(-1) as Extract<Event, { type: "ssh_status" }>).message).toContain("network unreachable");
  });
});
