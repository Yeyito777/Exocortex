/**
 * Runs the real proxy-main.ts over real pipes: its stdio peer or the daemon goes
 * away, and it must exit without spinning (it used to stay at ~150% CPU for hours).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, mkdirSync, read, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { socketPath } from "@exocortex/shared/paths";

type Peer = "stdin" | "stdout" | "stderr" | "daemon";

interface Proxy {
  process: Bun.Subprocess;
  daemon: Socket;
  /** This test's end of each pipe, until closed. */
  stdin: number | null;
  stdout: number | null;
  stderr: number | null;
}

const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
});

const EXIT_LIMIT_MS = 6000;
/** A spinning proxy burns this within the limit; one that waits doesn't come close. */
const CPU_LIMIT_MS = 2000;
const STATUS_LINE = `${JSON.stringify({ type: "provider_proxy_status_result", reqId: "r", padding: "x".repeat(4000) })}\n`;

let server: Server;
const accepted: ((socket: Socket) => void)[] = [];
let spawnQueue: Promise<unknown> = Promise.resolve();
const running = new Set<Bun.Subprocess>();

beforeAll(async () => {
  mkdirSync(dirname(socketPath()), { recursive: true });
  rmSync(socketPath(), { force: true });
  server = createServer(socket => {
    socket.on("error", () => {});
    accepted.shift()?.(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(), resolve);
  });
});

afterAll(() => {
  for (const child of running) killGroup(child);
  server.close();
});

