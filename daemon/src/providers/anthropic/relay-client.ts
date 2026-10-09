/**
 * Daemon side of Claude Code relays (relay.ts): start one for each new Claude
 * Code process, find the ones a previous daemon left running, and talk to one
 * as the Agent SDK's Claude Code process.
 *
 * Under systemd a relay runs in its own transient unit, like the bash tool's
 * runners, so stopping or restarting the daemon's unit does not take it down;
 * elsewhere it is started detached from the daemon's session.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import {
  RELAY_LINE_PREFIX,
  RELAY_PROTOCOL_VERSION,
  relayLine,
  type RelayEvent,
  type RelayHello,
  type RelayMeta,
  type RelayOp,
  type RelayRecord,
  type RelayResumePoint,
  type RelayStart,
} from "./relay-protocol";

/** A new relay has to start Bun and Claude Code before it listens. */
const LAUNCH_TIMEOUT_MS = 20_000;
const RECONNECT_TIMEOUT_MS = 3_000;
const CONNECT_RETRY_MS = 25;
const TERMINATE_TIMEOUT_MS = 3_000;
/** Linux sockaddr_un.sun_path holds 108 bytes. */
const MAX_SOCKET_PATH_BYTES = 104;

export function relaysDir(): string {
  return join(runtimeDir(), "claude-code");
}

/** Claude Code processes run under relays, except on Windows or when disabled. */
export function relaysEnabled(): boolean {
  return process.platform !== "win32" && process.env.EXOCORTEX_CLAUDE_RELAY !== "0";
}

function socketPathFor(id: string): string {
  const candidate = join(relaysDir(), `${id}.sock`);
  if (Buffer.byteLength(candidate) < MAX_SOCKET_PATH_BYTES) return candidate;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `exocortex-claude-${uid}-${id}.sock`);
}

function startRelayProcess(id: string, startPath: string): ChildProcess {
  const script = join(import.meta.dir, "relay.ts");
  if (process.platform === "linux" && process.env.INVOCATION_ID && process.env.EXOCORTEX_TEST !== "1") {
    return spawn("systemd-run", ["--user", "--quiet", "--collect", `--unit=exocortex-claude-${id}`, process.execPath, script, startPath], {
      stdio: "ignore",
    });
  }
  const child = spawn(process.execPath, [script, startPath], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function connectSocket(path: string, timeoutMs: number, gaveUp: () => Error | null = () => null): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(path);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", (error) => {
        socket.destroy();
        const reason = gaveUp();
        if (reason) reject(reason);
        else if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, CONNECT_RETRY_MS);
      });
    };
    attempt();
  });
}

/**
 * A Claude Code process behind a relay, as the Agent SDK sees a spawned
 * process: stdin and stdout carry Claude Code's stream-json, kill() and the
 * end of stdin reach the real process through the relay.
 */
