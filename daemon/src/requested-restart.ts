/**
 * Model-requested daemon restarts (the `exo` tool's restart action).
 *
 * Restarting from inside a turn must not happen inside that turn: the graceful
 * restart interrupts and replays active streams, so the calling turn would
 * replay, request another restart, and loop. Instead the request is recorded
 * durably and handed to a transient service-manager job outside the daemon's
 * process tree (systemd-run on Linux, a launchd job on macOS, a detached
 * session under an EXOCORTEX_SUPERVISOR such as the OSS Phone's keeper), which survives
 * the daemon's own shutdown. That executor waits for the calling turn to end,
 * then performs the ordinary graceful restart (`exocortexd restart` for the
 * service, or prepare-restart + restart_daemon for an exotest instance).
 *
 * The next daemon settles the record exactly once at boot: the calling turn is
 * kept out of replay if it was still running, and the caller is queued a short
 * notice. Executors re-check the record token and live daemon PID before acting,
 * so a crash-restart can never be followed by a second, stale restart.
 */

import { spawn, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { pidPath, repoRoot, runtimeDir, worktreeName } from "@exocortex/shared/paths";
import * as convStore from "./conversations";
import { log } from "./log";
import { readInterruptedStreamIds, writeInterruptedStreamIds } from "./restart-recovery";

const FILE_VERSION = 1;
/** A fresh daemon refuses restart requests; also bounds any replay loop. */
export const RESTART_MIN_UPTIME_MS = 5 * 60_000;
/** The executor proceeds anyway if the calling turn has not ended by then. */
export const RESTART_TURN_END_WAIT_MS = 10 * 60_000;
/** A same-daemon record older than this has a dead executor and may be replaced. */
export const RESTART_STALE_MS = RESTART_TURN_END_WAIT_MS + 5 * 60_000;
const REASON_MAX_CHARS = 200;
const POLL_MS = 500;
const SERVICE_UNIT = "exocortex-daemon.service";
const DEFAULT_LAUNCHD_LABEL = "com.exocortex.daemon";

export type RestartTarget = "service" | "instance";

export interface RequestedRestartRecord {
  version: typeof FILE_VERSION;
  token: string;
  requestedBy: string;
  reason: string;
  requestedAt: number;
  daemonPid: number;
  daemonStartedAt: number;
  target: RestartTarget;
  /** Service-manager job running the executor (systemd unit or launchd label). */
  job: string;
  state: "scheduled" | "restarting";
  /** Set when the calling turn finished; absent means it was still running. */
  turnEndedAt?: number;
  restartingAt?: number;
}

export function requestedRestartPath(): string {
  return join(runtimeDir(), "requested-restart.json");
}

export function readRequestedRestart(): RequestedRestartRecord | null {
  const path = requestedRestartPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RequestedRestartRecord>;
    if (parsed.version !== FILE_VERSION || typeof parsed.token !== "string" || typeof parsed.requestedBy !== "string"
      || typeof parsed.daemonPid !== "number" || typeof parsed.requestedAt !== "number") {
      throw new Error("unrecognized record");
    }
    return parsed as RequestedRestartRecord;
  } catch (err) {
    log("warn", `requested-restart: ignoring malformed ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function writeRequestedRestart(record: RequestedRestartRecord): void {
  const path = requestedRestartPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmpPath, path);
}

function clearRequestedRestart(token?: string): void {
  if (token !== undefined && readRequestedRestart()?.token !== token) return;
  try { unlinkSync(requestedRestartPath()); } catch { /* absent */ }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Wall-clock start of this daemon process. */
export function daemonStartedAt(): number {
  return Math.round(performance.timeOrigin);
}

export type CommandRunner = (argv: string[]) => { ok: boolean; output: string };

const runCommand: CommandRunner = (argv) => {
  const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf-8", timeout: 15_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? result.error.message : ""}`.trim();
  return { ok: result.status === 0 && !result.error, output };
};

/**
 * How this daemon is relaunched, or null when nothing would bring it back.
 * "service" requires the service manager's own PID record to be this process:
 * cgroup membership and launchd's XPC_SERVICE_NAME are inherited by anything
 * the main daemon spawns, including test daemons started from its shell tools.
 * On macOS that record may instead be the signed launcher (macos/launcher) that
 * spawned this process; it exports its PID, and only its direct child matches.
 */
export function detectRestartTarget(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
  pid = process.pid,
  parent: { pid: number; launcherPid?: string } = { pid: process.ppid, launcherPid: process.env.EXOCORTEX_LAUNCHER_PID },
  supervisor: string | undefined = process.env.EXOCORTEX_SUPERVISOR,
): RestartTarget | null {
  if (supervisor) {
    // Its record of the daemon it keeps, like systemd's MainPID.
    const result = run([supervisor, "main-pid"]);
    if (result.ok && Number.parseInt(result.output, 10) === pid) return "service";
  } else if (platform === "linux") {
    const result = run(["systemctl", "--user", "show", SERVICE_UNIT, "--property=MainPID", "--value"]);
    if (result.ok && Number.parseInt(result.output, 10) === pid) return "service";
  } else if (platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const label = process.env.EXOCORTEX_LAUNCHD_LABEL || DEFAULT_LAUNCHD_LABEL;
    const result = run(["launchctl", "print", `gui/${uid}/${label}`]);
    const match = result.ok ? /^\s*pid = (\d+)\s*$/m.exec(result.output) : null;
    const servicePid = match ? Number.parseInt(match[1], 10) : NaN;
    if (servicePid === pid) return "service";
    if (servicePid === parent.pid && parent.launcherPid === String(parent.pid)) return "service";
  }
  // Linked worktrees run under exotest's supervisor, which relaunches exit 75.
  return worktreeName() ? "instance" : null;
}

/**
 * The executor's re-check that the service manager still runs `daemonPid`.
 * The daemon's parent is looked up, not taken from the executor's own ppid;
 * EXOCORTEX_LAUNCHER_PID is the daemon's, passed down by executorEnvironment
 * (the launcher's --exec mode leaves it unchanged).
 */
export function isServiceDaemon(
  daemonPid: number,
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
  launcherPid: string | undefined = process.env.EXOCORTEX_LAUNCHER_PID,
): boolean {
  const ppid = run(["ps", "-o", "ppid=", "-p", String(daemonPid)]);
  const parent = { pid: ppid.ok ? Number.parseInt(ppid.output, 10) : NaN, launcherPid };
  return detectRestartTarget(platform, run, daemonPid, parent) === "service";
}

// ── Scheduling the out-of-process executor ──────────────────────────

export interface ExecutorScheduleOptions {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  /** EXOCORTEX_SUPERVISOR (tests). */
  supervisor?: string;
  /** Starts the detached executor under a supervisor (tests). */
  spawnDetached?: (program: string[], cwd: string, env: Record<string, string>, logPath: string) => void;
  /** macOS LaunchAgent plist destination directory (tests). */
  launchdDir?: string;
  /** macOS: the signed launcher executable (EXOCORTEX_LAUNCHER, set by macos/launcher). */
  launcher?: string;
}

function executorEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value && (key === "PATH" || key === "HOME" || key.startsWith("EXOCORTEX_"))) env[key] = value;
  }
  return env;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Start a transient service-manager job that runs `main.ts run-requested-restart`.
 * Returns the job name. The job is outside the daemon's cgroup/process group.
 */