function killGroup(child: Bun.Subprocess): void {
  try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

/**
 * A real pipe, as sshd gives the proxy. Bun.spawn's "pipe" stdout reads eagerly,
 * so it can't stall the proxy, and macOS FIFOs don't report a closed writer.
 */
function pipe(): { read: number; write: number } {
  const fds = new Int32Array(2);
  if (libc.symbols.pipe(ptr(fds)) !== 0) throw new Error("pipe failed");
  return { read: fds[0]!, write: fds[1]! };
}

/** One proxy at a time up to its connection, so each gets its own daemon socket. */
function startProxy(linkOnly: boolean): Promise<Proxy> {
  const started = spawnQueue.then(async () => {
    const connection = new Promise<Socket>(resolve => accepted.push(resolve));
    const [stdin, stdout, stderr] = [pipe(), pipe(), pipe()];
    const child = Bun.spawn([process.execPath, "run", "src/proxy-main.ts", ...(linkOnly ? ["--link-only=anthropic"] : [])], {
      cwd: `${import.meta.dir}/..`,
      env: process.env,
      stdio: [stdin.read, stdout.write, stderr.write],
      detached: true,
    });
    running.add(child);
    for (const fd of [stdin.read, stdout.write, stderr.write]) closeSync(fd);
    const daemon = await Promise.race([connection, Bun.sleep(EXIT_LIMIT_MS).then(() => null)]);
    if (!daemon) throw new Error("the proxy never connected");
    return { process: child, daemon, stdin: stdin.write, stdout: stdout.read, stderr: stderr.read };
  });
  spawnQueue = started.catch(() => {});
  return started;
}

/** Writes until the proxy stops reading: it has filled its stdout pipe and paused the socket. */
async function fillUntilStalled(daemon: Socket): Promise<void> {
  const deadline = Date.now() + EXIT_LIMIT_MS;
  while (Date.now() < deadline) {
    if (daemon.write(STATUS_LINE)) continue;
    const drained = await Promise.race([
      new Promise<boolean>(resolve => daemon.once("drain", () => resolve(true))),
      Bun.sleep(300).then(() => false),
    ]);
    if (!drained) return;
  }
  throw new Error("the proxy kept reading with nobody reading its stdout");
}

function closePeer(peer: Peer, proxy: Proxy): void {
  if (peer === "daemon") {
    proxy.daemon.destroy();
    return;
  }
  closeSync(proxy[peer]!);
  proxy[peer] = null;
}

/** Reads stdout to EOF or up to `length` bytes, pausing between reads to keep the proxy waiting. */
async function readStdout(proxy: Proxy, length: number, pauseMs = 0): Promise<string> {
  const buffer = Buffer.alloc(16 * 1024);
  let received = "";
  while (received.length < length) {
    const count = await new Promise<number>((resolve, reject) => {
      read(proxy.stdout!, buffer, 0, buffer.length, null, (err, bytes) => err ? reject(err) : resolve(bytes));
    });
    if (count === 0) break;
    received += buffer.toString("utf8", 0, count);
    if (pauseMs > 0) await Bun.sleep(pauseMs);
  }
  return received;
}

async function expectExit(proxy: Proxy): Promise<void> {
  const exited = await Promise.race([proxy.process.exited.then(() => true), Bun.sleep(EXIT_LIMIT_MS).then(() => false)]);
  if (!exited) killGroup(proxy.process);
  await proxy.process.exited;
  running.delete(proxy.process);
  for (const peer of ["stdin", "stdout", "stderr"] as const) {
    if (proxy[peer] !== null) closePeer(peer, proxy);
  }
  proxy.daemon.destroy();
  expect(exited).toBe(true);
  expect(Number(proxy.process.resourceUsage()!.cpuTime.total) / 1000).toBeLessThan(CPU_LIMIT_MS);
}

const allStdio: Peer[] = ["stdin", "stdout", "stderr"];
const scenarios: { name: string; busy: boolean; close: Peer[] }[] = [
  { name: "stdin closes while idle", busy: false, close: ["stdin"] },
  { name: "stdout closes while idle", busy: false, close: ["stdout"] },
  { name: "all stdio closes while idle", busy: false, close: allStdio },
  { name: "the daemon closes while idle", busy: false, close: ["daemon"] },
  { name: "stdin closes with stdout stalled", busy: true, close: ["stdin"] },
  { name: "the daemon closes with stdout stalled", busy: true, close: ["daemon"] },
  { name: "stdout closes with data in flight", busy: true, close: ["stdout"] },
  { name: "stdin and stdout close with data in flight", busy: true, close: ["stdin", "stdout"] },
  { name: "all stdio closes with data in flight", busy: true, close: allStdio },
  { name: "all stdio then the daemon close with data in flight", busy: true, close: [...allStdio, "daemon"] },
  { name: "the daemon then all stdio close with data in flight", busy: true, close: ["daemon", ...allStdio] },
];

const TEST_TIMEOUT_MS = EXIT_LIMIT_MS * 2 + 2000;

for (const linkOnly of [false, true]) {
  describe(`exocortexd proxy${linkOnly ? " --link-only" : ""} exits`, () => {
    for (const { name, busy, close } of scenarios) {
      test.concurrent(`when ${name}`, async () => {
        const proxy = await startProxy(linkOnly);
        if (busy) await fillUntilStalled(proxy.daemon);
        for (const peer of close) closePeer(peer, proxy);
        await expectExit(proxy);
      }, TEST_TIMEOUT_MS);
    }
  });

  describe(`exocortexd proxy${linkOnly ? " --link-only" : ""} delivers`, () => {
    test.concurrent("everything the daemon sent before closing, to a slow reader", async () => {
      const proxy = await startProxy(linkOnly);
      const length = STATUS_LINE.length * 100;
      proxy.daemon.end(STATUS_LINE.repeat(100));
      expect((await readStdout(proxy, length, 5)).length).toBe(length);
      await expectExit(proxy);
    }, TEST_TIMEOUT_MS);

    test.concurrent("the daemon's reply when stdin closes right after", async () => {
      const proxy = await startProxy(linkOnly);
      proxy.daemon.write(STATUS_LINE);
      closePeer("stdin", proxy);
      expect(await readStdout(proxy, STATUS_LINE.length)).toBe(STATUS_LINE);
      await expectExit(proxy);
    }, TEST_TIMEOUT_MS);

    test.concurrent("with stderr closed", async () => {
      const proxy = await startProxy(linkOnly);
      closePeer("stderr", proxy);
      await Bun.sleep(1500);
      proxy.daemon.write(STATUS_LINE);
      expect(await readStdout(proxy, STATUS_LINE.length)).toBe(STATUS_LINE);
      proxy.daemon.destroy();
      await expectExit(proxy);
    }, TEST_TIMEOUT_MS);
  });
}
