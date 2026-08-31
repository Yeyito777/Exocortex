import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DaemonClient } from "./client";
import type { SshProcess } from "./ssh-transport";

class FakeProcess extends EventEmitter implements SshProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = "";
  killed = false;

  constructor() {
    super();
    this.stdin.on("data", chunk => { this.input += chunk.toString("utf8"); });
  }

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

function respondingProbe(bufferedEvent?: Record<string, unknown>): FakeProcess {
  const child = new FakeProcess();
  let handled = false;
  child.stdin.on("data", () => {
    if (handled) return;
    const newline = child.input.indexOf("\n");
    if (newline === -1) return;
    handled = true;
    const command = JSON.parse(child.input.slice(0, newline));
    child.stdout.write(
      `${JSON.stringify({ type: "pong", reqId: command.reqId })}\n`
      + (bufferedEvent ? `${JSON.stringify(bufferedEvent)}\n` : ""),
    );
  });
  return child;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(1);
  }
}

describe("DaemonClient SSH routing", () => {
  test("selects a remote transport for only one TUI while another stays local", async () => {
    const spawned: FakeProcess[] = [];
    const events: unknown[] = [];
    let routeSwitchEventsSuppressed = false;
    const client = new DaemonClient(event => {
      if (event.type === "ssh_status" && event.state === "connected" && event.switched) {
        routeSwitchEventsSuppressed = true;
      }
      if (routeSwitchEventsSuppressed && event.type !== "ssh_status") return;
      events.push(event);
    }, "/tmp/local.sock", false, {
      localHostname: "localbox",
      spawnSshProcess: () => {
        const child = respondingProbe({
          type: "tools_available",
          providers: [],
          tools: [{ name: "bash", label: "$", color: "#d19a66" }],
          authByProvider: { openai: false, deepseek: false, opencode: false },
          authInfoByProvider: {},
          externalToolStyles: [{ cmd: "gmail", label: "Gmail", color: "#ea4335" }],
        });
        spawned.push(child);
        return child;
      },
    });
    const internal = client as any;
    let connectionLosses = 0;
    let localClosed = false;
    const localTransport = {
      write() {},
      end() {
        if (localClosed) return;
        localClosed = true;
        queueMicrotask(() => internal.handleSocketClose(localTransport, true));
      },
      destroy() {},
    };
    internal.socket = localTransport;
    internal._connected = true;
    client.onConnectionLost(() => { connectionLosses += 1; });

    const localEvents: unknown[] = [];
    const localClient = new DaemonClient(event => localEvents.push(event), "/tmp/local.sock", false, {
      localHostname: "localbox",
    });

    client.ssh("connect", "whale");
    await waitFor(() => client.remoteAlias === "whale");
    await waitFor(() => connectionLosses === 1);

    expect(spawned).toHaveLength(1);
    expect(events).toEqual([
      expect.objectContaining({ type: "ssh_status", mode: "local", state: "switching" }),
      expect.objectContaining({ type: "ssh_status", mode: "remote", state: "connected", alias: "whale", switched: true }),
    ]);
    expect(localClient.remoteAlias).toBeNull();
    localClient.ssh("status");
    expect(localEvents).toEqual([
      expect.objectContaining({ type: "ssh_status", mode: "local", state: "connected" }),
    ]);

    const connected = await client.connect();
    expect(connected.replayedCommands).toEqual([]);
    expect(connected.bootstrapAlreadyRequested).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].input).toContain('"type":"client_capabilities"');
    expect(events.find(event => (
      event as { type?: string; silent?: boolean }
    ).type === "ssh_status" && (
      event as { type?: string; silent?: boolean }
    ).silent === true)).toMatchObject({
      type: "ssh_status",
      mode: "remote",
      alias: "whale",
      silent: true,
    });
    expect(events.some(event => (event as { type?: string }).type === "tools_available")).toBe(false);

    // main.ts first resets endpoint-scoped state and lifts this guard, then
    // explicitly releases the adopted ping bootstrap. Tool colors must survive
    // that first /ssh switch without paying for another ping or SSH handshake.
    routeSwitchEventsSuppressed = false;
    connected.releaseBootstrapEvents?.();
    await waitFor(() => events.some(event => (event as { type?: string }).type === "tools_available"));
    expect(events.find(event => (event as { type?: string }).type === "tools_available")).toMatchObject({
      tools: [{ name: "bash", color: "#d19a66" }],
      externalToolStyles: [{ cmd: "gmail", color: "#ea4335" }],
    });

    spawned[0].stdout.write('{"type":"pong"}\n');
    await waitFor(() => events.some(event => (event as { type?: string }).type === "pong"));

    client.ssh("cancel");
    expect(client.remoteAlias).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "ssh_status",
      mode: "local",
      state: "connected",
      switched: true,
    });
    await waitFor(() => spawned[0].killed);
  });

  test("keeps the current route when an SSH probe fails", async () => {
    const probe = new FakeProcess();
    const events: unknown[] = [];
    const client = new DaemonClient(event => events.push(event), "/tmp/local.sock", false, {
      spawnSshProcess: () => probe,
    });
    const internal = client as any;
    let localClosed = false;
    internal.socket = {
      write() {},
      end() { localClosed = true; },
      destroy() { localClosed = true; },
    };
    internal._connected = true;

    client.ssh("connect", "missing");
    probe.stderr.write("Permission denied");
    probe.emit("close", 255, null);
    await waitFor(() => events.some(event => (
      event as { type?: string; state?: string }
    ).type === "ssh_status" && (
      event as { type?: string; state?: string }
    ).state === "failed"));

    expect(client.remoteAlias).toBeNull();
    expect(localClosed).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "ssh_status", mode: "local", state: "failed" });
    expect((events.at(-1) as { message: string }).message).toContain("Permission denied");
  });
});
