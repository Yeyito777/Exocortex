/**
 * Transparent stdio bridge to this machine's Exocortex daemon socket.
 *
 * It is intentionally protocol-unaware. `ssh host exocortexd proxy` uses this
 * helper so the SSH channel carries exactly the daemon's JSON-lines stream.
 * Diagnostics belong on stderr; stdout is reserved for daemon events.
 */

import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";

export interface IpcProxyOptions {
  socketPath: string;
  input?: Readable;
  output?: Writable;
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
      input.pause();
      socket.unpipe(output);
      if (error) reject(error);
      else resolve();
    };

    socket.once("connect", () => {
      connected = true;
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