export function scheduleRestartExecutor(token: string, options: ExecutorScheduleOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runCommand;
  const cwd = join(repoRoot(), "daemon");
  const program = [process.execPath, "run", "src/main.ts", "run-requested-restart", token];
  const env = executorEnvironment();

  const supervisor = options.supervisor ?? process.env.EXOCORTEX_SUPERVISOR;
  if (supervisor) {
    // Its own session, so the supervisor's restart of the daemon (a signal to
    // the daemon's PID only) leaves it running.
    (options.spawnDetached ?? spawnDetachedExecutor)(program, cwd, env, join(runtimeDir(), "requested-restart.log"));
    return `session:${token}`;
  }

  if (platform === "linux") {
    const unit = `exocortex-requested-restart-${token}`;
    const result = run([
      "systemd-run", "--user", "--collect", "--quiet", `--unit=${unit}`,
      `--description=Exocortex model-requested daemon restart ${token}`,
      `--working-directory=${cwd}`,
      ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
      "--", ...program,
    ]);
    if (!result.ok) throw new Error(`systemd-run failed: ${result.output || "unknown error"}`);
    return unit;
  }

  if (platform === "darwin") {
    // One fixed label: at most one request is pending, and booting out the
    // previous (finished or stale) job keeps launchd from accumulating them.
    const label = "com.exocortex.requested-restart";
    // Through the signed launcher app, so macOS attributes the job's file
    // access (the checkout may be in Desktop or Documents) to the app the user
    // granted, not to bun (README › macOS › Daemon launcher).
    const launcher = options.launcher ?? process.env.EXOCORTEX_LAUNCHER;
    const jobProgram = launcher && existsSync(launcher) ? [launcher, "--exec", ...program] : program;
    const dir = options.launchdDir ?? join(runtimeDir(), "launchd");
    const plistPath = join(dir, `${label}.plist`);
    const logPath = join(runtimeDir(), "requested-restart.log");
    const strings = (values: string[]) => values.map(value => `<string>${escapeXml(value)}</string>`).join("");
    mkdirSync(dir, { recursive: true });
    writeFileSync(plistPath, [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
      `<plist version="1.0"><dict>`,
      `<key>Label</key><string>${escapeXml(label)}</string>`,
      `<key>ProgramArguments</key><array>${strings(jobProgram)}</array>`,
      `<key>WorkingDirectory</key><string>${escapeXml(cwd)}</string>`,
      `<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("")}</dict>`,
      `<key>RunAtLoad</key><true/>`,
      `<key>KeepAlive</key><false/>`,
      `<key>AbandonProcessGroup</key><true/>`,
      `<key>StandardOutPath</key><string>${escapeXml(logPath)}</string>`,
      `<key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>`,
      `</dict></plist>`,
      "",
    ].join("\n"));
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    run(["launchctl", "bootout", `gui/${uid}/${label}`]);
    const result = run(["launchctl", "bootstrap", `gui/${uid}`, plistPath]);
    if (!result.ok) {
      try { unlinkSync(plistPath); } catch { /* best effort */ }
      throw new Error(`launchctl bootstrap failed: ${result.output || "unknown error"}`);
    }
    return label;
  }

  throw new Error(`Model-requested restarts are not supported on ${platform}.`);
}

