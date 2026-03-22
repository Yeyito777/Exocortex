/**
 * Cron scheduler for exocortexd.
 *
 * Scans <repo>/config/cron/ for executable .sh files, parses
 * cron schedule headers, and runs them on schedule. Each script is
 * a standalone bash file that can use `exo` or any other tool.
 *
 * Script header format (parsed from comments):
 *   # schedule: <cron expression>      (required — standard 5-field cron)
 *   # description: <text>              (optional — for logging/display)
 *   # timeout: <seconds>               (optional — default 300)
 *
 * Scripts without a `# schedule:` line are ignored.
 * Scripts without the executable bit are ignored.
 *
 * The directory is watched for changes — adding, removing, or editing
 * a script hot-reloads the schedule without restarting the daemon.
 */

import { spawn, type ChildProcess } from "child_process";
import {
  readdirSync,
  readFileSync,
  statSync,
  watch,
  existsSync,
  mkdirSync,
  type FSWatcher,
} from "fs";
import { join, basename } from "path";
import { cronDir } from "@exocortex/shared/paths";
import { log } from "./log";

// ── Cron directory ──────────────────────────────────────────────────

const CRON_DIR = cronDir();

// ── Types ───────────────────────────────────────────────────────────

/** @internal Exported for testing only. */
export interface CronField {
  type: "any" | "values";
  values: number[]; // populated when type === "values"
}

/** @internal Exported for testing only. */
export interface ParsedSchedule {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

interface CronJob {
  /** Absolute path to the script. */
  path: string;
  /** Basename of the script (for display). */
  name: string;
  /** Raw schedule string from the header. */
  scheduleRaw: string;
  /** Parsed schedule fields. */
  schedule: ParsedSchedule;
  /** Optional description from the header. */
  description: string;
  /** Timeout in seconds (default 300). */
  timeout: number;
  /** Currently running process, if any (used to prevent overlap). */
  running: ChildProcess | null;
  /** Timestamp of the last run start. */
  lastRunAt: number | null;
  /** Exit code of the last run (null if never run or still running). */
  lastExitCode: number | null;
}

// ── Cron expression parser ──────────────────────────────────────────

/**
 * Parse a single cron field (e.g. "0", "1,15", "1-5", "∗/10").
 * Supports: literal values, comma-separated lists, ranges (1-5),
 * and step values (star/10, 1-30/5).
 *
 * Values outside [min, max] are rejected (returns null).
 * Non-numeric tokens are rejected (returns null).
 *
 * @internal Exported for testing only.
 */
export function parseCronField(field: string, min: number, max: number): CronField | null {
  if (field === "*") return { type: "any", values: [] };

  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const [, range, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) return null;
      let start = min;
      let end = max;

      if (range !== "*") {
        const rangeMatch = range.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          end = parseInt(rangeMatch[2], 10);
        } else {
          start = parseInt(range, 10);
          if (isNaN(start)) return null;
          end = max;
        }
      }

      if (isNaN(start) || isNaN(end)) return null;
      if (start < min || start > max || end < min || end > max) return null;

      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes("-")) {
      const [startStr, endStr] = part.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) return null;
      if (start < min || start > max || end < min || end > max) return null;
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val)) return null;
      if (val < min || val > max) return null;
      values.add(val);
    }
  }

  if (values.size === 0) return null;
  return { type: "values", values: [...values].sort((a, b) => a - b) };
}

/** @internal Exported for testing only. */
export function parseSchedule(expr: string): ParsedSchedule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dayOfMonth = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dayOfWeek = parseCronField(parts[4], 0, 6); // 0 = Sunday

  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null;

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

/** @internal Exported for testing only. */
export function fieldMatches(field: CronField, value: number): boolean {
  if (field.type === "any") return true;
  return field.values.includes(value);
}

/** @internal Exported for testing only. */
export function scheduleMatches(schedule: ParsedSchedule, date: Date): boolean {
  return (
    fieldMatches(schedule.minute, date.getMinutes()) &&
    fieldMatches(schedule.hour, date.getHours()) &&
    fieldMatches(schedule.dayOfMonth, date.getDate()) &&
    fieldMatches(schedule.month, date.getMonth() + 1) &&
    fieldMatches(schedule.dayOfWeek, date.getDay())
  );
}

// ── Script header parser ────────────────────────────────────────────

/** @internal Exported for testing only. */
export interface ScriptHeaders {
  schedule: string | null;
  description: string;
  timeout: number;
}

