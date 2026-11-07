#!/usr/bin/env bun
/**
 * check — typecheck shared, daemon and tui, and run the shared, daemon and
 * TUI test suites, all at once. The pre-merge check: `bun run check` at the repo root.
 *
 * Usage:
 *   bun run check [--changed [--base REF]] [--jobs N (default 2/3 of the cores)] [--timeout SECONDS] [--update-timings] [STEP...]
 *
 * STEP is any of: typecheck, shared, daemon, tui (default: all four).
 *
 * --changed runs only the test files and typechecks that this branch's
 * changes since it left origin/main (or REF), uncommitted and untracked files
 * included, can affect; everything when it can't tell (scripts/dev/test-select.ts).
 *
 * - Typechecks are incremental (tsconfig `incremental`, build info under
 *   node_modules/.cache/tsc), so an unchanged package checks in a second or two.
 * - Each suite runs as `bun test --parallel`: every test file in a fresh global
 *   (per-file test config dir, see test/setup-config.ts), slowest files first
 *   by test/timings/<suite>.json and this checkout's last measured durations
 *   (FIRST_IN_FRESH_WORKER files ahead of all: a bun hang workaround).
 * - All temp files go in one per-run TMPDIR, removed at the end, also on
 *   failure, timeout or Ctrl-C.
 * - A step that outlives --timeout (default 90 s) has its process group
 *   killed; failures list file and test name; exit status 1 on any failure.
 * - On Linux it runs in a systemd scope with a larger CPU share (runInCpuScope).
 *
 * `--update-timings` rewrites test/timings/*.json (tracked) from this run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { select, SUITES, workingChanges, workingTree, type Selection } from "./test-select";

const ROOT = resolve(import.meta.dir, "../..");
const CACHE = join(ROOT, "node_modules/.cache/exocortex-check");
const STEPS = ["typecheck", "shared", "daemon", "tui"] as const;
type StepName = (typeof STEPS)[number];

interface Options { jobs: number; timeoutMs: number; updateTimings: boolean; steps: StepName[]; changed: boolean; base?: string }

/** Both suites and three tsc processes share the machine; ~2/3 of the cores per suite measured fastest. */
function defaultJobs(): number {
  return Math.max(2, Math.round(availableParallelism() * 2 / 3));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { jobs: defaultJobs(), timeoutMs: 90_000, updateTimings: false, steps: [], changed: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) usage(`${arg} needs a value`);
      return next;
    };
    if (arg === "--jobs" || arg === "-j") options.jobs = positiveInt(value(), arg);
    else if (arg === "--timeout") options.timeoutMs = positiveInt(value(), arg) * 1000;
    else if (arg === "--update-timings") options.updateTimings = true;
    else if (arg === "--changed") options.changed = true;
    else if (arg === "--base") { options.base = value(); options.changed = true; }
    else if (arg === "-h" || arg === "--help") usage();
    else if ((STEPS as readonly string[]).includes(arg)) options.steps.push(arg as StepName);
    else usage(`unknown argument: ${arg}`);
  }
  if (options.steps.length === 0) options.steps = [...STEPS];
  return options;
}

function positiveInt(text: string, flag: string): number {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) usage(`${flag} needs a positive integer, got ${text}`);
  return n;
}

function usage(error?: string): never {
  if (error) console.error(`check: ${error}`);
  console.error("Usage: bun run check [--changed [--base REF]] [--jobs N] [--timeout SECONDS] [--update-timings] [typecheck] [shared] [daemon] [tui]");
  process.exit(error ? 2 : 0);
}

// ── Running a command ─────────────────────────────────────────────

interface Run { label: string; ok: boolean; output: string; ms: number; timedOut: boolean }

const children = new Set<ChildProcess>();

/** Processes in session `sid`. bun's --parallel workers each lead their own process group but stay in the session. */
function sessionMembers(sid: number): number[] {
  const found = Bun.spawnSync(["pgrep", "-s", String(sid)], { stdout: "pipe", stderr: "ignore" });
  return found.stdout.toString().split("\n").map(Number).filter(pid => pid > 0 && pid !== process.pid);
}