function spawnDetachedExecutor(program: string[], cwd: string, env: Record<string, string>, logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(program[0], program.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

// ── Request (inside the daemon, from the exo tool) ──────────────────

export interface RestartRequestOptions {
  now?: number;
  startedAt?: number;
  pid?: number;
  target?: RestartTarget | null;
  schedule?: (token: string) => string;
}

export interface RestartRequestResult {
  token: string;
  reason: string;
  job: string;
  target: RestartTarget;
}

/** The token this daemon is waiting to see the calling turn of. In-memory fast path for the turn finalizer. */
let pendingCaller: { convId: string; token: string } | null = null;

export function requestDaemonRestart(convId: string, rawReason: string, options: RestartRequestOptions = {}): RestartRequestResult {
  const now = options.now ?? Date.now();
  const startedAt = options.startedAt ?? daemonStartedAt();
  const pid = options.pid ?? process.pid;
  const reason = rawReason.replace(/\s+/g, " ").trim().slice(0, REASON_MAX_CHARS);

  const uptime = now - startedAt;
  if (uptime < RESTART_MIN_UPTIME_MS) {
    throw new Error(`Refusing restart: the daemon started ${formatDuration(uptime)} ago (${iso(startedAt)}); restarts need at least ${formatDuration(RESTART_MIN_UPTIME_MS)} of uptime. If you just restarted it, it is already running the new code.`);
  }

  const existing = readRequestedRestart();
  if (existing) {
    const stale = existing.daemonPid !== pid || now - existing.requestedAt > RESTART_STALE_MS;
    if (!stale) {
      throw new Error(`Refusing restart: one is already pending (${existing.state}), requested by ${existing.requestedBy} at ${iso(existing.requestedAt)}${existing.reason ? ` (reason: ${existing.reason})` : ""}. It runs once that conversation's turn ends.`);
    }
    log("warn", `requested-restart: replacing stale request ${existing.token} by ${existing.requestedBy} (${existing.state}, requested ${iso(existing.requestedAt)}, daemon pid ${existing.daemonPid})`);
  }

  const target = options.target === undefined ? detectRestartTarget() : options.target;
  if (!target) {
    throw new Error("Refusing restart: this daemon is not running under its service manager or an exotest supervisor, so nothing would start it again.");
  }

  const token = `${now.toString(36)}-${randomUUID().slice(0, 8)}`;
  const record: RequestedRestartRecord = {
    version: FILE_VERSION,
    token,
    requestedBy: convId,
    reason,
    requestedAt: now,
    daemonPid: pid,
    daemonStartedAt: startedAt,
    target,
    job: "",
    state: "scheduled",
  };
  // Durable before the executor can observe it; the executor exits when it finds no matching token.
  writeRequestedRestart(record);
  try {
    record.job = (options.schedule ?? scheduleRestartExecutor)(token);
  } catch (err) {
    clearRequestedRestart(token);
    throw err;
  }
  writeRequestedRestart(record);
  pendingCaller = { convId, token };
  log("info", `requested-restart: ${convId} requested a daemon restart (token=${token}, target=${target}, job=${record.job}, reason=${JSON.stringify(reason)})`);
  return { token, reason, job: record.job, target };
}

/**
 * Turn finalizer hook. A normally finished calling turn releases the executor;
 * a turn the user/watchdog aborted cancels the request instead.
 */
export function noteRequestedRestartTurnEnded(convId: string, aborted: boolean, now = Date.now()): void {
  if (pendingCaller?.convId !== convId) return;
  const { token } = pendingCaller;
  pendingCaller = null;
  const record = readRequestedRestart();
  if (!record || record.token !== token || record.state !== "scheduled") return;
  if (aborted) {
    clearRequestedRestart(token);
    log("info", `requested-restart: cancelled ${token} because the requesting turn of ${convId} was aborted`);
    return;
  }
  writeRequestedRestart({ ...record, turnEndedAt: now });
  log("info", `requested-restart: requesting turn of ${convId} ended; executor ${record.job} may restart now`);
}

// ── Executor (transient service-manager job) ────────────────────────

export interface RestartExecutorDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** PID of the live daemon for this config/worktree, or null. */
  livePid?: () => number | null;
  restart?: (record: RequestedRestartRecord) => Promise<void>;
}

function readLivePid(): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidPath(), "utf-8").trim(), 10);
    if (!Number.isFinite(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function restartTarget(record: RequestedRestartRecord): Promise<void> {
  if (record.target === "service") {
    if (!isServiceDaemon(record.daemonPid)) {
      throw new Error(`daemon pid ${record.daemonPid} is no longer the service's main process`);
    }
    // Exactly the human path: graceful prepare-restart, then the service manager restart.
    const result = spawnSync(join(repoRoot(), "bin", "exocortexd"), ["restart"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`exocortexd restart exited with ${result.status ?? result.signal ?? result.error?.message}`);
    return;
  }
  const { prepareRestartForReplay, requestInstanceRestart } = await import("./control");
  const prepared = await prepareRestartForReplay();
  if (prepared.convIds.length > 0) log("info", `requested-restart: interrupted and scheduled replay: ${prepared.convIds.join(", ")}`);
  await requestInstanceRestart();
}

export type RestartExecutorResult = "restarted" | "superseded";

export async function runRequestedRestart(token: string, deps: RestartExecutorDeps = {}): Promise<RestartExecutorResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const livePid = deps.livePid ?? readLivePid;

  // Valid only while this exact request is pending against the daemon that accepted it.
  const current = (): RequestedRestartRecord | null => {
    const record = readRequestedRestart();
    if (!record || record.token !== token) return null;
    return livePid() === record.daemonPid ? record : null;
  };

  let record = current();
  while (record && record.state === "scheduled" && record.turnEndedAt === undefined) {
    if (now() - record.requestedAt >= RESTART_TURN_END_WAIT_MS) {
      log("warn", `requested-restart: ${record.requestedBy} still running after ${formatDuration(RESTART_TURN_END_WAIT_MS)}; restarting anyway (${token})`);
      break;
    }
    await sleep(POLL_MS);
    record = current();
  }
  if (!record) {
    log("info", `requested-restart: executor ${token} found no matching pending request on the live daemon; not restarting`);
    return "superseded";
  }

  record = { ...record, state: "restarting", restartingAt: now() };
  writeRequestedRestart(record);
  log("info", `requested-restart: restarting daemon pid ${record.daemonPid} for ${record.requestedBy} (token=${token}, target=${record.target}, reason=${JSON.stringify(record.reason)})`);
  if (!current()) {
    // The daemon went away meanwhile and its successor may already have settled
    // this token; do not leave a resurrected record behind for the next boot.
    clearRequestedRestart(token);
    return "superseded";
  }
  await (deps.restart ?? restartTarget)(record);
  return "restarted";
}

// ── Boot (next daemon) ──────────────────────────────────────────────

/**
 * Run before interrupted-stream recovery: keeps a still-running calling turn
 * out of replay. Returns the record to finish after recovery, if any.
 */
export function prepareRequestedRestartBoot(pid = process.pid): RequestedRestartRecord | null {
  const record = readRequestedRestart();
  if (!record || record.daemonPid === pid) return null;
  if (record.turnEndedAt === undefined) {
    try {
      const ids = readInterruptedStreamIds();
      if (ids.includes(record.requestedBy)) {
        writeInterruptedStreamIds(ids.filter(id => id !== record.requestedBy));
        log("info", `requested-restart: not replaying ${record.requestedBy}; its turn requested the restart`);
      }
    } catch (err) {
      log("warn", `requested-restart: could not filter interrupted streams: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return record;
}

export function buildRequestedRestartNotice(record: RequestedRestartRecord, startedAt: number, pid: number): string {
  const finished = record.state === "restarting";
  return [
    finished
      ? `[notification] The daemon restart you requested finished: ${record.token}`
      : `[notification] The daemon restarted for another reason before the restart you requested ran; it was not repeated: ${record.token}`,
    `Reason: ${record.reason || "(none given)"}`,
    `Requested: ${iso(record.requestedAt)}`,
    `Daemon started: ${iso(startedAt)} (pid ${pid})`,
    ...(record.turnEndedAt === undefined ? ["Your requesting turn was still running at shutdown; it was interrupted and not replayed."] : []),
  ].join("\n");
}

export interface RequestedRestartNoticeSink {
  hasConversation(convId: string): boolean;
  /** Durably queue the notice; must be idempotent per token. */
  queue(convId: string, text: string, token: string): void;
}

/** Durable daemon-owned queue, deduplicated by token so a crash before settling cannot double-notify. */
const conversationNoticeSink: RequestedRestartNoticeSink = {
  hasConversation: (convId) => convStore.hasConversation(convId),
  queue: (convId, text, token) => {
    const automation = { kind: "daemon_restart" as const, sourceId: token };
    const alreadyDurable = convStore.hasMessageMetadata(convId, {
      "automation.kind": automation.kind, "automation.sourceId": automation.sourceId,
    }) || convStore.getQueuedMessages(convId).some(message => (
      message.automation?.kind === automation.kind && message.automation.sourceId === automation.sourceId
    ));
    if (alreadyDurable) return;
    const depth = convStore.getPolicyMetadata(convId)?.subagentMaxDepth ?? null;
    convStore.pushQueuedMessage(convId, text, "next-turn", undefined, depth, undefined, undefined, undefined, automation);
  },
};

/** Run after recovery has started replays: queue the caller's notice and settle the record once. */
export function finishRequestedRestartBoot(
  record: RequestedRestartRecord,
  sink: RequestedRestartNoticeSink = conversationNoticeSink,
  startedAt = daemonStartedAt(),
  pid = process.pid,
): void {
  if (sink.hasConversation(record.requestedBy)) {
    sink.queue(record.requestedBy, buildRequestedRestartNotice(record, startedAt, pid), record.token);
  } else {
    log("warn", `requested-restart: requesting conversation ${record.requestedBy} no longer exists; dropping notice`);
  }
  clearRequestedRestart(record.token);
  log("info", `requested-restart: settled ${record.token} for ${record.requestedBy} (${record.state === "restarting" ? "completed" : "superseded by an earlier restart"})`);
}

/** Test-only reset of in-memory state. */
export function resetRequestedRestartForTest(): void {
  pendingCaller = null;
  clearRequestedRestart();
}
