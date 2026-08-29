/**
 * Daemon-owned SSH forwarding mode.
 *
 * The local Unix socket remains stable. In remote mode every local client gets
 * one `ssh ... exocortexd proxy` process, and ordinary JSON-lines frames pass
 * through without being interpreted by the local command handler. Only the
 * local `/ssh` control command is intercepted.
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { Event, SshCommand, SshStatusEvent } from "./protocol";
import type { ConnectedClient, RawCommandRouter } from "./server";
import { log } from "./log";

const STDERR_LIMIT = 8 * 1024;
const PROBE_OUTPUT_LIMIT = 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const MAX_BRIDGE_PENDING_BYTES = 16 * 1024 * 1024;

export interface SshProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnSshProcess = (alias: string) => SshProcess;

export interface SshForwardingHost {
  sendTo(client: ConnectedClient, event: Event): number;
  broadcast(event: Event): void;
  disconnectClients(): void;
}

export interface SshForwarderOptions {
  spawnProcess?: SpawnSshProcess;
  probeTimeoutMs?: number;
  localSocketPath?: string;
  localPid?: number;
  localHostname?: string;
}

interface Bridge {
  alias: string;
  process: SshProcess;
  intentionalClose: boolean;
  stderr: string;
  failed: boolean;
  stdinBlocked: boolean;
  pendingFrames: string[];
  pendingBytes: number;
}

export function sshProxyArgs(alias: string): string[] {
  return [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    alias,
    "exocortexd", "proxy",
  ];
}

function spawnSshProxy(alias: string): SshProcess {
  return spawn("ssh", sshProxyArgs(alias), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
}

export function validateSshAlias(alias: string): string | null {
  if (!alias) return "SSH alias cannot be empty.";
  if (alias.length > 255) return "SSH alias is too long.";
  // Host aliases are deliberately narrower than arbitrary ssh destinations:
  // this blocks option injection and keeps `/ssh` tied to named SSH configs.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) {
    return "SSH alias may contain only letters, numbers, dots, underscores, and hyphens.";
  }
  return null;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + (typeof chunk === "string" ? chunk : chunk.toString("utf8"));
  return next.length <= STDERR_LIMIT ? next : next.slice(next.length - STDERR_LIMIT);
}

function stderrSuffix(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `: ${trimmed}` : "";
}

export class SshForwarder implements RawCommandRouter {
  private readonly spawnProcess: SpawnSshProcess;
  private readonly probeTimeoutMs: number;
  private readonly localSocketPath: string;
  private readonly localPid: number;
  private readonly localHostname: string;
  private targetAlias: string | null = null;
  private switchingTo: string | null = null;
  private switchingRequesterId: string | null = null;
  private switchGeneration = 0;
  private cancelProbe: ((reason: string) => void) | null = null;
  private bridges = new Map<string, Bridge>();
  private stopping = false;

  constructor(
    private readonly host: SshForwardingHost,
    options: SshForwarderOptions = {},
  ) {
    this.spawnProcess = options.spawnProcess ?? spawnSshProxy;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.localSocketPath = options.localSocketPath ?? "unknown";
    this.localPid = options.localPid ?? process.pid;
    this.localHostname = options.localHostname ?? hostname();
  }

  get alias(): string | null { return this.targetAlias; }

  onClientConnected(client: ConnectedClient): void {
    client.forwarding = this.targetAlias !== null;
    if (!client.forwarding) return;
    this.host.sendTo(client, this.connectedStatus(false, undefined, true));
  }

  onClientDisconnected(client: ConnectedClient): void {
    if (this.switchingRequesterId === client.id) {
      this.abortPendingSwitch("requesting client disconnected");
    }
    this.closeBridge(client.id);
  }

  route(client: ConnectedClient, rawFrame: string, parsed: { type: string }): boolean {
    if (parsed.type === "ssh") {
      void this.handleControl(client, parsed as SshCommand);
      return true;
    }

    if (this.switchingTo) {
      this.host.sendTo(client, {
        type: "error",
        message: `SSH switch to ${this.switchingTo} is still in progress; command was not sent.`,
      });
      return true;
    }
    if (!this.targetAlias) return false;

    this.forwardFrame(client, rawFrame);
    return true;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abortPendingSwitch("daemon stopped");
    this.closeAllBridges();
  }

  private async handleControl(client: ConnectedClient, command: SshCommand): Promise<void> {
    switch (command.action) {
      case "status":
        this.host.sendTo(client, this.connectedStatus(false, command.reqId));
        return;
      case "cancel":
        this.cancel(command.reqId);
        return;
      case "connect":
        await this.connect(client, command.alias, command.reqId);
        return;
      default:
        this.host.sendTo(client, {
          type: "error",
          reqId: command.reqId,
          message: "Invalid SSH action. Use connect, status, or cancel.",
        });
    }
  }

  private connectedStatus(switched: boolean, reqId?: string, silent = false): SshStatusEvent {
    if (this.targetAlias) {
      return {
        type: "ssh_status",
        reqId,
        mode: "remote",
        state: "connected",
        alias: this.targetAlias,
        switched,
        ...(silent ? { silent: true } : {}),
        message: `Connected daemon: SSH alias ${this.targetAlias} (remote Exocortex daemon).`,
      };
    }
    return {
      type: "ssh_status",
      reqId,
      mode: "local",
      state: "connected",
      switched,
      ...(silent ? { silent: true } : {}),
      message: `Connected daemon: local ${this.localHostname} (pid ${this.localPid}, socket ${this.localSocketPath}).`,
    };
  }

  private currentModeStatus(
    state: "switching" | "failed",
    message: string,
    reqId?: string,
  ): SshStatusEvent {
    return {
      type: "ssh_status",
      reqId,
      mode: this.targetAlias ? "remote" : "local",
      state,
      ...(this.targetAlias ? { alias: this.targetAlias } : {}),
      switched: false,
      message,
    };
  }

  private async connect(client: ConnectedClient, alias: string | undefined, reqId?: string): Promise<void> {
    const validationError = validateSshAlias(alias ?? "");
    if (validationError) {
      this.host.sendTo(client, this.currentModeStatus("failed", validationError, reqId));
      return;
    }
    const target = alias!;
    if (this.switchingTo) {
      this.host.sendTo(client, this.currentModeStatus(
        "failed",
        `Already switching to SSH alias ${this.switchingTo}.`,
        reqId,
      ));
      return;
    }
    if (target === this.targetAlias) {
      this.host.sendTo(client, this.connectedStatus(false, reqId));
      return;
    }

    const generation = ++this.switchGeneration;
    this.switchingTo = target;
    this.switchingRequesterId = client.id;
    this.host.sendTo(client, this.currentModeStatus(
      "switching",
      `Connecting to remote Exocortex daemon through SSH alias ${target}…`,
      reqId,
    ));

    try {
      await this.probe(target, generation);
    } catch (error) {
      // A disconnect, `/ssh cancel`, or daemon stop superseded this probe. The
      // operation that cancelled it has already retained/reported the old route.
      if (generation !== this.switchGeneration) return;
      const message = `Could not connect through SSH alias ${target}: ${error instanceof Error ? error.message : String(error)}`;
      log("warn", `ssh forwarder: ${message}`);
      this.host.sendTo(client, this.currentModeStatus("failed", message, reqId));
      this.switchingTo = null;
      this.switchingRequesterId = null;
      return;
    }

    // Never let a stale successful probe change the global route after its
    // requester disappeared or a newer control operation superseded it.
    if (generation !== this.switchGeneration
        || this.switchingTo !== target
        || client.socket.destroyed
        || client.socket.writableEnded) return;

    this.closeAllBridges();
    this.targetAlias = target;
    this.switchingTo = null;
    this.switchingRequesterId = null;
    log("info", `ssh forwarder: selected remote daemon via ${target}`);
    this.host.broadcast(this.connectedStatus(true, reqId));
    // Socket close gives every client a fresh protocol session. Its capability
    // handshake, ping, subscriptions, and any reconnect replay then go remote.
    this.host.disconnectClients();
  }

  private cancel(reqId?: string): void {
    if (this.switchingTo) {
      const pending = this.switchingTo;
      this.abortPendingSwitch(`SSH switch to ${pending} cancelled.`);
      const status = this.connectedStatus(false, reqId);
      this.host.broadcast({
        ...status,
        message: `SSH switch to ${pending} cancelled. ${status.message}`,
      });
      return;
    }
    if (!this.targetAlias) {
      this.host.broadcast(this.connectedStatus(false, reqId));
      return;
    }

    const previous = this.targetAlias;
    this.closeAllBridges();
    this.targetAlias = null;
    log("info", `ssh forwarder: cancelled remote route ${previous}; using local daemon`);
    this.host.broadcast({
      ...this.connectedStatus(true, reqId),
      message: `SSH forwarding to ${previous} cancelled. Connected daemon: local ${this.localHostname} (pid ${this.localPid}).`,
    });
    this.host.disconnectClients();
  }

  private abortPendingSwitch(reason: string): void {
    if (!this.switchingTo && !this.cancelProbe) return;
    this.switchGeneration += 1;
    this.switchingTo = null;
    this.switchingRequesterId = null;
    const cancel = this.cancelProbe;
    this.cancelProbe = null;
    cancel?.(reason);
  }

  private probe(alias: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let process: SshProcess;
      try {
        process = this.spawnProcess(alias);
      } catch (error) {
        reject(error);
        return;
      }

      const reqId = `ssh_probe_${randomUUID()}`;
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let cancelThisProbe: ((reason: string) => void) | null = null;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (cancelThisProbe && this.cancelProbe === cancelThisProbe) this.cancelProbe = null;
        try { process.kill(); } catch { /* already gone */ }
        if (error) reject(error);
        else resolve();
      };

      cancelThisProbe = reason => finish(new Error(reason));
      if (generation !== this.switchGeneration) {
        cancelThisProbe("SSH switch was superseded");
        return;
      }
      this.cancelProbe = cancelThisProbe;
      timer = setTimeout(() => finish(new Error(
        `timed out after ${Math.ceil(this.probeTimeoutMs / 1000)}s${stderrSuffix(stderr)}`,
      )), this.probeTimeoutMs);
      timer.unref?.();

      process.stderr.on("data", chunk => { stderr = appendBounded(stderr, chunk); });
      process.stdout.on("data", chunk => {
        if (settled) return;
        stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (stdout.length > PROBE_OUTPUT_LIMIT) {
          finish(new Error("remote daemon returned too much data before the probe response"));
          return;
        }
        let newline: number;
        while ((newline = stdout.indexOf("\n")) !== -1) {
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event?.type === "pong" && event.reqId === reqId) {
              finish();
              return;
            }
          } catch {
            finish(new Error("remote proxy wrote non-protocol data to stdout"));
            return;
          }
        }
      });
      process.once("error", error => finish(new Error(`${error.message}${stderrSuffix(stderr)}`)));
      process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        finish(new Error(`SSH proxy closed before the daemon replied (${result})${stderrSuffix(stderr)}`));
      });
      process.stdin.once("error", error => finish(new Error(`cannot write SSH probe: ${error.message}${stderrSuffix(stderr)}`)));
      process.stdin.write(`${JSON.stringify({ type: "ping", reqId })}\n`);
    });
  }

  private forwardFrame(client: ConnectedClient, rawFrame: string): void {
    if (client.socket.destroyed || client.socket.writableEnded || client.routeClosing) return;
    let bridge: Bridge | null | undefined = this.bridges.get(client.id);
    if (!bridge || bridge.alias !== this.targetAlias) {
      if (bridge) this.closeBridge(client.id);
      bridge = this.openBridge(client);
      if (!bridge) return;
    }
    this.writeBridgeFrame(client, bridge, rawFrame);
  }

  private writeBridgeFrame(client: ConnectedClient, bridge: Bridge, rawFrame: string): void {
    if (bridge.stdinBlocked) {
      const bytes = Buffer.byteLength(rawFrame);
      if (bridge.pendingBytes + bytes > MAX_BRIDGE_PENDING_BYTES) {
        this.failBridge(client, bridge, `SSH stdin remained blocked with more than ${MAX_BRIDGE_PENDING_BYTES / 1024 / 1024} MiB queued`);
        return;
      }
      bridge.pendingFrames.push(rawFrame);
      bridge.pendingBytes += bytes;
      return;
    }
    try {
      if (!bridge.process.stdin.write(rawFrame)) {
        bridge.stdinBlocked = true;
        client.socket.pause();
        bridge.process.stdin.once("drain", () => this.flushBridgeFrames(client, bridge));
      }
    } catch (error) {
      this.failBridge(client, bridge, `cannot write to SSH: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private flushBridgeFrames(client: ConnectedClient, bridge: Bridge): void {
    if (bridge.intentionalClose || bridge.failed || this.bridges.get(client.id) !== bridge) return;
    bridge.stdinBlocked = false;
    while (bridge.pendingFrames.length > 0) {
      const frame = bridge.pendingFrames.shift()!;
      bridge.pendingBytes -= Buffer.byteLength(frame);
      try {
        if (!bridge.process.stdin.write(frame)) {
          bridge.stdinBlocked = true;
          bridge.process.stdin.once("drain", () => this.flushBridgeFrames(client, bridge));
          return;
        }
      } catch (error) {
        this.failBridge(client, bridge, `cannot write to SSH: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (!client.socket.destroyed && !client.socket.writableEnded) client.socket.resume();
  }

  private openBridge(client: ConnectedClient): Bridge | null {
    const alias = this.targetAlias;
    if (!alias) return null;

    let process: SshProcess;
    try {
      process = this.spawnProcess(alias);
    } catch (error) {
      this.host.sendTo(client, this.currentModeStatus(
        "failed",
        `Could not start SSH proxy for ${alias}: ${error instanceof Error ? error.message : String(error)}`,
      ));
      client.socket.end();
      return null;
    }

    const bridge: Bridge = {
      alias,
      process,
      intentionalClose: false,
      stderr: "",
      failed: false,
      stdinBlocked: false,
      pendingFrames: [],
      pendingBytes: 0,
    };
    this.bridges.set(client.id, bridge);
    process.stderr.on("data", chunk => { bridge.stderr = appendBounded(bridge.stderr, chunk); });
    process.stdout.on("data", chunk => {
      if (bridge.intentionalClose || client.socket.destroyed) return;
      const writable = client.socket.write(chunk);
      if (!writable) {
        process.stdout.pause();
        client.socket.once("drain", () => process.stdout.resume());
      }
    });
    process.once("error", error => this.failBridge(client, bridge, error.message));
    process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (bridge.intentionalClose || bridge.failed || this.stopping) return;
      const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      this.failBridge(client, bridge, `SSH proxy closed (${result})`);
    });
    process.stdin.once("error", error => this.failBridge(client, bridge, `SSH stdin error: ${error.message}`));
    log("info", `ssh forwarder: opened ${client.id} -> ${alias}`);
    return bridge;
  }

  private failBridge(client: ConnectedClient, bridge: Bridge, reason: string): void {
    if (bridge.intentionalClose || bridge.failed || this.bridges.get(client.id) !== bridge) return;
    bridge.failed = true;
    this.bridges.delete(client.id);
    bridge.pendingFrames = [];
    bridge.pendingBytes = 0;
    const message = `SSH connection to ${bridge.alias} was lost: ${reason}${stderrSuffix(bridge.stderr)}`;
    log("warn", `ssh forwarder: ${client.id}: ${message}`);
    this.host.sendTo(client, this.currentModeStatus("failed", message));
    try { bridge.process.kill(); } catch { /* already gone */ }
    // Force the ordinary client reconnect path. The selected alias remains active;
    // Exocortex never silently sends remote-intended work to the local daemon.
    client.socket.end();
  }

  private closeBridge(clientId: string): void {
    const bridge = this.bridges.get(clientId);
    if (!bridge) return;
    this.bridges.delete(clientId);
    bridge.intentionalClose = true;
    bridge.pendingFrames = [];
    bridge.pendingBytes = 0;
    try { bridge.process.stdin.end(); } catch { /* already closed */ }
    try { bridge.process.kill(); } catch { /* already gone */ }
  }

  private closeAllBridges(): void {
    for (const clientId of [...this.bridges.keys()]) this.closeBridge(clientId);
  }
}
