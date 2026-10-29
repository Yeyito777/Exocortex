import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as conversations from "./conversations";
import { clearInterruptedStreamIds, readInterruptedStreamIds, writeInterruptedStreamIds } from "./restart-recovery";
import {
  buildRequestedRestartNotice,
  finishRequestedRestartBoot,
  noteRequestedRestartTurnEnded,
  prepareRequestedRestartBoot,
  readRequestedRestart,
  requestDaemonRestart,
  requestedRestartPath,
  resetRequestedRestartForTest,
  RESTART_MIN_UPTIME_MS,
  RESTART_STALE_MS,
  RESTART_TURN_END_WAIT_MS,
  runRequestedRestart,
  scheduleRestartExecutor,
  detectRestartTarget,
  type RestartRequestOptions,
} from "./requested-restart";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const PID = 4242;
const ids: string[] = [];

function options(overrides: Partial<RestartRequestOptions> = {}) {
  const schedule = mock((token: string) => `exocortex-requested-restart-${token}`);
  return { schedule, opts: { now: NOW, startedAt: NOW - RESTART_MIN_UPTIME_MS - 1_000, pid: PID, target: "service" as const, schedule, ...overrides } };
}

afterEach(() => {
  resetRequestedRestartForTest();
  clearInterruptedStreamIds();
  for (const id of ids.splice(0)) conversations.remove(id);
});

describe("restart request guards", () => {
  test("refuses during the post-boot cooldown without recording or scheduling anything", () => {
    const { schedule, opts } = options({ startedAt: NOW - 60_000 });
    expect(() => requestDaemonRestart("conv-a", "deploy", opts)).toThrow(/Refusing restart: the daemon started 1m 0s ago/);
    expect(schedule).not.toHaveBeenCalled();
    expect(readRequestedRestart()).toBeNull();
  });

  test("refuses while a restart is already pending, naming the requester", () => {
    const first = options();
    requestDaemonRestart("conv-a", "deploy fix", first.opts);
    const second = options({ now: NOW + 1_000 });
    expect(() => requestDaemonRestart("conv-b", "again", second.opts)).toThrow(/already pending \(scheduled\), requested by conv-a .*deploy fix/);
    expect(second.schedule).not.toHaveBeenCalled();
    expect(readRequestedRestart()?.requestedBy).toBe("conv-a");
  });

  test("a stale request from a dead executor or a previous daemon can be replaced", () => {
    requestDaemonRestart("conv-a", "old", options().opts);
    const later = options({ now: NOW + RESTART_STALE_MS + 1 });
    expect(requestDaemonRestart("conv-b", "new", later.opts).reason).toBe("new");
    expect(readRequestedRestart()?.requestedBy).toBe("conv-b");

    const otherDaemon = options({ now: NOW + RESTART_STALE_MS + 2, pid: PID + 1 });
    expect(requestDaemonRestart("conv-c", "", otherDaemon.opts).target).toBe("service");
  });

  test("refuses when nothing would relaunch the daemon", () => {
    const { schedule, opts } = options({ target: null });
    expect(() => requestDaemonRestart("conv-a", "", opts)).toThrow(/not running under its service manager/);
    expect(schedule).not.toHaveBeenCalled();
  });

  test("records the request durably and normalizes the reason", () => {
    const { schedule, opts } = options();
    const result = requestDaemonRestart("conv-a", "  deploy\n merged   fix ", opts);
    expect(schedule).toHaveBeenCalledWith(result.token);
    expect(readRequestedRestart()).toMatchObject({
      token: result.token, requestedBy: "conv-a", reason: "deploy merged fix", requestedAt: NOW,
      daemonPid: PID, target: "service", state: "scheduled", job: `exocortex-requested-restart-${result.token}`,
    });
  });

  test("a scheduler failure leaves nothing pending", () => {
    const { opts } = options({ schedule: () => { throw new Error("systemd-run failed: no bus"); } });
    expect(() => requestDaemonRestart("conv-a", "", opts)).toThrow("no bus");
    expect(existsSync(requestedRestartPath())).toBe(false);
  });
});

