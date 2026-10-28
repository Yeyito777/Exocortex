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
import type { LinkOnlyFilter } from "./ipc-link-filter";

export interface IpcProxyOptions {
  socketPath: string;
  input?: Readable;
  output?: Writable;
  filter?: LinkOnlyFilter;
}

/** A filtered line longer than this closes the bridge: a link request body (32 MiB) in base64, with room. */
const MAX_FILTERED_LINE_BYTES = 64 * 1024 * 1024;

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
  input.once("end", () => socket.end());
  splitLines(socket, (line) => {
    const passed = filter.fromDaemon(line);
    if (passed !== null) writeLine(output, socket, passed);
  }, tooLong);
}

export async function runIpcProxy(options: IpcProxyOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;

  await new Promise<void>((resolve, reject) => {
    const socket = connect(options.socketPath);
    let connected = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.unpipe(socket);
      input.removeAllListeners("data");
      input.pause();
      socket.unpipe(output);
      if (error) reject(error);
      else resolve();
    };

    socket.once("connect", () => {
      connected = true;
      if (options.filter) {
        connectFiltered(input, output, socket, options.filter);
        return;
      }
      input.pipe(socket);
      // Never end process.stdout when the daemon socket closes.
      socket.pipe(output, { end: false });
    });
    socket.once("error", (error) => finish(new Error(
      `cannot connect to Exocortex daemon socket ${options.socketPath}: ${error.message}`,
    )));
    socket.once("end", () => {
      // A remote daemon/helper shutdown ends its event stream. Do not wait for a
      // still-open stdin to make the duplex socket's close event possible.
      socket.destroy();
      finish();
    });
    socket.once("close", () => finish(
      connected ? undefined : new Error(`cannot connect to Exocortex daemon socket ${options.socketPath}: connection closed`),
    ));
  });
}
