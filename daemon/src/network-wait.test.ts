import { describe, expect, test } from "bun:test";
import { ConnectivityMonitor } from "./connectivity";
import { FakeClock, flush, scriptedProbe } from "./connectivity-test-helpers";
import { runWithNetworkWait, type NetworkWaitHooks } from "./network-wait";
import { RetryableStreamAbortController, StreamPreemptedError } from "./watchdog-retry";

const OUTAGE = Object.assign(new Error("getaddrinfo EAI_AGAIN api.anthropic.com"), { code: "EAI_AGAIN" });

function setup(reachable: boolean) {
  const clock = new FakeClock();
  const probe = scriptedProbe(reachable);
  const monitor = new ConnectivityMonitor({ probe, clock });
  const controller = new RetryableStreamAbortController();
  const log: string[] = [];
  const hooks: NetworkWaitHooks = {
    onWaitStart: () => { log.push("wait-start"); },
    onWaitEnd: () => { log.push("wait-end"); },
  };
  return { clock, probe, monitor, controller, log, hooks };
}

/** An operation that fails with each scripted outcome in turn, then succeeds. */
function scriptedOperation(failures: unknown[], result = "done") {
  const op = Object.assign(async () => {
    op.calls += 1;
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return result;
  }, { calls: 0 });
  return op;
}

describe("runWithNetworkWait", () => {
  test("waits out an outage, then retries once the probe sees the network", async () => {
    const { clock, probe, monitor, controller, log, hooks } = setup(false);
    const op = scriptedOperation([OUTAGE]);
    let settled: string | undefined;
    const run = runWithNetworkWait(controller, monitor, op, hooks).then(value => { settled = value; });
    await flush();
    expect(op.calls).toBe(1);
    expect(log).toEqual(["wait-start"]);
    expect(monitor.isOnline()).toBe(false);

    // Still down: probes at +3s, +6s; no request is attempted meanwhile.
    await clock.advance(3_000);
    await clock.advance(6_000);
    expect(op.calls).toBe(1);
    expect(settled).toBeUndefined();

    probe.reachable = true;
    await clock.advance(12_000);
    await run;
    expect(settled).toBe("done");
    expect(op.calls).toBe(2);
    expect(log).toEqual(["wait-start", "wait-end"]);
  });

  test("errors that are not about the network surface immediately", async () => {
    const { monitor, controller, log, hooks, probe } = setup(true);
    const apiError = new Error("Claude Code: API Error: 529 Overloaded");
    const op = scriptedOperation([apiError]);
    await expect(runWithNetworkWait(controller, monitor, op, hooks)).rejects.toBe(apiError);
    expect(op.calls).toBe(1);
    expect(probe.calls).toBe(0);
    expect(log).toEqual([]);
  });

  test("network errors while the network is reachable retry a few times, then surface", async () => {
    const { monitor, controller, hooks } = setup(true);
    const op = scriptedOperation([OUTAGE, OUTAGE, OUTAGE, OUTAGE, OUTAGE]);
    const delays: number[] = [];
    await expect(runWithNetworkWait(controller, monitor, op, hooks, {
      maxOnlineRetries: 3,
      onlineRetryDelayMs: (retry) => { delays.push(retry); return 0; },
    })).rejects.toBe(OUTAGE);
    expect(op.calls).toBe(4);
    expect(delays).toEqual([1, 2, 3]);
    expect(monitor.isOnline()).toBe(true);
  });

  test("a dropped connection while the network is reachable is an ordinary error", async () => {
    const { monitor, controller, hooks } = setup(true);
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const op = scriptedOperation([reset]);
    await expect(runWithNetworkWait(controller, monitor, op, hooks, { onlineRetryDelayMs: () => 0 })).rejects.toBe(reset);
    expect(op.calls).toBe(1);
  });

  test("a dropped connection during an outage waits like any network failure", async () => {
    const { clock, probe, monitor, controller, hooks } = setup(false);
    const op = scriptedOperation([Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })]);
    const run = runWithNetworkWait(controller, monitor, op, hooks);
    await flush();
    probe.reachable = true;
    await clock.advance(3_000);
    expect(await run).toBe("done");
  });

  test("a known outage holds new requests before they are sent", async () => {
    const { clock, probe, monitor, controller, log, hooks } = setup(false);
    await monitor.check();
    const op = scriptedOperation([]);
    const run = runWithNetworkWait(controller, monitor, op, hooks);
    await flush();
    expect(op.calls).toBe(0);
    expect(log).toEqual(["wait-start"]);
    probe.reachable = true;
    await clock.advance(3_000);
    expect(await run).toBe("done");
    expect(op.calls).toBe(1);
    expect(log).toEqual(["wait-start", "wait-end"]);
  });

  test("Stop during the wait cancels it without another attempt", async () => {
    const { monitor, controller, log, hooks } = setup(false);
    const op = scriptedOperation([OUTAGE]);
    const run = runWithNetworkWait(controller, monitor, op, hooks);
    await flush();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(op.calls).toBe(1);
    expect(log).toEqual(["wait-start", "wait-end"]);
  });

  test("a steer during the wait preempts it so the queued input joins the next request", async () => {
    const { monitor, controller, hooks } = setup(false);
    const op = scriptedOperation([OUTAGE]);
    const run = runWithNetworkWait(controller, monitor, op, hooks);
    await flush();
    expect(controller.preemptAttempt()).toBe(true);
    await expect(run).rejects.toBeInstanceOf(StreamPreemptedError);
    expect(controller.signal.aborted).toBe(false);
  });

  test("waiting turns all resume on the same probe", async () => {
    const { clock, probe, monitor, hooks } = setup(false);
    const runs = ["a", "b", "c"].map((name) => {
      const op = scriptedOperation([OUTAGE], name);
      return { op, run: runWithNetworkWait(new RetryableStreamAbortController(), monitor, op, hooks) };
    });
    await flush();
    expect(probe.calls).toBe(1);
    probe.reachable = true;
    await clock.advance(3_000);
    expect(await Promise.all(runs.map(entry => entry.run))).toEqual(["a", "b", "c"]);
    expect(probe.calls).toBe(2);
  });
});