export class ClaudeRelay extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  /** The relay's hello: for a reconnected process, where it stands. */
  hello: RelayHello | null = null;
  readonly exited: Promise<void>;
  private socket: Socket | null = null;
  private outbox: string[] = [];
  private partial = "";
  private detached = false;
  private ended = false;
  private markExited!: () => void;
  private helloWaiter: ((hello: RelayHello) => void) | null = null;

  constructor(private readonly onStderr?: (data: string) => void) {
    super();
    this.exited = new Promise(resolve => { this.markExited = resolve; });
    this.stdin = new Writable({
      decodeStrings: false,
      write: (chunk: string | Buffer, _encoding, callback) => {
        this.send(String(chunk));
        callback();
      },
      final: (callback) => {
        this.op({ op: "end_input" });
        callback();
      },
    });
    this.stdout.on("drain", () => this.socket?.resume());
  }

  /** Start a relay for the process the SDK asks for. Returns at once; traffic waits for the connection. */
  launch(options: SpawnOptions, meta: RelayMeta): this {
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const dir = relaysDir();
    const socketPath = socketPathFor(id);
    const startPath = join(dir, `${id}.start.json`);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env)) if (value !== undefined) env[name] = value;
    const start: RelayStart = {
      version: RELAY_PROTOCOL_VERSION,
      command: options.command,
      args: options.args,
      cwd: options.cwd ?? process.cwd(),
      env,
      socketPath,
      recordPath: join(dir, `${id}.json`),
      meta,
    };

    let failure: Error | null = null;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Claude Code's environment can hold credentials: keep it out of argv.
      writeFileSync(startPath, JSON.stringify(start), { mode: 0o600 });
      const child = startRelayProcess(id, startPath);
      child.once("error", (error) => { failure = error; });
      child.once("exit", (code) => {
        // systemd-run exits once the unit runs; a detached relay only when done.
        if (code !== 0 && !this.socket) failure = new Error(`The Claude Code relay failed to start (exit code ${code}).`);
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    connectSocket(socketPath, LAUNCH_TIMEOUT_MS, () => failure).then(
      socket => this.attach(socket),
      (error: Error) => {
        rmSync(startPath, { force: true });
        this.fail(`Could not start Claude Code through its relay: ${error.message}`);
      },
    );
    return this;
  }

  /** Reconnect to a relay a previous daemon started; resolves with its hello. */
  static async reconnect(socketPath: string): Promise<ClaudeRelay> {
    const socket = await connectSocket(socketPath, 0);
    const relay = new ClaudeRelay();
    const hello = new Promise<RelayHello>((resolve, reject) => {
      relay.helloWaiter = resolve;
      setTimeout(() => reject(new Error("The Claude Code relay did not say hello.")), RECONNECT_TIMEOUT_MS).unref?.();
      relay.once("exit", () => reject(new Error("The Claude Code relay closed.")));
    });
    relay.attach(socket);
    try {
      await hello;
    } catch (error) {
      relay.detach();
      throw error;
    }
    return relay;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.detached || this.ended) return false;
    this.killed = true;
    this.op({ op: "kill", signal });
    return true;
  }

  /** The daemon saved the process's output up to `through`. */
  commit(through: string | null, resume: RelayResumePoint | null, interrupted?: { promptUuid: string | null }): void {
    this.op({ op: "commit", ...(through ? { through } : {}), ...(resume ? { resume } : {}), ...(interrupted ? { interrupted } : {}) });
  }

  /** Exocortex messages now sent into the process (see deliveryKey). */
  delivered(keys: string[]): void {
    if (keys.length > 0) this.op({ op: "delivered", keys });
  }

  /** Let go of the process without stopping it, for a daemon that restarts. */
  detach(): void {
    if (this.detached || this.ended) return;
    this.detached = true;
    this.outbox = [];
    const socket = this.socket;
    this.socket = null;
    // Ending (not destroying) delivers the commits already written.
    socket?.removeAllListeners("data");
    socket?.end();
    this.finish(0, null);
  }

  /** Stop the process and wait (briefly) until it has. */
  async terminate(): Promise<void> {
    this.kill("SIGTERM");
    await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, TERMINATE_TIMEOUT_MS))]);
  }

  private attach(socket: Socket): void {
    if (this.detached || this.ended) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    socket.on("error", () => { /* close follows */ });
    socket.on("close", () => {
      if (this.socket === socket) this.fail("The Claude Code relay closed unexpectedly.");
    });
    for (const text of this.outbox.splice(0)) socket.write(text);
  }

  private read(chunk: string): void {
    const text = this.partial + chunk;
    let from = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
      const line = text.slice(from, newline);
      from = newline + 1;
      if (line.startsWith(RELAY_LINE_PREFIX)) this.event(line);
      else if (line && !this.stdout.write(`${line}\n`)) this.socket?.pause();
    }
    this.partial = text.slice(from);
  }

  private event(line: string): void {
    let event: RelayEvent;
    try {
      event = JSON.parse(line) as RelayEvent;
    } catch {
      return;
    }
    switch (event.event) {
      case "hello":
        if (event.version !== RELAY_PROTOCOL_VERSION) {
          // Its process cannot be taken over: stop it rather than leave it running unseen.
          try { process.kill(event.pid, "SIGTERM"); } catch { /* already gone */ }
          this.fail(`The Claude Code relay speaks protocol ${event.version}, not ${RELAY_PROTOCOL_VERSION}.`);
          return;
        }
        this.hello = event;
        this.helloWaiter?.(event);
        this.helloWaiter = null;
        return;
      case "stderr":
        this.onStderr?.(event.data);
        return;
      case "exit":
        this.socket = null;
        this.finish(event.code, event.signal as NodeJS.Signals | null);
        return;
    }
  }

  private send(text: string): void {
    if (this.detached || this.ended) return;
    if (this.socket) this.socket.write(text);
    else this.outbox.push(text);
  }

  private op(body: RelayOp): void {
    this.send(relayLine(body));
  }

  private fail(message: string): void {
    if (this.ended) return;
    log("warn", `anthropic: ${message}`);
    this.onStderr?.(`${message}\n`);
    this.socket?.destroy();
    this.socket = null;
    this.finish(1, null);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.emit("exit", code, signal);
    this.markExited();
  }
}

function isRecord(value: unknown): value is RelayRecord {
  const record = value as Partial<RelayRecord> | null;
  return record?.version === RELAY_PROTOCOL_VERSION && typeof record.convId === "string"
    && typeof record.socketPath === "string" && typeof record.createdAt === "number";
}

/** Relays left by earlier daemons that still answer, newest first; dead ones are cleaned up. */
export async function reconnectRelays(): Promise<ClaudeRelay[]> {
  const dir = relaysDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith(".json") && !name.endsWith(".start.json"));
  } catch {
    return [];
  }
  const found = await Promise.all(names.map(async (name) => {
    const path = join(dir, name);
    let record: RelayRecord;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isRecord(parsed)) throw new Error("malformed record");
      record = parsed;
    } catch (error) {
      log("warn", `anthropic: removing unreadable Claude Code relay record ${name}: ${error instanceof Error ? error.message : error}`);
      rmSync(path, { force: true });
      return null;
    }
    try {
      return { record, relay: await ClaudeRelay.reconnect(record.socketPath) };
    } catch (error) {
      log("info", `anthropic: Claude Code relay for ${record.convId} is gone (${error instanceof Error ? error.message : error})`);
      rmSync(path, { force: true });
      rmSync(record.socketPath, { force: true });
      return null;
    }
  }));
  return found
    .filter((entry): entry is { record: RelayRecord; relay: ClaudeRelay } => entry !== null)
    .sort((a, b) => b.record.createdAt - a.record.createdAt)
    .map(entry => entry.relay);
}
