/**
 * Chrono wait targets for systemd user units (`task_id: "unit:NAME"`).
 *
 * Long jobs that must outlive a turn run as `systemd-run --user` units, which
 * the daemon's task catalog never sees. A wait polls `systemctl --user show`
 * until the unit leaves its running states. Transient units started with
 * `--collect` are unloaded as soon as they stop, taking their result with
 * them, so the final result is read from the user journal instead.
 *
 * Commands run with argv only, never a shell, and the name is validated first.
 */

import { execFile } from "node:child_process";
import { constants } from "node:os";

export const SYSTEMD_UNIT_TARGET_PREFIX = "unit:";

const UNIT_NAME = /^[A-Za-z0-9:_.@\\-]+$/;
const MAX_UNIT_NAME_LENGTH = 255;
/** States in which the unit's work is still going on. */
const RUNNING_STATES = new Set(["active", "activating", "deactivating", "reloading", "refreshing"]);
const SHOW_PROPERTIES = "Id,LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,InactiveEnterTimestamp,InvocationID";
const COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** A failing systemctl (bus hiccup) is retried this many polls before the wait gives up. */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Journal message ids systemd logs when a unit's main process exits and when the unit fails. */
const MAIN_PROCESS_EXITED = "98e322203f7a4ed290d09fe03c09fe15";
const UNIT_FAILED = "d9b373ed55a64feb8242e02dbe79a49c";

export interface SystemdUnitCompletion {
  unit: string;
  /** `inactive`/`failed` from systemd, or `unloaded` once a collected unit is gone. */
  activeState: string;
  result: string;
  exitCode?: number | null;
  signal?: string | null;
  endedAt: number;
}

export interface CommandOutput { stdout: string; stderr: string; code: number }
export type SystemdCommandRunner = (command: "systemctl" | "journalctl", args: string[]) => Promise<CommandOutput>;

function execRunner(command: "systemctl" | "journalctl", args: string[]): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
      if (err && typeof err.code === "string") {
        reject(new Error(err.code === "ENOENT" ? `${command} is not installed; unit waits need systemd.` : `${command} failed: ${err.message}`));
        return;
      }
      resolve({ stdout, stderr, code: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
    });
  });
}

/** Bad input or a unit that does not exist: not worth another poll. */
class UnwaitableUnitError extends Error {}

let runner: SystemdCommandRunner = execRunner;
let platform: NodeJS.Platform = process.platform;
let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

/** The unit name of a `unit:NAME` wait target, or null for an ordinary task id. */
export function systemdUnitTargetName(taskId: string): string | null {
  return taskId.startsWith(SYSTEMD_UNIT_TARGET_PREFIX) ? taskId.slice(SYSTEMD_UNIT_TARGET_PREFIX.length).trim() : null;
}

/** Whether a string could name a unit, e.g. to suggest `unit:` for a task id that was not found. */
export function looksLikeSystemdUnitName(name: string): boolean {
  return name.length <= MAX_UNIT_NAME_LENGTH && UNIT_NAME.test(name) && !name.startsWith("-");
}

function assertWaitableUnit(name: string): void {
  if (platform !== "linux") {
    throw new UnwaitableUnitError(`unit: wait targets need systemd user units, which only exist on Linux; this daemon runs on ${platform}.`);
  }
  if (!name) throw new UnwaitableUnitError("unit: wait target needs a unit name, e.g. unit:pm5-batch-foo.");
  if (!looksLikeSystemdUnitName(name)) {
    throw new UnwaitableUnitError(`Invalid systemd unit name: ${JSON.stringify(name)}. Use letters, digits and : _ . @ \\ - only.`);
  }
}

function parseProperties(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return props;
}