function killSession(sid: number): void {
  for (const pid of [sid, ...sessionMembers(sid)]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** What a timed-out step was still running, for the report. */
function stillRunning(sid: number): string {
  const pids = [sid, ...sessionMembers(sid)].join(",");
  const ps = Bun.spawnSync(["ps", "-o", "pid=,etime=,args=", "-p", pids], { stdout: "pipe", stderr: "ignore" });
  return ps.stdout.toString().trimEnd().split("\n").map(line => `  ${line.trim().slice(0, 200)}`).join("\n");
}

/** Kill the step's whole session (it leads one) and wait until nothing in it is left to write temp files. */
async function killSessionAndWait(sid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    killSession(sid);
    if (sessionMembers(sid).length === 0) return;
    await Bun.sleep(10);
  }
}

/** Run in its own session so a timeout or Ctrl-C takes its workers and daemons with it. */
function run(label: string, cmd: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  const started = performance.now();
  return new Promise(resolvePromise => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const chunks: Buffer[] = [];
    child.stdout!.on("data", chunk => chunks.push(chunk));
    child.stderr!.on("data", chunk => chunks.push(chunk));
    let timedOut = false;
    let stuck = "";
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid === undefined) return;
      stuck = stillRunning(child.pid);
      killSession(child.pid);
    }, timeoutMs);
    // On exit, not close: a stray process holding the step's stdout would keep
    // the pipes open until the timeout.
    const closed = new Promise<void>(resolveClosed => child.on("close", () => resolveClosed()));
    let finished = false;
    const finish = async (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Anything the step left behind in its session (a test's stray daemon)
      // goes too, and is gone before its temp files are removed.
      if (child.pid !== undefined) await killSessionAndWait(child.pid);
      await Promise.race([closed, Bun.sleep(2_000)]);
      children.delete(child);
      let output = Buffer.concat(chunks).toString("utf8");
      if (error) output += `\n${error.message}\n`;
      if (timedOut) output += `\ncheck: ${label} still running after ${timeoutMs / 1000}s; killed its processes:\n${stuck}\n`;
      resolvePromise({ label, ok: code === 0 && !timedOut, output, ms: performance.now() - started, timedOut });
    };
    child.on("error", error => void finish(null, error));
    child.on("exit", code => void finish(code));
  });
}

// ── Steps ─────────────────────────────────────────────────────────

interface Result { label: string; ok: boolean; ms: number; summary: string; details: string }

