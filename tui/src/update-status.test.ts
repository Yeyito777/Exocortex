import { describe, expect, test } from "bun:test";
import { UpdateStatusMonitor, type UpdateSnapshot } from "./update-status";
import { DAEMON_STATUS_INTERVAL_MS, UPDATE_CHECK_INTERVAL_MS, type UpdateStatus } from "@exocortex/shared/updatecheck";

const pause = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

describe("update status routing", () => {
  test("daemon polling is ten seconds while GitHub refreshes remain two minutes", () => {
    expect(DAEMON_STATUS_INTERVAL_MS).toBe(10_000);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(120_000);
  });

  test("polls local immediately and periodically without an extra local connection", async () => {
    let activeCalls = 0;
    let localCalls = 0;
    const values: UpdateSnapshot[] = [];
    const monitor = new UpdateStatusMonitor(null, async () => { activeCalls++; return "none"; },
      async () => { localCalls++; return "none"; }, status => values.push(status), 10);
    try {
      expect(activeCalls).toBe(1);
      await pause(35);
      expect(activeCalls).toBeGreaterThan(1);
      expect(localCalls).toBe(0);
      expect(values.at(-1)).toEqual({ local: "none", remote: null });
    } finally { monitor.stop(); }
    const count = activeCalls;
    await pause(20);
    expect(activeCalls).toBe(count);
  });

  test("SSH keeps statuses independent and does not delay Local behind a slow remote", async () => {
    let finish!: (status: UpdateStatus) => void;
    let calls = 0;
    const values: UpdateSnapshot[] = [];
    const monitor = new UpdateStatusMonitor("whale", () => {
      calls++;
      return new Promise(resolve => { finish = resolve; });
    }, async () => "none", status => values.push(status), 10);
    try {
      await pause(35);
      expect(calls).toBe(1); // no overlapping checks
      expect(values.at(-1)).toEqual({ local: "none", remote: "unknown" });
      finish("restart_needed");
      await pause();
      expect(values.at(-1)).toEqual({ local: "none", remote: "restart_needed" });
    } finally { monitor.stop(); }
  });

  test("route changes discard stale results, including same-alias reconnects", async () => {
    const pending: Array<(status: UpdateStatus) => void> = [];
    const values: UpdateSnapshot[] = [];
    const monitor = new UpdateStatusMonitor("first", () => new Promise(resolve => pending.push(resolve)),
      async () => "none", value => values.push(value));
    try {
      await pause();
      monitor.setRoute("second");
      pending[0]("restart_needed");
      pending[1]("update_available");
      await pause();
      expect(values.at(-1)).toEqual({ local: "none", remote: "update_available" });
      monitor.disconnected();
      expect(values.at(-1)?.remote).toBe("unknown");
      monitor.setRoute("second");
      pending[2]("none");
      await pause();
      expect(values.at(-1)?.remote).toBe("none");
      monitor.setRoute(null);
      pending[3]("restart_needed");
      await pause();
      expect(values.at(-1)).toEqual({ local: "restart_needed", remote: null });
    } finally { monitor.stop(); }
  });

  test("failures are Unknown and stopped monitors ignore late results", async () => {
    const values: UpdateSnapshot[] = [];
    const monitor = new UpdateStatusMonitor("offline", async () => { throw new Error("offline"); },
      async () => "restart_needed", value => values.push(value));
    await pause();
    expect(values.at(-1)).toEqual({ local: "restart_needed", remote: "unknown" });
    monitor.stop();
    let finish!: (status: UpdateStatus) => void;
    const stopped = new UpdateStatusMonitor(null, () => new Promise(resolve => { finish = resolve; }),
      async () => "none", value => values.push(value));
    stopped.stop();
    const count = values.length;
    finish("none");
    await pause();
    expect(values).toHaveLength(count);
  });
});
