#!/usr/bin/env bun
/**
 * restart-timing — measure graceful restarts of this worktree's test daemon.
 *
 * Usage (from a linked worktree, never the main checkout):
 *   bun scripts/dev/restart-timing.ts [--runs N]
 *
 * Each run mirrors the service path of `exocortexd restart`: the wrapper's own
 * prepare_restart_for_replay function, SIGTERM (systemd stop), then a fresh
 * scripts/setup/run-daemon.sh (systemd start). Two clients watch the outage:
 * an ideal one that pings every 10ms, and one following the TUI's reconnect
 * policy. Daemon-side phases come from EXOCORTEX_PROFILE_STARTUP marks.
 *
 * For realistic boot numbers seed config/data/instances/<worktree> first (see
 * the exotest-e2e-seeding notes); the instance must not hold active goals,
 * pending titles or queued messages, which would start model turns at boot.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { socketPath, worktreeName } from "../../shared/src/paths";
import { reconnectDelayMs } from "../../tui/src/reconnect-delay";

const ROOT = resolve(import.meta.dir, "../..");
const SOCKET = socketPath();
const POLL_MS = 10;

if (!worktreeName()) {
  console.error("restart-timing: run from a linked worktree; it never restarts the main daemon");
  process.exit(2);
}

const runsArg = process.argv.indexOf("--runs");
const RUNS = runsArg > 0 ? Math.max(1, Number.parseInt(process.argv[runsArg + 1] ?? "", 10) || 1) : 5;

const now = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Daemon process ──────────────────────────────────────────────────

interface DaemonRun {
  child: ChildProcess;
  spawnedAt: number;
  marks: Map<string, number>;
  exited: Promise<number | null>;
}

function startDaemon(): DaemonRun {
  const marks = new Map<string, number>();
  const spawnedAt = now();
  const child = spawn(join(ROOT, "scripts/setup/run-daemon.sh"), [], {
    cwd: ROOT,
    env: { ...process.env, EXOCORTEX_PROFILE_STARTUP: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let buffer = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const match = /\[startup-profile\] (\{.*\})/.exec(line);
      if (!match) continue;
      const mark = JSON.parse(match[1]) as { event: string; epochMs?: number };
      if (typeof mark.epochMs === "number") marks.set(mark.event, mark.epochMs);
    }
  });
  const exited = new Promise<number | null>(r => child.once("exit", code => r(code)));
  return { child, spawnedAt, marks, exited };
}

// ── Clients ─────────────────────────────────────────────────────────

/** Connect, ping, resolve with the pong time; reject on any failure. */
function pingOnce(timeoutMs = 5_000): Promise<number> {
  return new Promise((resolvePong, reject) => {
    if (!existsSync(SOCKET)) { reject(new Error("no socket")); return; }
    const socket = connect(SOCKET);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timeout")); }, timeoutMs);
    socket.on("connect", () => socket.write(JSON.stringify({ type: "ping", reqId: "restart-timing" }) + "\n"));
    socket.on("data", (data) => {
      buffer += data.toString("utf-8");
      if (buffer.includes('"type":"pong"')) {
        clearTimeout(timer);
        socket.destroy();
        resolvePong(now());
      }
    });
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.on("close", () => { clearTimeout(timer); reject(new Error("closed")); });
  });
}

/** Pings back-to-back; records the last pong before and first pong after `cutover`. */
class IdealClient {
  private stopped = false;
  readonly pongs: number[] = [];
  private loop = (async () => {
    while (!this.stopped) {
      try { this.pongs.push(await pingOnce()); } catch { /* outage */ }
      await sleep(POLL_MS);
    }
  })();
  async stop(): Promise<void> { this.stopped = true; await this.loop; }
}

/** Holds a connection like the TUI; on close reconnects with the TUI's policy. */
class TuiLikeClient {
  disconnectedAt: number | null = null;
  reconnectedAt: number | null = null;
  attempts = 0;
  private stopped = false;
  private socket: ReturnType<typeof connect> | null = null;

  async connectInitial(): Promise<void> {
    await this.open();
  }

  private open(): Promise<void> {
    return new Promise((resolveOpen, reject) => {
      if (!existsSync(SOCKET)) { reject(new Error("no socket")); return; }
      const socket = connect(SOCKET);
      let opened = false;
      let buffer = "";
      socket.on("connect", () => socket.write(JSON.stringify({ type: "ping", reqId: "tui-like" }) + "\n"));
      socket.on("data", (data) => {
        buffer += data.toString("utf-8");
        if (!opened && buffer.includes('"type":"pong"')) {
          opened = true;
          this.socket = socket;
          resolveOpen();
        }
      });
      socket.on("error", (err) => { if (!opened) reject(err); });
      socket.on("close", () => {
        if (!opened) { reject(new Error("closed")); return; }
        if (this.socket === socket) this.onLost();
      });
    });
  }

  private onLost(): void {
    this.socket = null;
    if (this.stopped) return;
    this.disconnectedAt = now();
    void this.reconnect(0);
  }

