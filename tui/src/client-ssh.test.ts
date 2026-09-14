import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DaemonClient } from "./client";
import { handleEvent } from "./events";
import { createInitialState } from "./state";
import type { SshProcess } from "./ssh-transport";
import { encodeHistoryDelta, type HistoryResponse } from "@exocortex/shared/history-delta";

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
  test("offline retries do not grow the transcript, but explicit failures and new outages remain visible", async () => {
    const first = respondingProbe();
    const recovered = respondingProbe();
    const retries = Array.from({ length: 12 }, () => new FakeProcess());
    const manualFailure = new FakeProcess();
    const processes = [first, ...retries, recovered, manualFailure];
    const state = createInitialState();
    const events: any[] = [];
    let losses = 0;
    const client = new DaemonClient(event => {
      events.push(event);
      handleEvent(event, state, client);
    }, "/tmp/local.sock", false, {
      spawnSshProcess: () => processes.shift()!,
    });
    client.onConnectionLost(() => { losses++; });
    try {
      client.ssh("connect", "whale");
      await waitFor(() => client.remoteAlias === "whale");
      (await client.connect()).releaseBootstrapEvents?.();
      first.emit("close", 255, null);
      const outageMessages = [...state.messages];
      expect(state.sshRemote).toEqual({ alias: "whale", connected: false });
      expect((state.messages.at(-1) as { text: string }).text).toContain("was lost");
      client.send({ type: "list_conversations" });

      for (const [index, retry] of retries.entries()) {
        const connecting = client.connect();
        // Vary the reason: deduplicating identical text alone is insufficient.
        retry.stderr.write(index % 2 ? "Network is unreachable" : "Could not resolve hostname yeyito.dev");
        retry.emit("close", 255, null);
        await expect(connecting).rejects.toThrow("SSH proxy closed");
        expect(events.at(-1)).toMatchObject({ type: "ssh_status", state: "failed", silent: true });
        expect(state.messages).toEqual(outageMessages);
        expect(state.sshRemote).toEqual({ alias: "whale", connected: false });
        expect(retry.input).not.toContain("list_conversations");
      }
      expect(losses).toBe(1);
      const result = await client.connect();
      result.releaseBootstrapEvents?.();
      expect(result.replayedCommands).toEqual([{ type: "list_conversations" }]);
      expect(state.sshRemote).toEqual({ alias: "whale", connected: true });
      expect(state.messages).toEqual(outageMessages);

      recovered.emit("close", 255, null);
      expect(losses).toBe(2);
      expect(state.messages).toHaveLength(outageMessages.length + 1);
      client.ssh("connect", "other-host");
      manualFailure.stderr.write("Could not resolve hostname other-host");
      manualFailure.emit("close", 255, null);
      await waitFor(() => events.at(-1)?.state === "failed");
      expect(events.at(-1).silent).not.toBe(true);
      expect((state.messages.at(-1) as { text: string }).text).toContain("Could not resolve hostname other-host");
    } finally {
      client.disconnect();
    }
  });

  test("reconnect waits for the daemon pong before replay and preserves bootstrap events", async () => {
    const first = respondingProbe();
    const retry = new FakeProcess();
    const events: any[] = [];
    let attempts = 0;
    let losses = 0;
    const client = new DaemonClient(event => events.push(event), "/tmp/local.sock", false, {
      spawnSshProcess: () => ++attempts === 1 ? first : retry,
    });
    client.onConnectionLost(() => { losses++; });
    try {
      client.ssh("connect", "whale");
      await waitFor(() => client.remoteAlias === "whale");
      (await client.connect()).releaseBootstrapEvents?.();
      first.emit("close", 255, null); // OpenSSH keepalive failure after network loss
      expect(client.connected).toBe(false);
      expect(losses).toBe(1);
      client.send({ type: "list_conversations" });

      let ready = false;
      const connecting = client.connect().then(result => { ready = true; return result; });
      retry.emit("spawn");
      await Bun.sleep(1);
      expect(ready).toBe(false);
      expect(client.connected).toBe(false);
      const ping = JSON.parse(retry.input.trim());
      expect(ping.type).toBe("ping");
      retry.stdout.write('{"type":"pong","reqId":"wrong"}\n');
      await Bun.sleep(1);
      expect(ready).toBe(false);
      expect(retry.input).not.toContain("list_conversations");

      retry.stdout.write(`${JSON.stringify({ type: "pong", reqId: ping.reqId })}\n{"type":"conversations_list","conversations":[]}\n`);
      const result = await connecting;
      expect(client.connected).toBe(true);
      expect(result.replayedCommands).toEqual([{ type: "list_conversations" }]);
      expect(result.bootstrapAlreadyRequested).toBe(true);
      expect(retry.input.match(/list_conversations/g)).toHaveLength(1);
      expect(events.some(event => event.type === "conversations_list")).toBe(false);
      result.releaseBootstrapEvents?.();
      await waitFor(() => events.some(event => event.type === "conversations_list"));
      first.emit("close", 255, null);
      expect(client.connected).toBe(true);
      expect(losses).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  test("a blackholed reconnect times out without consuming queued commands and can retry", async () => {
    const first = respondingProbe();
    const stalled = new FakeProcess();
    const recovered = respondingProbe();
    const processes = [first, stalled, recovered];
    const client = new DaemonClient(() => {}, "/tmp/local.sock", false, {
      spawnSshProcess: () => processes.shift()!,
      sshProbeTimeoutMs: 20,
    });
    try {
      client.ssh("connect", "whale");
      await waitFor(() => client.remoteAlias === "whale");
      (await client.connect()).releaseBootstrapEvents?.();
      first.emit("close", 255, null);
      client.send({ type: "list_conversations" });
      const connecting = client.connect();
      stalled.emit("spawn");
      await expect(connecting).rejects.toThrow("timed out");
      expect(stalled.killed).toBe(true);
      expect(client.connected).toBe(false);
      expect(stalled.input).not.toContain("list_conversations");
      const result = await client.connect();
      result.releaseBootstrapEvents?.();
      expect(result.replayedCommands).toEqual([{ type: "list_conversations" }]);
      expect(client.connected).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  for (const action of ["disconnect", "cancel-route"] as const) {
    test(`${action} cancels an in-flight reconnect without reviving its route`, async () => {
      const first = respondingProbe();
      const stalled = new FakeProcess();
      let attempts = 0;
      const client = new DaemonClient(() => {}, "/tmp/local.sock", false, {
        spawnSshProcess: () => ++attempts === 1 ? first : stalled,
      });
      try {
        client.ssh("connect", "whale");
        await waitFor(() => client.remoteAlias === "whale");
        (await client.connect()).releaseBootstrapEvents?.();
        first.emit("close", 255, null);
        const connecting = client.connect();
        if (action === "disconnect") client.disconnect();
        else client.ssh("cancel");
        await expect(connecting).rejects.toThrow("cancelled");
        expect(stalled.killed).toBe(true);
        expect(client.connected).toBe(false);
        expect(stalled.input).not.toContain("client_capabilities");
        if (action === "cancel-route") expect(client.remoteAlias).toBeNull();
      } finally {
        client.disconnect();
      }
    });
  }

  test("reconstructs incremental history before delivery and isolates caches by route", async () => {
    const spawned: FakeProcess[] = [];
    const received: Extract<HistoryResponse, { type: "conversation_loaded" }>[] = [];
    const requests: Array<any> = [];
    const wireResponses: HistoryResponse[] = [];
    const client = new DaemonClient(event => {
      if (event.type === "conversation_loaded") received.push(event);
    }, "/tmp/local.sock", false, {
      spawnSshProcess: () => {
        const child = respondingProbe();
        spawned.push(child);
        child.stdin.on("data", chunk => {
          for (const line of chunk.toString().trim().split("\n")) {
            const cmd = JSON.parse(line);
            if (cmd.type !== "load_conversation") continue;
            requests.push(cmd);
            const full: HistoryResponse = { type: "conversation_loaded", reqId: cmd.reqId, convId: cmd.convId,
              provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
              entries: [{ type: "user", text: "long transcript ".repeat(1000), metadata: null }],
              contextTokens: requests.length, toolOutputsIncluded: false };
            const wire = encodeHistoryDelta(full, cmd.cachedEntryHashes);
            wireResponses.push(wire);
            child.stdout.write(`${JSON.stringify(wire)}\n`);
          }
        });
        return child;
      },
    });
    try {
      client.ssh("connect", "first");
      await waitFor(() => client.remoteAlias === "first");
      (await client.connect()).releaseBootstrapEvents?.();
      client.loadConversation("same-id");
      await waitFor(() => received.length === 1);
      client.loadConversation("same-id");
      await waitFor(() => received.length === 2);
      expect(requests[0].cachedEntryHashes).toBeUndefined();
      expect(requests[1].cachedEntryHashes).toHaveLength(1);
      expect(wireResponses[1].entries).toEqual([]);
      expect(received[1].entries).toEqual(received[0].entries);
      expect(received[1].contextTokens).toBe(2);
      expect(received[1].entryOrder).toBeUndefined();

      client.ssh("connect", "second");
      await waitFor(() => client.remoteAlias === "second");
      (await client.connect()).releaseBootstrapEvents?.();
      client.loadConversation("same-id");
      await waitFor(() => received.length === 3);
      expect(requests[2].cachedEntryHashes).toBeUndefined();
      expect(wireResponses[2].entries).toHaveLength(1);
    } finally {
      client.disconnect();
    }
  });

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
          authByProvider: { openai: false, deepseek: false, opencode: false, openrouter: false },
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
    const pathReqId = client.requestPathDirectory("~/Workspace/", "exo");
    expect(pathReqId?.startsWith("path_")).toBe(true);
    expect(spawned[0].input).toContain(JSON.stringify({
      type: "list_path_directory",
      reqId: pathReqId,
      directory: "~/Workspace/",
      prefix: "exo",
    }));
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

  test("does not queue ephemeral path reads while disconnected", () => {
    const client = new DaemonClient(() => {}, "/tmp/local.sock", false);
    expect(client.requestPathDirectory("~/", "W")).toBeNull();
    expect((client as any).pendingCommands).toEqual([]);
  });
});
