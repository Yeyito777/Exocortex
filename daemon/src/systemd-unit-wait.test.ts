import { afterEach, describe, expect, test } from "bun:test";
import {
  checkSystemdUnit,
  systemdUnitTargetName,
  systemdUnitWaitInternalsForTest,
  systemdUnitWaitOutput,
  waitForSystemdUnit,
} from "./systemd-unit-wait";
import { COLLECTED_UNIT, RUNNING_UNIT, fakeSystemd } from "./systemd-unit-wait-test-helpers";

function useFake(props: Record<string, string>, platform: NodeJS.Platform = "linux") {
  const fake = fakeSystemd(props);
  systemdUnitWaitInternalsForTest.configure({ runner: fake.run, platform, pollIntervalMs: 5 });
  return fake;
}

afterEach(() => systemdUnitWaitInternalsForTest.reset());

describe("systemd unit waits", () => {
  test("unit: targets are recognised by prefix only", () => {
    expect(systemdUnitTargetName("unit:pm5-batch-x")).toBe("pm5-batch-x");
    expect(systemdUnitTargetName("bash:12")).toBeNull();
  });

  test("returns promptly when a loaded unit stops, with its result and exit status", async () => {
    const fake = useFake(RUNNING_UNIT);
    const waiting = waitForSystemdUnit("job");
    await Bun.sleep(20);
    Object.assign(fake.props, {
      ActiveState: "failed", SubState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: "3",
      InactiveEnterTimestamp: "@1792780453",
    });
    const started = Date.now();
    const completion = await waiting;
    expect(Date.now() - started).toBeLessThan(500);
    expect(completion).toEqual({
      unit: "job.service", activeState: "failed", result: "exit-code", exitCode: 3, endedAt: 1792780453000,
    });
    expect(JSON.parse(systemdUnitWaitOutput("unit:job", completion))).toEqual({
      task_id: "unit:job", status: "completed", unit: "job.service", active_state: "failed",
      result: "exit-code", ended_at: 1792780453000, exit_code: 3,
    });
  });

  test("a killed unit reports its signal by name", async () => {
    useFake({ ...RUNNING_UNIT, ActiveState: "failed", Result: "signal", ExecMainCode: "2", ExecMainStatus: "15" });
    expect(await checkSystemdUnit("job")).toMatchObject({ result: "signal", exitCode: null, signal: "TERM" });
  });

  test("a collected unit's result comes from the journal run it was seen running as", async () => {
    const fake = useFake(RUNNING_UNIT);
    const waiting = waitForSystemdUnit("job");
    await Bun.sleep(20);
    fake.journal = [
      { USER_UNIT: "job.service", USER_INVOCATION_ID: "old", MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "timeout", __REALTIME_TIMESTAMP: "1000000" },
      { USER_UNIT: "job.service", USER_INVOCATION_ID: "inv1", MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", __REALTIME_TIMESTAMP: "2000000" },
      { USER_UNIT: "job.service", USER_INVOCATION_ID: "inv1", MESSAGE_ID: "98e322203f7a4ed290d09fe03c09fe15", EXIT_CODE: "exited", EXIT_STATUS: "2", __REALTIME_TIMESTAMP: "3000000" },
      { USER_UNIT: "job.service", USER_INVOCATION_ID: "inv1", MESSAGE_ID: "d9b373ed55a64feb8242e02dbe79a49c", UNIT_RESULT: "exit-code", __REALTIME_TIMESTAMP: "3000100" },
    ];
    fake.props = { ...COLLECTED_UNIT };
    expect(await waiting).toEqual({ unit: "job.service", activeState: "unloaded", result: "exit-code", exitCode: 2, endedAt: 3000 });
  });

  test("a collected unit that logged no failure succeeded", async () => {
    const fake = useFake(COLLECTED_UNIT);
    fake.journal = [{ USER_UNIT: "job.service", USER_INVOCATION_ID: "inv2", MESSAGE_ID: "39f53479d3a045ac8e11786248231fbf", __REALTIME_TIMESTAMP: "5000000" }];
    expect(await checkSystemdUnit("job")).toEqual({ unit: "job.service", activeState: "unloaded", result: "success", exitCode: 0, endedAt: 5000 });
  });

  test("a running unit checks as still running", async () => {
    useFake(RUNNING_UNIT);
    expect(await checkSystemdUnit("job")).toBeNull();
  });

  test("an unknown unit fails with a clear error", async () => {
    useFake(COLLECTED_UNIT);
    await expect(checkSystemdUnit("nope")).rejects.toThrow("Unit not found: nope");
    await expect(waitForSystemdUnit("nope")).rejects.toThrow("Unit not found: nope");
  });

  test("invalid names are refused before anything runs, and names are passed as one argv element", async () => {
    const fake = useFake(RUNNING_UNIT);
    for (const name of ["job; rm -rf ~", "$(id)", "-H host", "a b", "", "x".repeat(256)]) {
      await expect(checkSystemdUnit(name)).rejects.toThrow(name ? "Invalid systemd unit name" : "needs a unit name");
    }
    expect(fake.calls).toHaveLength(0);
    await checkSystemdUnit("pm5-batch-a_b.c@x\\x2d.service");
    const args = fake.calls[0].args;
    expect(args.slice(-2)).toEqual(["--", "pm5-batch-a_b.c@x\\x2d.service"]);
  });

  test("macOS gets a clear refusal without running anything", async () => {
    const fake = useFake(RUNNING_UNIT, "darwin");
    await expect(waitForSystemdUnit("job")).rejects.toThrow("only exist on Linux; this daemon runs on darwin");
    expect(fake.calls).toHaveLength(0);
  });

  test("abort stops polling", async () => {
    const fake = useFake(RUNNING_UNIT);
    const controller = new AbortController();
    const waiting = waitForSystemdUnit("job", controller.signal);
    await Bun.sleep(15);
    controller.abort();
    await expect(waiting).rejects.toThrow("Aborted");
    const calls = fake.calls.length;
    await Bun.sleep(20);
    expect(fake.calls.length).toBe(calls);
  });

  test("a briefly failing systemctl is retried, a persistently failing one ends the wait", async () => {
    const fake = useFake(RUNNING_UNIT);
    fake.failShow = 2;
    const waiting = waitForSystemdUnit("job");
    await Bun.sleep(30);
    Object.assign(fake.props, { ActiveState: "inactive", SubState: "dead" });
    expect((await waiting).activeState).toBe("inactive");

    fake.props = { ...RUNNING_UNIT };
    fake.failShow = 3;
    await expect(waitForSystemdUnit("job")).rejects.toThrow("Failed to connect to bus");
  });
});

// Opt-in: starts real transient user units. EXOCORTEX_REAL_SYSTEMD_TESTS=1 bun test daemon/src/systemd-unit-wait.test.ts
describe.skipIf(process.platform !== "linux" || process.env.EXOCORTEX_REAL_SYSTEMD_TESTS !== "1")("real systemd user units", () => {
  test("a collected unit's failure and a missing unit", async () => {
    const unit = `exo-chrono-unit-test-${process.pid}-${Date.now()}`;
    const started = Bun.spawnSync(["systemd-run", "--user", `--unit=${unit}`, "--collect", "--quiet", "--", "sh", "-c", "sleep 0.5; exit 3"]);
    expect(started.exitCode).toBe(0);
    systemdUnitWaitInternalsForTest.configure({ pollIntervalMs: 100 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      expect(await waitForSystemdUnit(unit, controller.signal)).toMatchObject({ activeState: "unloaded", result: "exit-code", exitCode: 3 });
    } finally {
      clearTimeout(timeout);
    }
    await expect(checkSystemdUnit(`${unit}-missing`)).rejects.toThrow("Unit not found");
  }, 10_000);
});