/** @internal Exported for testing only. */
export function parseHeaders(content: string): ScriptHeaders {
  const headers: ScriptHeaders = {
    schedule: null,
    description: "",
    timeout: 300,
  };

  // Only scan the first 20 lines for headers
  const lines = content.split("\n").slice(0, 20);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;

    const scheduleMatch = trimmed.match(/^#\s*schedule:\s*(.+)$/i);
    if (scheduleMatch) {
      headers.schedule = scheduleMatch[1].trim();
      continue;
    }

    const descMatch = trimmed.match(/^#\s*description:\s*(.+)$/i);
    if (descMatch) {
      headers.description = descMatch[1].trim();
      continue;
    }

    const timeoutMatch = trimmed.match(/^#\s*timeout:\s*(\d+)$/i);
    if (timeoutMatch) {
      headers.timeout = parseInt(timeoutMatch[1], 10);
      continue;
    }
  }

  return headers;
}

// ── Job loading ─────────────────────────────────────────────────────

function loadJob(filePath: string): CronJob | null {
  const name = basename(filePath);

  try {
    const stat = statSync(filePath);

    // Must be a regular file
    if (!stat.isFile()) return null;

    // Must be executable (check user execute bit)
    // On Windows this check is skipped (mode is always 0)
    if (process.platform !== "win32" && !(stat.mode & 0o100)) {
      log("debug", `scheduler: skipping ${name} (not executable)`);
      return null;
    }
  } catch {
    return null;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    log("warn", `scheduler: cannot read ${name}: ${err}`);
    return null;
  }

  const headers = parseHeaders(content);
  if (!headers.schedule) {
    log("debug", `scheduler: skipping ${name} (no schedule header)`);
    return null;
  }

  const schedule = parseSchedule(headers.schedule);
  if (!schedule) {
    log("warn", `scheduler: invalid cron expression in ${name}: "${headers.schedule}"`);
    return null;
  }

  return {
    path: filePath,
    name,
    scheduleRaw: headers.schedule,
    schedule,
    description: headers.description,
    timeout: headers.timeout,
    running: null,
    lastRunAt: null,
    lastExitCode: null,
  };
}

function loadAllJobs(): Map<string, CronJob> {
  const jobs = new Map<string, CronJob>();

  if (!existsSync(CRON_DIR)) {
    mkdirSync(CRON_DIR, { recursive: true });
    log("info", `scheduler: created cron directory: ${CRON_DIR}`);
    return jobs;
  }

  let entries: string[];
  try {
    entries = readdirSync(CRON_DIR);
  } catch (err) {
    log("error", `scheduler: cannot read cron directory: ${err}`);
    return jobs;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".sh")) continue;

    const filePath = join(CRON_DIR, entry);
    const job = loadJob(filePath);
    if (job) {
      jobs.set(job.name, job);
      log("info", `scheduler: loaded job "${job.name}" (${job.scheduleRaw})${job.description ? ` — ${job.description}` : ""}`);
    }
  }

  return jobs;
}

// ── Job execution ───────────────────────────────────────────────────

/** Maximum bytes to accumulate from stdout/stderr per job run. */
const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KB

function isExecutable(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    return stat.isFile() && (process.platform === "win32" || !!(stat.mode & 0o100));
  } catch {
    return false;
  }
}