describe("restart target detection", () => {
  test("only the service manager's own main process restarts the service", () => {
    const linux = (mainPid: string) => detectRestartTarget("linux", () => ({ ok: true, output: mainPid }), PID);
    expect(linux(String(PID))).toBe("service");
    // A daemon spawned from the main daemon's shell shares its cgroup but is not its MainPID.
    expect(linux(String(PID + 1))).not.toBe("service");
    const darwin = (output: string) => detectRestartTarget("darwin", () => ({ ok: true, output }), PID);
    expect(darwin(`gui/501/com.exocortex.daemon = {\n\tstate = running\n\tpid = ${PID}\n}`)).toBe("service");
    expect(darwin(`gui/501/com.exocortex.daemon = {\n\tpid = ${PID + 1}\n}`)).not.toBe("service");
  });

  test("on macOS the signed launcher's direct child restarts the service", () => {
    const LAUNCHER = PID - 1;
    const output = `gui/501/com.exocortex.daemon = {\n\tstate = running\n\tpid = ${LAUNCHER}\n}`;
    const darwin = (parent: { pid: number; launcherPid?: string }) =>
      detectRestartTarget("darwin", () => ({ ok: true, output }), PID, parent);
    expect(darwin({ pid: LAUNCHER, launcherPid: String(LAUNCHER) })).toBe("service");
    // A daemon started from the main daemon's tools inherits the variable but not the parent.
    expect(darwin({ pid: PID + 5, launcherPid: String(LAUNCHER) })).not.toBe("service");
    // Without the launcher's marker, being launchd's job's child is not enough.
    expect(darwin({ pid: LAUNCHER })).not.toBe("service");
  });

  test("an EXOCORTEX_SUPERVISOR restarts the daemon it names as its main pid", () => {
    const run = mock((_argv: string[]) => ({ ok: true, output: `${PID}\n` }));
    expect(detectRestartTarget("linux", run, PID, { pid: 1 }, "/opt/keeper-ctl")).toBe("service");
    expect(run.mock.calls[0][0]).toEqual(["/opt/keeper-ctl", "main-pid"]);
    // A daemon started from the kept daemon's shell inherits the variable but is not its main pid.
    expect(detectRestartTarget("linux", () => ({ ok: true, output: String(PID + 1) }), PID, { pid: 1 }, "/opt/keeper-ctl")).not.toBe("service");
    expect(detectRestartTarget("linux", () => ({ ok: false, output: "" }), PID, { pid: 1 }, "/opt/keeper-ctl")).not.toBe("service");
  });
});

