/**
 * Transparent stdio bridge to this machine's Exocortex daemon socket.
 *
 * It is intentionally protocol- and transport-unaware. External wrappers use
 * this helper to carry exactly the daemon's JSON-lines stream over stdio.
 * Diagnostics belong on stderr; stdout is reserved for daemon events.
 * With a `filter` (`--link-only`, ipc-link-filter.ts) it splits both streams
 * into lines and passes only what the filter allows.
 */

import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { hasHungUp } from "./fd-hangup";
import type { LinkOnlyFilter } from "./ipc-link-filter";

export interface IpcProxyOptions {
  socketPath: string;
  input?: Readable;
  output?: Writable;
  filter?: LinkOnlyFilter;
}

/** A filtered line longer than this closes the bridge: a link request body (32 MiB) in base64, with room. */
const MAX_FILTERED_LINE_BYTES = 64 * 1024 * 1024;

/** How often to look for a peer that has gone without a stream event saying so. */
const HANGUP_POLL_MS = 1000;
/** Once stdin or the daemon has gone, how long what's in flight may still cross. */
const SHUTDOWN_GRACE_MS = 1000;
/** How long the last daemon bytes may take to reach a client that is still reading. */
const OUTPUT_FLUSH_MS = 2000;

/** Calls `onLine` for each newline-terminated line of `stream`, `onTooLong` for a line over the limit. */
function splitLines(stream: Readable, onLine: (line: string) => void, onTooLong: () => void): void {
  let parts: Buffer[] = [];
  let length = 0;
  stream.on("data", (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10)) {
      parts.push(data.subarray(0, newline));
      const line = Buffer.concat(parts).toString("utf8");
      parts = [];
      length = 0;
      data = data.subarray(newline + 1);
      if (line.trim()) onLine(line);
    }
    if (data.length > 0) {
      parts.push(data);
      length += data.length;
      if (length > MAX_FILTERED_LINE_BYTES) {
        parts = [];
        length = 0;
        onTooLong();
      }
    }
  });
}

const waitingForDrain = new WeakSet<Writable>();

/** Writes a line, pausing `source` until `target` drains. */
function writeLine(target: Writable, source: Readable, line: string): void {
  if (target.write(`${line}\n`) || waitingForDrain.has(target)) return;
  waitingForDrain.add(target);
  source.pause();
  target.once("drain", () => {
    waitingForDrain.delete(target);
    source.resume();
  });
}

function connectFiltered(input: Readable, output: Writable, socket: Socket, filter: LinkOnlyFilter): void {
  const tooLong = () => {
    process.stderr.write("exocortexd proxy: a line exceeded the link-only limit; closing\n");
    socket.destroy();
  };
  splitLines(input, (line) => {
    const verdict = filter.fromClient(line);
    if (verdict.forward !== undefined) writeLine(socket, input, verdict.forward);
    if (verdict.reply !== undefined) writeLine(output, input, verdict.reply);
  }, tooLong);
  splitLines(socket, (line) => {
    const passed = filter.fromDaemon(line);
    if (passed !== null) writeLine(output, socket, passed);
  }, tooLong);
}

/**
 * Ends the process after a finished bridge. Bun exits by itself once stdout has
 * flushed; a client that has stopped reading can only hold it this long.
 */
export function exitAfterIpcProxy(): void {
  setTimeout(() => process.exit(0), OUTPUT_FLUSH_MS).unref();
}

export async function runIpcProxy(options: IpcProxyOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  await new Promise<void>((resolve, reject) => {
    const socket = connect(options.socketPath);
    let connected = false;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(hangupPoll);
      clearTimeout(grace);
      input.unpipe(socket);
      input.removeAllListeners("data");
      input.pause();
      socket.unpipe(output);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const finishSoon = () => {
      if (!settled) grace ??= setTimeout(() => finish(), SHUTDOWN_GRACE_MS);
    };
    const inputGone = () => {
      // Lets the daemon close its side too. It stays open for what's in flight,
      // but a stalled client must not keep this process waiting for that close.
      socket.end();
      finishSoon();
    };

    const hangupPoll = setInterval(() => {
      if (output === process.stdout && hasHungUp(1)) finish();
      else if (input === process.stdin && hasHungUp(0)) finishSoon();
      else if (connected) {
        // Bun can close a paused socket's fd (-1) without any event saying so.
        const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
        if (typeof fd === "number" && (fd < 0 || hasHungUp(fd))) finishSoon();
      }
    }, HANGUP_POLL_MS);

    input.once("end", inputGone);
    input.once("close", inputGone);
    input.once("error", inputGone);
    output.once("close", () => finish());
    output.on("error", () => finish());

    socket.once("connect", () => {
      connected = true;
      if (options.filter) {
        connectFiltered(input, output, socket, options.filter);
        return;
      }
      input.pipe(socket, { end: false });
      // Never end process.stdout when the daemon socket closes.
      socket.pipe(output, { end: false });
    });
    socket.once("error", (error) => finish(new Error(connected
      ? `lost Exocortex daemon socket ${options.socketPath}: ${error.message}`
      : `cannot connect to Exocortex daemon socket ${options.socketPath}: ${error.message}`,
    )));
    // A remote daemon/helper shutdown ends its event stream. Do not wait for a
    // still-open stdin to make the duplex socket's close event possible.
    socket.once("end", () => finish());
    socket.once("close", () => finish(
      connected ? undefined : new Error(`cannot connect to Exocortex daemon socket ${options.socketPath}: connection closed`),
    ));
  });
}