  private async reconnect(failed: number): Promise<void> {
    while (!this.stopped) {
      this.attempts++;
      try {
        await this.open();
        this.reconnectedAt = now();
        return;
      } catch {
        await sleep(reconnectDelayMs(failed++, false));
      }
    }
  }

  stop(): void { this.stopped = true; this.socket?.destroy(); }
}

// ── Restart ─────────────────────────────────────────────────────────

/** Run the wrapper's own prepare step against this worktree (no systemctl). */
function runWrapperPrepare(): { ok: boolean; output: string } {
  const wrapper = join(ROOT, "bin/exocortexd");
  const script = [
    `source <(sed -n '/^prepare_restart_for_replay()/,/^}/p' ${JSON.stringify(wrapper)})`,
    `PROJECT_DIR=${JSON.stringify(ROOT)}`,
    "prepare_restart_for_replay",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf-8" });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface RunTimings {
  prepareMs: number;
  shutdownMs: number;
  processStartMs: number | null;
  listeningMs: number | null;
  readyMs: number | null;
  firstPongMs: number;
  idealOutageMs: number;
  tuiOutageMs: number | null;
  tuiAttempts: number;
  totalMs: number;
}

async function measureRestart(current: DaemonRun): Promise<{ timings: RunTimings; next: DaemonRun }> {
  const ideal = new IdealClient();
  const tui = new TuiLikeClient();
  await tui.connectInitial();
  await sleep(50);

  const t0 = now();
  const prepared = runWrapperPrepare();
  if (!prepared.ok) throw new Error(`prepare failed: ${prepared.output}`);
  const t1 = now();

  current.child.kill("SIGTERM");
  await current.exited;
  const t2 = now();

  const next = startDaemon();
  await waitFor(() => (ideal.pongs.at(-1) ?? 0) > t2 ? true : null, 30_000, "first pong from the new daemon");
  await waitFor(() => tui.reconnectedAt, 30_000, "TUI-like reconnect");
  await waitFor(() => next.marks.get("ready"), 30_000, "ready mark");
  await ideal.stop();
  tui.stop();

  const firstPong = ideal.pongs.find(t => t > t2)!;
  const lastPongBefore = [...ideal.pongs].reverse().find(t => t < t2) ?? t0;
  const rel = (event: string, base: number, run: DaemonRun) => {
    const value = run.marks.get(event);
    return value === undefined ? null : value - base;
  };
  const timings: RunTimings = {
    prepareMs: t1 - t0,
    shutdownMs: t2 - t1,
    processStartMs: rel("module_ready", next.spawnedAt, next),
    listeningMs: rel("clients_can_connect", next.spawnedAt, next),
    readyMs: rel("ready", next.spawnedAt, next),
    firstPongMs: firstPong - next.spawnedAt,
    idealOutageMs: firstPong - lastPongBefore,
    tuiOutageMs: tui.reconnectedAt !== null && tui.disconnectedAt !== null ? tui.reconnectedAt - tui.disconnectedAt : null,
    tuiAttempts: tui.attempts,
    totalMs: firstPong - t0,
  };
  return { timings, next };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const LABELS: Array<[keyof RunTimings, string]> = [
  ["prepareMs", "prepare (wrapper prepare-restart)"],
  ["shutdownMs", "shutdown (SIGTERM → exit)"],
  ["processStartMs", "boot: spawn → modules loaded"],
  ["listeningMs", "boot: spawn → socket listening"],
  ["readyMs", "boot: spawn → ready"],
  ["firstPongMs", "boot: spawn → first pong"],
  ["idealOutageMs", "outage, 10ms-polling client"],
  ["tuiOutageMs", "outage, TUI reconnect policy"],
  ["totalMs", "total: prepare start → first pong"],
];

async function main(): Promise<void> {
  const pidFile = join(ROOT, "config/runtime", worktreeName()!, "exocortexd.pid");
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
    try { process.kill(pid, 0); console.error(`restart-timing: test daemon already running (pid ${pid}); stop it first`); process.exit(2); } catch { /* stale */ }
  }

  console.log(`restart-timing: ${worktreeName()} (${RUNS} run(s)), socket ${SOCKET}`);
  let daemon = startDaemon();
  try {
    await waitFor(() => daemon.marks.get("ready"), 60_000, "initial daemon ready");
    await sleep(1_000); // let deferred boot work settle before the first restart
    const results: RunTimings[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { timings, next } = await measureRestart(daemon);
      daemon = next;
      results.push(timings);
      console.log(`run ${i + 1}: ${LABELS.map(([key]) => `${key}=${timings[key] === null ? "-" : Math.round(timings[key] as number)}`).join(" ")}`);
      await sleep(1_000);
    }
    console.log("\nmedian over runs (ms):");
    for (const [key, label] of LABELS) {
      const values = results.map(r => r[key]).filter((v): v is number => typeof v === "number");
      console.log(`  ${label.padEnd(38)} ${values.length ? Math.round(median(values)).toString().padStart(6) : "     -"}`);
    }
  } finally {
    daemon.child.kill("SIGTERM");
    await Promise.race([daemon.exited, sleep(10_000)]);
  }
}

await main();
