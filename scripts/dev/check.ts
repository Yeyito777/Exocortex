#!/usr/bin/env bun
/**
 * check — typecheck shared, daemon and tui, and run the shared, daemon and
 * TUI test suites, all at once. The pre-merge check: `bun run check` at the repo root.
 *
 * Usage:
 *   bun run check [--jobs N (default 2/3 of the cores)] [--timeout SECONDS] [--update-timings] [STEP...]
 *
 * STEP is any of: typecheck, shared, daemon, tui (default: all four).
 *
 * - Typechecks are incremental (tsconfig `incremental`, build info under
 *   node_modules/.cache/tsc), so an unchanged package checks in a second or two.
 * - Each suite runs as `bun test --parallel`: every test file in a fresh global
 *   (per-file test config dir, see test/setup-config.ts), slowest files first
 *   by test/timings/<suite>.json and this checkout's last measured durations.
 * - All temp files go in one per-run TMPDIR, removed at the end, also on
 *   failure, timeout or Ctrl-C.
 * - A step that outlives --timeout (default 300 s) has its process group
 *   killed; failures list file and test name; exit status 1 on any failure.
 *
 * `--update-timings` rewrites test/timings/*.json (tracked) from this run.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CACHE = join(ROOT, "node_modules/.cache/exocortex-check");
const STEPS = ["typecheck", "shared", "daemon", "tui"] as const;
type StepName = (typeof STEPS)[number];

interface Options { jobs: number; timeoutMs: number; updateTimings: boolean; steps: StepName[] }

/** Both suites and three tsc processes share the machine; ~2/3 of the cores per suite measured fastest. */
function defaultJobs(): number {
  return Math.max(2, Math.round(availableParallelism() * 2 / 3));
}

function parseArgs(argv: string[]): Options {
  const options: Options = { jobs: defaultJobs(), timeoutMs: 300_000, updateTimings: false, steps: [] };
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
  console.error("Usage: bun run check [--jobs N] [--timeout SECONDS] [--update-timings] [typecheck] [shared] [daemon] [tui]");
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

async function suite(name: "shared" | "daemon" | "tui", options: Options, env: NodeJS.ProcessEnv, runTmp: string): Promise<Result> {
  const cwd = join(ROOT, name);
  const tracked = join(ROOT, "test/timings", `${name}.json`);
  const local = join(CACHE, `${name}-timings.json`);
  const junit = join(runTmp, `${name}.junit.xml`);
  const timings = [`--timings=${local}`, ...(existsSync(tracked) ? [`--timings=${tracked}`] : [])];
  const cmd = [process.execPath, "test", `--parallel=${options.jobs}`, ...timings, "--update-timings",
    "--reporter=junit", `--reporter-outfile=${junit}`];
  const result = await run(`${name} tests`, cmd, cwd, env, options.timeoutMs);
  if (options.updateTimings && result.ok && existsSync(local)) writeTrackedTimings(local, tracked, cwd);

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

// ── Main ──────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2));
mkdirSync(CACHE, { recursive: true });
// Short: some tests put unix sockets under TMPDIR (sun_path holds ~104 bytes).
const runTmp = mkdtempSync(join(tmpdir(), "exck-"));
const cleanup = () => rmSync(runTmp, { recursive: true, force: true, maxRetries: 3 });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    console.error(`\ncheck: ${signal}; stopping`);
    for (const child of children) if (child.pid !== undefined) killSession(child.pid);
    cleanup();
    process.exit(130);
  });
}

// Tests get their own temp root and config dir (test/setup-config.ts makes one
// per test file); nothing may reach the live daemon's config.
// Dozens of test files run at once: one thread per ImageMagick/OpenMP child
// keeps them from oversubscribing the cores.
const env: NodeJS.ProcessEnv = {
  ...process.env, TMPDIR: runTmp, FORCE_COLOR: "0", NO_COLOR: "1", OMP_NUM_THREADS: "1", MAGICK_THREAD_LIMIT: "1",
};
delete env.EXOCORTEX_CONFIG_DIR;
delete env.EXOCORTEX_TEST_CONFIG_READY;

const started = performance.now();
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const report = (result: Result) => {
  console.log(`${result.ok ? "✓" : "✗"} ${result.label.padEnd(18)} ${seconds(result.ms).padStart(6)}  ${result.summary}`);
  return result;
};

const jobs: Promise<Result>[] = [];
if (options.steps.includes("typecheck")) {
  for (const pkg of ["shared", "daemon", "tui"]) jobs.push(typecheck(pkg, env, options.timeoutMs).then(report));
}
for (const name of ["shared", "daemon", "tui"] as const) {
  if (options.steps.includes(name)) jobs.push(suite(name, options, env, runTmp).then(report));
}

let results: Result[];
try {
  results = await Promise.all(jobs);
} finally {
  cleanup();
}

const failed = results.filter(result => !result.ok);
for (const result of failed) {
  console.log(`\n━━ ${result.label}: ${result.summary} ━━\n${result.details}`);
}
console.log(`\n${failed.length ? `✗ check failed: ${failed.map(r => r.label).join(", ")}` : "✓ check passed"} in ${seconds(performance.now() - started)}`);
process.exit(failed.length ? 1 : 0);