async function typecheck(pkg: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Result> {
  const result = await run(`typecheck ${pkg}`, ["bunx", "tsc", "--noEmit", "-p", pkg], ROOT, env, timeoutMs);
  const errors = result.output.match(/error TS\d+/g)?.length ?? 0;
  return {
    label: result.label, ok: result.ok, ms: result.ms,
    summary: result.ok ? "ok" : errors ? `${errors} error${errors === 1 ? "" : "s"}` : "failed",
    details: result.ok ? "" : result.output.trim(),
  };
}

interface Failure { file: string; name: string; message: string }

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function unescapeXml(text: string): string {
  return text.replace(/&#10;/g, "\n").replace(/&#9;/g, "\t").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Failed test cases from bun's JUnit report: file, "describe > test" name and the first lines of the error. */
function junitFailures(xml: string): Failure[] {
  const failures: Failure[] = [];
  const caseRe = /<testcase name="([^"]*)" classname="([^"]*)"[^>]*? file="([^"]*)"[^>]*>\s*<failure[^>]*?message="([^"]*)"/g;
  for (const match of xml.matchAll(caseRe)) {
    const [, name, classname, file, message] = match;
    const fullName = [unescapeXml(classname), unescapeXml(name)].filter(Boolean).join(" > ");
    failures.push({ file, name: fullName, message: truncate(unescapeXml(message).split("\n").map(line => line.trim()).filter(Boolean).slice(0, 3).join(" "), 240) });
  }
  return failures;
}

/** bun test prints each file's output under a "path:" header; keep the blocks that failed or errored. */
function failingBlocks(output: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.join("\n");
    if (/^\(fail\)|^# Unhandled error|^error: /m.test(text)) blocks.push(text.trimEnd());
  };
  for (const line of output.split("\n")) {
    if (/^\S+\.(test|spec)\.[cm]?[jt]sx?:$/.test(line)) { flush(); current = [line]; }
    else if (/^ \d+ (pass|fail|skip)$|^Ran \d+ tests? across/.test(line)) { flush(); current = null; }
    else current?.push(line);
  }
  flush();
  // Terminal control sequences that TUI tests print would garble the report.
  return blocks.map(block => block.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
}

/** The tracked copy keeps only files that still exist (the local one remembers deleted ones). */
function writeTrackedTimings(local: string, tracked: string, cwd: string): void {
  const timings = JSON.parse(readFileSync(local, "utf8")) as { version: number; files: Record<string, number> };
  const files = Object.fromEntries(Object.entries(timings.files)
    .filter(([file]) => existsSync(join(cwd, file)))
    .sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(tracked), { recursive: true });
  writeFileSync(tracked, `${JSON.stringify({ ...timings, files }, null, 2)}\n`);
}

type Suite = "shared" | "daemon" | "tui";

/**
 * Files each started first in a fresh worker. bun 1.4.2 under --isolate can
 * wedge a worker that has already run other files: in updatecheck.test.ts its
 * main thread spins at 100% CPU with finished git children never reaped, and
 * not even the 5 s test timeout fires. As a worker's first file it never hung.
 * Repro: scripts/dev/repro/bun-isolate-hang.sh.
 */
const FIRST_IN_FRESH_WORKER: Partial<Record<Suite, string[]>> = { tui: ["src/updatecheck.test.ts"] };

function readTimings(path: string): Record<string, number> {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { files?: Record<string, number> }).files ?? {};
  } catch {
    return {};
  }
}

/**
 * One timings file for the run: this checkout's measurements over the tracked
 * ones, with FIRST_IN_FRESH_WORKER above everything. bun starts the slowest N
 * files as the first file of each of its N workers.
 */
function writeRunTimings(name: Suite, path: string, local: string, tracked: string): Map<string, { pin: number; was?: number }> {
  const files = { ...readTimings(tracked), ...readTimings(local) };
  const top = Math.max(0, ...Object.values(files));
  const pinned = new Map<string, { pin: number; was?: number }>();
  const first = FIRST_IN_FRESH_WORKER[name] ?? [];
  first.forEach((file, i) => {
    const pin = top + 1_000_000 * (first.length - i);
    pinned.set(file, { pin, was: files[file] });
    files[file] = pin;
  });
  writeFileSync(path, JSON.stringify({ version: 1, files }));
  return pinned;
}

/** `files`: only these test files (relative to the suite); undefined runs them all. */
async function suite(name: Suite, options: Options, env: NodeJS.ProcessEnv, runTmp: string, files?: string[]): Promise<Result> {
  const cwd = join(ROOT, name);
  const tracked = join(ROOT, "test/timings", `${name}.json`);
  const local = join(CACHE, `${name}-timings.json`);
  const runTimings = join(runTmp, `${name}-timings.json`);
  const junit = join(runTmp, `${name}.junit.xml`);
  const pinned = writeRunTimings(name, runTimings, local, tracked);
  const cmd = [process.execPath, "test", `--parallel=${options.jobs}`, `--timings=${runTimings}`, "--update-timings",
    "--reporter=junit", `--reporter-outfile=${junit}`, ...(files ?? []).map(file => `./${file}`)];
  const result = await run(`${name} tests`, cmd, cwd, env, options.timeoutMs);
  // bun rewrote the run's file with what it measured; a pin it didn't measure goes back.
  const measured = readTimings(runTimings);
  for (const [file, { pin, was }] of pinned) {
    if (measured[file] !== pin) continue;
    if (was === undefined) delete measured[file];
    else measured[file] = was;
  }
  // A run of some files keeps what earlier runs measured for the rest.
  writeFileSync(local, JSON.stringify({ version: 1, files: { ...(files ? readTimings(local) : {}), ...measured } }, null, 2));
  if (options.updateTimings && result.ok && !files) writeTrackedTimings(local, tracked, cwd);

  const counts = Object.fromEntries(["pass", "fail", "skip"].map(kind =>
    [kind, Number(new RegExp(`^ (\\d+) ${kind}$`, "m").exec(result.output)?.[1] ?? 0)]));
  const errors = Number(/^ (\d+) errors?$/m.exec(result.output)?.[1] ?? 0);
  const failures = existsSync(junit) ? junitFailures(readFileSync(junit, "utf8")) : [];
  const ok = result.ok && counts.fail === 0 && errors === 0;
  const summary = [`${counts.pass} pass`, counts.skip ? `${counts.skip} skip` : "", counts.fail ? `${counts.fail} fail` : "",
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "", result.timedOut ? "timed out" : ""].filter(Boolean).join(", ");
  let details = "";
  if (!ok) {
    const blocks = failingBlocks(result.output);
    const list = failures.map(f => `  ✗ ${name}/${f.file} > ${f.name}\n      ${f.message}`).join("\n");
    details = [
      blocks.length ? blocks.join("\n\n") : "",
      !blocks.length || result.timedOut ? result.output.trim().split("\n").slice(-40).join("\n") : "",
      list ? `Failed tests:\n${list}` : "",
    ].filter(Boolean).join("\n\n");
  }
  return { label: result.label, ok, ms: result.ms, summary, details };
}

// ── CPU share ─────────────────────────────────────────────────────

const IN_SCOPE = "EXOCORTEX_CHECK_SCOPE";
const SCOPE_CPU_WEIGHT = 1000;

/**
 * Under a systemd user manager every unit gets the same CPU share (cgroup v2
 * cpu.weight 100), whatever its nice level, so a busy background unit (a
 * niced replay) slows the check as much as anything else and its real-time
 * waits run out. On Linux the check reruns itself in a transient scope with
 * CPUWeight=1000. That only matters while the CPU is contended. Returns the
 * scoped run's exit status, or null to run here: not Linux, already scoped,
 * or no systemd-run or user manager.
 *
 * The scope leaves this process's cgroup (an Exocortex turn's, say), so the
 * scoped check watches this process: if it dies, even by SIGKILL, the scoped
 * one stops and kills its steps as on Ctrl-C. EXOCORTEX_CHECK_SCOPE=off runs
 * the check here.
 */
async function runInCpuScope(): Promise<number | null> {
  if (process.platform !== "linux" || process.env[IN_SCOPE]) return null;
  const scope = ["systemd-run", "--user", "--scope", "--quiet", "--collect", "-p", `CPUWeight=${SCOPE_CPU_WEIGHT}`];
  let probe: ReturnType<typeof Bun.spawnSync>;
  try {
    probe = Bun.spawnSync([...scope, "true"], { stdout: "ignore", stderr: "ignore", timeout: 5_000 });
  } catch {
    return null;
  }
  if (probe.exitCode !== 0) return null;
  const child = spawn(scope[0], [...scope.slice(1), process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: { ...process.env, [IN_SCOPE]: String(process.pid) }, stdio: "inherit",
  });
  // A terminal's Ctrl-C reaches both processes; a signal sent to this one alone is passed on.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
  }
  return new Promise(resolveStatus => {
    child.on("error", () => resolveStatus(1));
    child.on("exit", (code, signal) => resolveStatus(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}

/**
 * In the scope, everything else in its cgroup is this check's: a step's
 * process that left the step's session (a test's detached helper) goes too.
 */
function killRestOfScope(): void {
  if (!(Number(process.env[IN_SCOPE]) > 0)) return;
  try {
    const cgroup = readFileSync("/proc/self/cgroup", "utf8").match(/^0::(.*)$/m)?.[1];
    if (!cgroup?.endsWith(".scope")) return;
    const pids = readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").split("\n").map(Number);
    for (const pid of pids) if (pid > 0 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  } catch { /* no cgroup v2 view */ }
}

/** In the scope: the launcher is the parent (systemd-run execs the check); once it's gone the parent changes. */
function stopWhenLauncherGoes(stop: (why: string) => void): void {
  const launcher = Number(process.env[IN_SCOPE]);
  if (!(launcher > 0)) return;
  const watch = setInterval(() => { if (process.ppid !== launcher) stop("launcher gone"); }, 250);
  watch.unref();
}

// ── Main ──────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));
const scoped = await runInCpuScope();
if (scoped !== null) process.exit(scoped);
mkdirSync(CACHE, { recursive: true });
// Short: some tests put unix sockets under TMPDIR (sun_path holds ~104 bytes).
const runTmp = mkdtempSync(join(tmpdir(), "exck-"));
const cleanup = () => rmSync(runTmp, { recursive: true, force: true, maxRetries: 3 });
const stop = (why: string) => {
  console.error(`\ncheck: ${why}; stopping`);
  for (const child of children) if (child.pid !== undefined) killSession(child.pid);
  killRestOfScope();
  cleanup();
  process.exit(130);
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop(signal));
stopWhenLauncherGoes(stop);

// Tests get their own temp root and config dir (test/setup-config.ts makes one
// per test file); nothing may reach the live daemon's config.
// Dozens of test files run at once: one thread per ImageMagick/OpenMP child
// keeps them from oversubscribing the cores.
const env: NodeJS.ProcessEnv = {
  ...process.env, TMPDIR: runTmp, FORCE_COLOR: "0", NO_COLOR: "1", OMP_NUM_THREADS: "1", MAGICK_THREAD_LIMIT: "1",
};
delete env.EXOCORTEX_CONFIG_DIR;
delete env[IN_SCOPE];
delete env.EXOCORTEX_TEST_CONFIG_READY;

const started = performance.now();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const report = (result: Result) => {
  console.log(`${result.ok ? "✓" : "✗"} ${result.label.padEnd(18)} ${seconds(result.ms).padStart(6)}  ${result.summary}`);
  return result;
};

let picked: Selection | undefined;
if (options.changed) {
  try {
    picked = select(workingChanges(options.base), workingTree());
  } catch (error) {
    picked = { all: error instanceof Error ? error.message : String(error), suites: { shared: [], daemon: [], tui: [] }, typecheck: [...SUITES], why: [] };
  }
  console.log(picked.all ? `changed: running everything: ${picked.all}` : `changed: ${picked.why.join("; ")}`);
}
const skipped = (label: string): Result => ({ label, ok: true, ms: 0, summary: "nothing changed reaches it", details: "" });

const jobs: Promise<Result>[] = [];
if (options.steps.includes("typecheck")) {
  for (const pkg of SUITES) {
    if (picked && !picked.all && !picked.typecheck.includes(pkg)) jobs.push(Promise.resolve(report(skipped(`typecheck ${pkg}`))));
    else jobs.push(typecheck(pkg, env, options.timeoutMs).then(report));
  }
}
for (const name of SUITES) {
  if (!options.steps.includes(name)) continue;
  const files = picked && !picked.all ? picked.suites[name] : undefined;
  if (files?.length === 0) jobs.push(Promise.resolve(report(skipped(`${name} tests`))));
  else jobs.push(suite(name, options, env, runTmp, files).then(report));
}

let results: Result[];
try {
  results = await Promise.all(jobs);
} finally {
  killRestOfScope();
  cleanup();
}

const failed = results.filter(result => !result.ok);
for (const result of failed) {
  console.log(`\n━━ ${result.label}: ${result.summary} ━━\n${result.details}`);
}
console.log(`\n${failed.length ? `✗ check failed: ${failed.map(r => r.label).join(", ")}` : "✓ check passed"} in ${seconds(performance.now() - started)}`);
process.exit(failed.length ? 1 : 0);
