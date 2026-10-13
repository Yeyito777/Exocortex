import { describe, expect, test } from "bun:test";
import { ConnectivityMonitor, type ConnectivitySnapshot } from "./connectivity";
import { FakeClock, scriptedProbe } from "./connectivity-test-helpers";

describe("ConnectivityMonitor", () => {
  test("starts online and resolves waiters immediately", async () => {
    const monitor = new ConnectivityMonitor({ probe: scriptedProbe(true), clock: new FakeClock() });
    expect(monitor.isOnline()).toBe(true);
    await monitor.waitForOnline();
  });

  test("probes with backoff from 3s doubling to a 30s cap while offline", async () => {
    const clock = new FakeClock();
    const probe = scriptedProbe(false);
    const monitor = new ConnectivityMonitor({ probe, clock });
    const snapshots: ConnectivitySnapshot[] = [];
    monitor.subscribe(snapshot => snapshots.push(snapshot));

    expect(await monitor.check()).toBe(false);
    expect(monitor.isOnline()).toBe(false);
    expect(monitor.snapshot().offlineSince).toBe(clock.time);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const [delay] = clock.pendingDelays();
      delays.push(delay);
      await clock.advance(delay);
    }
    expect(delays).toEqual([3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000]);
    expect(probe.calls).toBe(8);
    expect(snapshots.every(snapshot => !snapshot.online)).toBe(true);
  });

  test("a successful probe brings every waiter back at once", async () => {
    const clock = new FakeClock();
    const probe = scriptedProbe(false);
    const monitor = new ConnectivityMonitor({ probe, clock });
    await monitor.check();
    const resumed: string[] = [];
    const a = monitor.waitForOnline().then(() => resumed.push("a"));
    const b = monitor.waitForOnline().then(() => resumed.push("b"));
    await clock.advance(3_000);
    expect(resumed).toEqual([]);
    probe.reachable = true;
    await clock.advance(6_000);
    await Promise.all([a, b]);
    expect(resumed).toEqual(["a", "b"]);
    expect(monitor.snapshot()).toEqual({ online: true, offlineSince: null, nextProbeAt: null });
    // Online again: no more probing.
    expect(clock.pendingDelays()).toEqual([]);
  });

  test("provider progress counts as being online", async () => {
    const clock = new FakeClock();
    const monitor = new ConnectivityMonitor({ probe: scriptedProbe(false), clock });
    await monitor.check();
    const waiting = monitor.waitForOnline();
    monitor.reportSuccess();
    await waiting;
    expect(monitor.isOnline()).toBe(true);
    expect(clock.pendingDelays()).toEqual([]);
  });

  test("concurrent checks share one probe", async () => {
    let release!: (value: boolean) => void;
    let calls = 0;
    const monitor = new ConnectivityMonitor({
      probe: () => { calls += 1; return new Promise<boolean>(resolve => { release = resolve; }); },
      clock: new FakeClock(),
    });
    const first = monitor.check();
    const second = monitor.check();
    monitor.reportTrouble();
    release(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toBe(1);
  });

  test("an aborted waiter leaves without resolving the others", async () => {
    const clock = new FakeClock();
    const probe = scriptedProbe(false);
    const monitor = new ConnectivityMonitor({ probe, clock });
    await monitor.check();
    const controller = new AbortController();
    const cancelled = monitor.waitForOnline(controller.signal);
    const kept = monitor.waitForOnline();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    probe.reachable = true;
    await clock.advance(3_000);
    await kept;
  });

  test("a throwing probe counts as offline", async () => {
    const monitor = new ConnectivityMonitor({
      probe: async () => { throw new Error("resolver exploded"); },
      clock: new FakeClock(),
    });
    expect(await monitor.check()).toBe(false);
    expect(monitor.isOnline()).toBe(false);
  });
});
