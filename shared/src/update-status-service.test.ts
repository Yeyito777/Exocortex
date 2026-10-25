import { describe, expect, test } from "bun:test";
import { createUpdateStatusService, UNKNOWN_CHECKS_BEFORE_SHOWN, type UpdateStatus } from "./updatecheck";

/** A service over a scripted checker, checkout fingerprint and clock. */
function harness(results: UpdateStatus[]) {
  const clock = { now: 0, fingerprint: "a" };
  let checks = 0;
  const published: UpdateStatus[] = [];
  const service = createUpdateStatusService("/unused", async () => results[Math.min(checks++, results.length - 1)]!, {
    refreshMs: 120_000,
    retryMs: 10_000,
    fingerprint: async () => clock.fingerprint,
    now: () => clock.now,
  });
  service.subscribe(status => published.push(status));
  return { service, clock, published, checks: () => checks };
}

describe("daemon update status service", () => {
  test("answers from the warm status until the checkout changes or GitHub's answer is due", async () => {
    const { service, clock, published, checks } = harness(["none", "restart_needed", "update_available"]);
    expect(service.peek()).toBeNull();
    expect(await service.current()).toBe("none");
    expect(service.peek()).toBe("none");
    clock.now = 60_000;
    expect(await service.current()).toBe("none");
    expect(checks()).toBe(1);

    clock.fingerprint = "b"; // a pull moved main
    expect(await service.current()).toBe("restart_needed");
    expect(checks()).toBe(2);

    clock.now = 60_000 + 120_000;
    expect(await service.current()).toBe("update_available");
    expect(published).toEqual(["none", "restart_needed", "update_available"]);
  });

  test("publishes changes only, and concurrent callers share one check", async () => {
    const { service, clock, published, checks } = harness(["none"]);
    await Promise.all([service.current(), service.current(), service.current()]);
    expect(checks()).toBe(1);
    clock.fingerprint = "b";
    await service.current();
    expect(checks()).toBe(2);
    expect(published).toEqual(["none"]);
  });

  test("a known status survives Unknown blips; enough of them in a row are shown", async () => {
    const results: UpdateStatus[] = ["none", ...Array<UpdateStatus>(UNKNOWN_CHECKS_BEFORE_SHOWN).fill("unknown")];
    const { service, clock, published } = harness(results);
    await service.current();
    clock.now = 120_000; // the periodic recheck times git out
    expect(await service.current()).toBe("none");
    for (let i = 2; i < UNKNOWN_CHECKS_BEFORE_SHOWN; i++) {
      clock.now += 10_000; // after an Unknown, rechecked at the old polling cadence
      expect(await service.current()).toBe("none");
    }
    clock.now += 10_000;
    expect(await service.current()).toBe("unknown");
    expect(published).toEqual(["none", "unknown"]);
  });

  test("a first Unknown is shown at once and retried at the polling cadence, not every tick", async () => {
    const { service, clock, checks } = harness(["unknown", "none"]);
    expect(await service.current()).toBe("unknown");
    clock.now = 5_000;
    expect(await service.current()).toBe("unknown");
    expect(checks()).toBe(1);
    clock.now = 10_000;
    expect(await service.current()).toBe("none");
  });

  test("start checks at once in the background and stop ends it", async () => {
    const { service, published } = harness(["disabled"]);
    service.start();
    for (let i = 0; i < 50 && published.length === 0; i++) await Bun.sleep(1);
    expect(published).toEqual(["disabled"]);
    service.stop();
  });
});
