import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runIpcProxy } from "./ipc-proxy";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("stdio IPC proxy", () => {
  test("copies protocol bytes in both directions without adding stdout data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-proxy-test-"));
    tempDirs.push(dir);
    const path = join(dir, "daemon.sock");
    const received: string[] = [];
    const server = createServer(socket => {
      socket.on("data", chunk => {
        received.push(chunk.toString("utf8"));
        socket.end('{"type":"pong","reqId":"one"}\n');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });

    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.on("data", chunk => { stdout += chunk.toString("utf8"); });
    const proxy = runIpcProxy({ socketPath: path, input, output });
    input.write('{"type":"ping","reqId":"one"}\n');

    await proxy;
    await new Promise<void>(resolve => server.close(() => resolve()));
    expect(received.join("")).toBe('{"type":"ping","reqId":"one"}\n');
    expect(stdout).toBe('{"type":"pong","reqId":"one"}\n');
  });

  test("reports a missing daemon socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-proxy-missing-"));
    tempDirs.push(dir);
    await expect(runIpcProxy({
      socketPath: join(dir, "missing.sock"),
      input: new PassThrough(),
      output: new PassThrough(),
    })).rejects.toThrow("cannot connect to Exocortex daemon socket");
  });
});