function runJob(job: CronJob): void {
  if (job.running) {
    log("info", `scheduler: skipping "${job.name}" (still running from previous trigger)`);
    return;
  }

  // Re-check executable bit at run time — fs.watch doesn't fire for chmod
  if (!isExecutable(job.path)) {
    log("info", `scheduler: skipping "${job.name}" (no longer executable)`);
    return;
  }

  log("info", `scheduler: running "${job.name}"${job.description ? ` (${job.description})` : ""}`);
  job.lastRunAt = Date.now();

  // Spawn in a new process group (detached) so we can kill the entire
  // tree on timeout/shutdown — without this, children like `sleep` or
  // `exo` survive after bash is killed and become orphans.
  const child = spawn("bash", [job.path], {
    cwd: process.env.HOME,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  job.running = child;
  const pgid = child.pid!;

  /** Kill the entire process group (negative PID). */
  function killGroup(signal: NodeJS.Signals): void {
    try { process.kill(-pgid, signal); } catch { /* already dead */ }
  }

  let stdout = "";
  let stderr = "";
  let stdoutCapped = false;
  let stderrCapped = false;

  child.stdout.on("data", (data: Buffer) => {
    if (stdoutCapped) return;
    stdout += data.toString();
    if (stdout.length > MAX_OUTPUT_BYTES) {
      stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
      stdoutCapped = true;
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    if (stderrCapped) return;
    stderr += data.toString();
    if (stderr.length > MAX_OUTPUT_BYTES) {
      stderr = stderr.slice(0, MAX_OUTPUT_BYTES);
      stderrCapped = true;
    }
  });

  // Timeout guard
  const timer = setTimeout(() => {
    log("warn", `scheduler: "${job.name}" timed out after ${job.timeout}s — killing`);
    killGroup("SIGTERM");
    // Give it 5s to clean up, then SIGKILL
    setTimeout(() => {
      if (job.running === child) {
        killGroup("SIGKILL");
      }
    }, 5000);
  }, job.timeout * 1000);

  child.on("close", (code) => {
    clearTimeout(timer);
    job.running = null;
    job.lastExitCode = code;

    const duration = Date.now() - (job.lastRunAt ?? Date.now());
    const durationSec = (duration / 1000).toFixed(1);

    if (code === 0) {
      log("info", `scheduler: "${job.name}" completed (${durationSec}s)`);
    } else {
      log("warn", `scheduler: "${job.name}" exited with code ${code} (${durationSec}s)`);
    }

    // Log stdout/stderr if non-empty (truncate to keep log entries manageable)
    const maxLogLen = 2000;
    if (stdout.trim()) {
      const truncated = stdout.length > maxLogLen ? stdout.slice(0, maxLogLen) + "…" : stdout;
      log("info", `scheduler: "${job.name}" stdout: ${truncated.trim()}`);
    }
    if (stderr.trim()) {
      const truncated = stderr.length > maxLogLen ? stderr.slice(0, maxLogLen) + "…" : stderr;
      log("warn", `scheduler: "${job.name}" stderr: ${truncated.trim()}`);
    }
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    job.running = null;
    job.lastExitCode = -1;
    log("error", `scheduler: "${job.name}" failed to start: ${err.message}`);
  });
}

// ── Scheduler ───────────────────────────────────────────────────────

let jobs: Map<string, CronJob> = new Map();
let tickInterval: ReturnType<typeof setInterval> | null = null;
let watcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let lastTickKey = "";

/**
 * Check all jobs against the current time and run any that match.
 * Called once per minute. Uses lastTickKey to avoid double-firing
 * if the interval drifts.
 */
function tick(): void {
  const now = new Date();
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

  // Don't fire twice in the same minute
  if (key === lastTickKey) return;
  lastTickKey = key;

  for (const job of jobs.values()) {
    if (scheduleMatches(job.schedule, now)) {
      runJob(job);
    }
  }
}

/**
 * Reload jobs from disk. Preserves running state for jobs that
 * still exist (by name). New jobs are added, removed jobs are
 * cleaned up (running processes are killed).
 */
function reloadJobs(): void {
  const newJobs = loadAllJobs();

  // Kill running processes for removed jobs (entire process group)
  for (const [name, oldJob] of jobs) {
    if (!newJobs.has(name) && oldJob.running && oldJob.running.pid) {
      log("info", `scheduler: killing removed job "${name}"`);
      try { process.kill(-oldJob.running.pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }

  // Preserve running state for jobs that still exist
  for (const [name, newJob] of newJobs) {
    const oldJob = jobs.get(name);
    if (oldJob?.running) {
      newJob.running = oldJob.running;
      newJob.lastRunAt = oldJob.lastRunAt;
      newJob.lastExitCode = oldJob.lastExitCode;
    }
  }

  jobs = newJobs;
  log("info", `scheduler: reloaded — ${jobs.size} job(s) active`);
}

// ── Public API ──────────────────────────────────────────────────────

/** Start the scheduler. Call once after the daemon server is ready. */
export function startScheduler(): void {
  log("info", `scheduler: starting (cron dir: ${CRON_DIR})`);

  // Initial load
  jobs = loadAllJobs();
  log("info", `scheduler: loaded ${jobs.size} job(s)`);

  // Tick every 15 seconds. The dedup logic (lastTickKey) ensures
  // jobs only fire once per minute, but checking more frequently than
  // 60s means we don't miss the window if startup was slow.
  tickInterval = setInterval(tick, 15_000);

  // Run the first tick immediately (in case we started mid-minute)
  tick();

  // Watch for changes
  if (existsSync(CRON_DIR)) {
    try {
      watcher = watch(CRON_DIR, (eventType, filename) => {
        if (filename && !filename.endsWith(".sh")) return;

        // Debounce reloads — file editors often write multiple events
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          log("info", `scheduler: change detected${filename ? ` (${filename})` : ""}, reloading`);
          reloadJobs();
          reloadTimer = null;
        }, 500);
      });

      log("info", `scheduler: watching ${CRON_DIR} for changes`);
    } catch (err) {
      log("warn", `scheduler: cannot watch cron directory: ${err}`);
    }
  }
}

/** Stop the scheduler. Kill all running jobs and clean up. */
export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }

  // Cancel any pending debounced reload
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  if (watcher) {
    watcher.close();
    watcher = null;
  }

  // Kill any running jobs (kill entire process group to avoid orphans)
  for (const job of jobs.values()) {
    if (job.running && job.running.pid) {
      log("info", `scheduler: killing running job "${job.name}" on shutdown`);
      try { process.kill(-job.running.pid, "SIGTERM"); } catch { /* already dead */ }
    }
  }

  jobs.clear();
  log("info", "scheduler: stopped");
}

/** Get a snapshot of all loaded jobs (for status/debugging). */
export function getJobs(): Array<{
  name: string;
  schedule: string;
  description: string;
  timeout: number;
  running: boolean;
  lastRunAt: number | null;
  lastExitCode: number | null;
}> {
  return [...jobs.values()].map((job) => ({
    name: job.name,
    schedule: job.scheduleRaw,
    description: job.description,
    timeout: job.timeout,
    running: !!job.running,
    lastRunAt: job.lastRunAt,
    lastExitCode: job.lastExitCode,
  }));
}

/** Get the cron directory path (for display/logging). */
export function getCronDir(): string {
  return CRON_DIR;
}