describe("after-turn executor scheduling", () => {
  test("Linux starts a transient systemd user unit that runs the executor", () => {
    const run = mock((_argv: string[]) => ({ ok: true, output: "" }));
    const unit = scheduleRestartExecutor("tok1", { platform: "linux", run });
    expect(unit).toBe("exocortex-requested-restart-tok1");
    const argv = run.mock.calls[0][0];
    expect(argv.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--quiet"]);
    expect(argv).toContain("--unit=exocortex-requested-restart-tok1");
    expect(argv.some(arg => arg.startsWith("--working-directory=") && arg.endsWith("/daemon"))).toBe(true);
    expect(argv).toContain(`--setenv=EXOCORTEX_CONFIG_DIR=${process.env.EXOCORTEX_CONFIG_DIR}`);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual([process.execPath, "run", "src/main.ts", "run-requested-restart", "tok1"]);
  });

  test("under an EXOCORTEX_SUPERVISOR the executor runs in its own session", () => {
    const spawnDetached = mock((_program: string[], _cwd: string, _env: Record<string, string>, _log: string) => {});
    const job = scheduleRestartExecutor("tok4", { platform: "linux", supervisor: "/opt/keeper-ctl", spawnDetached, run: () => { throw new Error("no systemd-run"); } });
    expect(job).toBe("session:tok4");
    const [program, cwd, , logPath] = spawnDetached.mock.calls[0];
    expect(program).toEqual([process.execPath, "run", "src/main.ts", "run-requested-restart", "tok4"]);
    expect(cwd.endsWith("/daemon")).toBe(true);
    expect(logPath.endsWith("requested-restart.log")).toBe(true);
  });

  test("Linux reports systemd-run failures", () => {
    expect(() => scheduleRestartExecutor("tok1", { platform: "linux", run: () => ({ ok: false, output: "Failed to connect to bus" }) }))
      .toThrow("systemd-run failed: Failed to connect to bus");
  });

  test("macOS bootstraps a one-shot launchd job outside the daemon's process group", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-restart-launchd-"));
    try {
      const run = mock((_argv: string[]) => ({ ok: true, output: "" }));
      const label = scheduleRestartExecutor("tok2", { platform: "darwin", run, launchdDir: dir });
      expect(label).toBe("com.exocortex.requested-restart");
      const plistPath = join(dir, `${label}.plist`);
      const plist = readFileSync(plistPath, "utf-8");
      expect(plist).toContain("<string>run-requested-restart</string><string>tok2</string>");
      expect(plist).toContain("<key>KeepAlive</key><false/>");
      expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
      expect(run.mock.calls.map(call => call[0].slice(0, 2))).toEqual([["launchctl", "bootout"], ["launchctl", "bootstrap"]]);
      expect(run.mock.calls[1][0][3]).toBe(plistPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("macOS runs the job through the signed launcher when the daemon has one", () => {
    const dir = mkdtempSync(join(tmpdir(), "exo-restart-launchd-"));
    try {
      const launcher = join(dir, "exocortex-daemon");
      writeFileSync(launcher, "");
      const run = mock((_argv: string[]) => ({ ok: true, output: "" }));
      scheduleRestartExecutor("tok5", { platform: "darwin", run, launchdDir: dir, launcher });
      const plist = readFileSync(join(dir, "com.exocortex.requested-restart.plist"), "utf-8");
      expect(plist).toContain(`<key>ProgramArguments</key><array><string>${launcher}</string><string>--exec</string><string>${process.execPath}</string><string>run</string>`);
      // A launcher path that no longer exists falls back to bun itself.
      scheduleRestartExecutor("tok6", { platform: "darwin", run, launchdDir: dir, launcher: join(dir, "gone") });
      expect(readFileSync(join(dir, "com.exocortex.requested-restart.plist"), "utf-8"))
        .toContain(`<key>ProgramArguments</key><array><string>${process.execPath}</string><string>run</string>`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unsupported platforms are refused", () => {
    expect(() => scheduleRestartExecutor("tok3", { platform: "win32", run: () => ({ ok: true, output: "" }) })).toThrow(/not supported on win32/);
  });
});

describe("turn end and executor", () => {
  function executorDeps(livePid: () => number | null = () => PID) {
    let clock = NOW;
    const restart = mock(async (_record: unknown) => {});
    const sleep = mock(async (ms: number) => { clock += ms; });
    return { restart, sleep, deps: { now: () => clock, sleep, livePid, restart } };
  }

  test("waits for the requesting turn to end, then restarts the recorded target", async () => {
    const { token } = requestDaemonRestart("conv-a", "deploy", options().opts);
    const { restart, sleep, deps } = executorDeps();
    let polls = 0;
    sleep.mockImplementation(async () => { if (++polls === 3) noteRequestedRestartTurnEnded("conv-a", false, NOW + 1_500); });
    expect(await runRequestedRestart(token, deps)).toBe("restarted");
    expect(polls).toBe(3);
    expect(restart.mock.calls[0][0]).toMatchObject({ token, target: "service", state: "restarting" });
    expect(readRequestedRestart()).toMatchObject({ state: "restarting", turnEndedAt: NOW + 1_500 });
  });

  test("other conversations' turns do not release the executor", () => {
    requestDaemonRestart("conv-a", "", options().opts);
    noteRequestedRestartTurnEnded("conv-b", false);
    expect(readRequestedRestart()?.turnEndedAt).toBeUndefined();
  });

  test("an aborted requesting turn cancels the restart", async () => {
    const { token } = requestDaemonRestart("conv-a", "", options().opts);
    noteRequestedRestartTurnEnded("conv-a", true);
    expect(readRequestedRestart()).toBeNull();
    const { restart, deps } = executorDeps();
    expect(await runRequestedRestart(token, deps)).toBe("superseded");
    expect(restart).not.toHaveBeenCalled();
  });

  test("does not fire against a daemon that already restarted (no double restart after a crash)", async () => {
    const { token } = requestDaemonRestart("conv-a", "", options().opts);
    noteRequestedRestartTurnEnded("conv-a", false);
    const { restart, deps } = executorDeps(() => PID + 1);
    expect(await runRequestedRestart(token, deps)).toBe("superseded");
    expect(restart).not.toHaveBeenCalled();
    expect(readRequestedRestart()?.state).toBe("scheduled");
  });

  test("a different token is never executed", async () => {
    requestDaemonRestart("conv-a", "", options().opts);
    const { restart, deps } = executorDeps();
    expect(await runRequestedRestart("someone-else", deps)).toBe("superseded");
    expect(restart).not.toHaveBeenCalled();
  });

  test("proceeds after the wait limit if the caller never finishes its turn", async () => {
    const { token } = requestDaemonRestart("conv-a", "", options().opts);
    const { restart, deps } = executorDeps();
    expect(await runRequestedRestart(token, deps)).toBe("restarted");
    expect(restart).toHaveBeenCalledTimes(1);
    const record = readRequestedRestart()!;
    expect(record.turnEndedAt).toBeUndefined();
    expect(record.restartingAt! - NOW).toBeGreaterThanOrEqual(RESTART_TURN_END_WAIT_MS);
  });
});

describe("next boot", () => {
  function conversation() {
    const id = `restart-caller-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    ids.push(id);
    conversations.create(id, "openai", "gpt-6-astra", "caller");
    return id;
  }

  async function restartedRecord(callerId: string, turnEnded: boolean) {
    const { token } = requestDaemonRestart(callerId, "deploy merged fix", options().opts);
    if (turnEnded) noteRequestedRestartTurnEnded(callerId, false);
    await runRequestedRestart(token, { now: () => NOW + RESTART_TURN_END_WAIT_MS, livePid: () => PID, restart: async () => {} });
    return token;
  }

  test("a caller whose turn was still running is not replayed; other interrupted conversations are", async () => {
    const caller = conversation();
    await restartedRecord(caller, false);
    writeInterruptedStreamIds([caller, "other-conv"]);
    const record = prepareRequestedRestartBoot(PID + 1);
    expect(record?.requestedBy).toBe(caller);
    expect(readInterruptedStreamIds()).toEqual(["other-conv"]);
  });

  test("once the requesting turn ended, a later interrupted turn of the caller replays normally", async () => {
    const caller = conversation();
    await restartedRecord(caller, true);
    writeInterruptedStreamIds([caller, "other-conv"]);
    prepareRequestedRestartBoot(PID + 1);
    expect(readInterruptedStreamIds()).toEqual([caller, "other-conv"]);
  });

  test("the record is ignored by the daemon that wrote it", async () => {
    await restartedRecord(conversation(), true);
    expect(prepareRequestedRestartBoot(PID)).toBeNull();
  });

  test("queues one durable notice with the reason and new start time, then settles the record", async () => {
    const caller = conversation();
    const token = await restartedRecord(caller, true);
    const record = prepareRequestedRestartBoot(PID + 1)!;
    const startedAt = NOW + RESTART_TURN_END_WAIT_MS + 5_000;
    finishRequestedRestartBoot(record, undefined, startedAt, PID + 1);
    // A crash before the record was cleared must not notify twice.
    finishRequestedRestartBoot(record, undefined, startedAt, PID + 1);

    const queued = conversations.getQueuedMessages(caller);
    expect(queued).toHaveLength(1);
    expect(queued[0].automation).toEqual({ kind: "daemon_restart", sourceId: token });
    expect(queued[0].text).toContain("The daemon restart you requested finished");
    expect(queued[0].text).toContain("Reason: deploy merged fix");
    expect(queued[0].text).toContain(`Daemon started: ${new Date(startedAt).toISOString()} (pid ${PID + 1})`);
    expect(readRequestedRestart()).toBeNull();
    conversations.removeQueuedMessageById(queued[0].id);
  });

  test("a crash-restart before the executor ran is reported as superseded, not repeated", () => {
    const caller = conversation();
    requestDaemonRestart(caller, "", options().opts);
    const record = prepareRequestedRestartBoot(PID + 1)!;
    const text = buildRequestedRestartNotice(record, NOW, PID + 1);
    expect(text).toContain("restarted for another reason before the restart you requested ran; it was not repeated");
    expect(text).toContain("Reason: (none given)");
    expect(text).toContain("still running at shutdown; it was interrupted and not replayed");
  });
});