async function showUnit(name: string): Promise<Record<string, string>> {
  const { stdout, stderr, code } = await runner("systemctl", ["--user", "show", `--property=${SHOW_PROPERTIES}`, "--timestamp=unix", "--", name]);
  if (code !== 0) throw new Error(`systemctl --user show ${name} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  return parseProperties(stdout);
}

/** `@1792780453` (from --timestamp=unix) in ms, or undefined when unset. */
function unixTimestampMs(value: string | undefined): number | undefined {
  const match = value?.match(/^@(\d+(?:\.\d+)?)$/);
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function signalName(signal: number): string {
  const name = Object.entries(constants.signals).find(([, value]) => value === signal)?.[0];
  return name ? name.replace(/^SIG/, "") : String(signal);
}

/** CLD_* codes systemd reports as ExecMainCode: 1 exited, 2 killed, 3 dumped core. */
function exitFromMain(code: string | undefined, status: string | undefined): Pick<SystemdUnitCompletion, "exitCode" | "signal"> {
  const value = Number(status);
  if (!status || !Number.isInteger(value)) return {};
  if (code === "1") return { exitCode: value };
  if (code === "2" || code === "3") return { exitCode: null, signal: signalName(value) };
  return {};
}

function loadedCompletion(props: Record<string, string>, name: string): SystemdUnitCompletion {
  return {
    unit: props.Id || name,
    activeState: props.ActiveState,
    result: props.Result || "unknown",
    ...exitFromMain(props.ExecMainCode, props.ExecMainStatus),
    endedAt: unixTimestampMs(props.InactiveEnterTimestamp) ?? Date.now(),
  };
}

/**
 * A collected unit's final result from the journal: its last run, or the run
 * with the invocation id seen while it was loaded. Undefined when the journal
 * has no record of the unit at all.
 */
async function journalCompletion(name: string, invocationId?: string): Promise<SystemdUnitCompletion | undefined> {
  const { stdout, code } = await runner("journalctl", ["--user", "--no-pager", "--output=json", "--lines=200", `--unit=${name}`]);
  if (code !== 0) return undefined;
  const records = stdout.split("\n").flatMap((line) => {
    try {
      const record = JSON.parse(line);
      return record && typeof record === "object" ? [record as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
  if (records.length === 0) return undefined;
  const invocation = invocationId ?? String(records.at(-1)!.USER_INVOCATION_ID ?? records.at(-1)!.INVOCATION_ID ?? "");
  const run = invocation
    ? records.filter(record => (record.USER_INVOCATION_ID ?? record.INVOCATION_ID) === invocation)
    : records;
  const last = run.at(-1) ?? records.at(-1)!;
  const exited = run.findLast(record => record.MESSAGE_ID === MAIN_PROCESS_EXITED);
  const failed = run.findLast(record => record.MESSAGE_ID === UNIT_FAILED);
  const status = typeof exited?.EXIT_STATUS === "string" ? exited.EXIT_STATUS : undefined;
  const exit = exited?.EXIT_CODE === "exited" && status !== undefined && /^\d+$/.test(status) ? { exitCode: Number(status) }
    : exited && status !== undefined ? { exitCode: null, signal: status }
      : failed ? {} : { exitCode: 0 };
  const realtime = Number(last.__REALTIME_TIMESTAMP);
  return {
    unit: typeof last.USER_UNIT === "string" ? last.USER_UNIT : typeof last.UNIT === "string" ? last.UNIT : name,
    activeState: "unloaded",
    // systemd logs only failures; a collected unit that logged none succeeded.
    result: typeof failed?.UNIT_RESULT === "string" ? failed.UNIT_RESULT : "success",
    ...exit,
    endedAt: Number.isFinite(realtime) ? Math.round(realtime / 1000) : Date.now(),
  };
}

type UnitState = { running: true; invocationId?: string } | { running: false; completion: SystemdUnitCompletion };

async function unitState(name: string, invocationId?: string): Promise<UnitState> {
  const props = await showUnit(name);
  if (props.LoadState === "not-found" && !RUNNING_STATES.has(props.ActiveState)) {
    const completion = await journalCompletion(name, invocationId);
    if (!completion) throw new UnwaitableUnitError(`Unit not found: ${name} (no loaded user unit and no user journal record).`);
    return { running: false, completion };
  }
  if (RUNNING_STATES.has(props.ActiveState)) return { running: true, ...(props.InvocationID ? { invocationId: props.InvocationID } : {}) };
  return { running: false, completion: loadedCompletion(props, name) };
}

/** The final state of a unit that already stopped, or null while it runs. Throws when it cannot be waited on. */
export async function checkSystemdUnit(name: string): Promise<SystemdUnitCompletion | null> {
  assertWaitableUnit(name);
  const state = await unitState(name);
  return state.running ? null : state.completion;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    function aborted() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Resolve once the unit is no longer running; reject on abort or when it cannot be watched. */
export async function waitForSystemdUnit(name: string, signal?: AbortSignal): Promise<SystemdUnitCompletion> {
  assertWaitableUnit(name);
  const abortSignal = signal ?? new AbortController().signal;
  let invocationId: string | undefined;
  let failures = 0;
  for (;;) {
    if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const state = await unitState(name, invocationId);
      if (abortSignal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!state.running) return state.completion;
      invocationId = state.invocationId ?? invocationId;
      failures = 0;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      // Not-found and bad input are final; only a failing systemctl is retried.
      if (err instanceof UnwaitableUnitError || ++failures >= MAX_CONSECUTIVE_FAILURES) throw err;
    }
    await delay(pollIntervalMs, abortSignal);
  }
}

/** Chrono wait result for a unit, in the same shape as a task's. */
export function systemdUnitWaitOutput(taskId: string, completion: SystemdUnitCompletion): string {
  return JSON.stringify({
    task_id: taskId,
    status: "completed",
    unit: completion.unit,
    active_state: completion.activeState,
    result: completion.result,
    ended_at: completion.endedAt,
    ...(completion.exitCode !== undefined ? { exit_code: completion.exitCode } : {}),
    ...(completion.signal !== undefined ? { signal: completion.signal } : {}),
  }, null, 2);
}

/** Test-only seams: fake systemctl/journalctl, platform and poll interval. */
export const systemdUnitWaitInternalsForTest = {
  configure(options: { runner?: SystemdCommandRunner; platform?: NodeJS.Platform; pollIntervalMs?: number }) {
    if (options.runner) runner = options.runner;
    if (options.platform) platform = options.platform;
    if (options.pollIntervalMs !== undefined) pollIntervalMs = options.pollIntervalMs;
  },
  reset() {
    runner = execRunner;
    platform = process.platform;
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  },
};
