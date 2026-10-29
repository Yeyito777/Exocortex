import { describe, expect, test } from "bun:test";
import { claudeDailyReset, isUsageLimitError, runWithUsageLimitWait, UsageLimitedError } from "./usage-limit-wait";
import { RetryableStreamAbortController } from "./watchdog-retry";

const refused = () => new Error("Claude Code: You've hit your session limit · resets 9:10pm (America/Panama)");
const options = { probeMs: 5, retryFloorMs: 1 };

describe("usage capacity waits", () => {
  test("recognizes Claude session, weekly, Opus and API 429 refusals, not unrelated errors", () => {
    for (const text of ["You've hit your session limit", "You've hit your weekly limit", "You've hit your Opus limit", "API error (429)", "usage_limit_reached"]) {
      expect(isUsageLimitError(new Error(text))).toBe(true);
    }
    expect(isUsageLimitError(new Error("401 login required"))).toBe(false);
    expect(isUsageLimitError(new Error("context window exceeded"))).toBe(false);
  });

  test("parses the reported Panama reset without using the host timezone", () => {
    const now = Date.parse("2026-10-15T23:00:00Z");
    expect(claudeDailyReset(refused().message, now)).toBe(Date.parse("2026-10-16T02:10:00Z"));
    expect(claudeDailyReset("resets 9pm (Not/AZone)", now)).toBeNull();
  });

  test("moves to a second account without resolving the turn or losing committed output", async () => {
    const controller = new RetryableStreamAbortController();
    const messages = ["input"];
    let account = "max2";
    let calls = 0;
    const result = await runWithUsageLimitWait(controller, async () => {
      calls++;
      if (account === "max2") {
        messages.push("committed partial");
        account = "main";
        throw refused();
      }
      expect(messages).toEqual(["input", "committed partial"]);
      return "continued";
    }, () => ({ ready: true, resetAt: null }), { start() {}, end() {} }, options);
    expect(result).toBe("continued");
    expect(calls).toBe(2);
  });

  test("a turn that may not wait fails at once when nothing can take it, after trying the next route once", async () => {
    const fail = { ...options, failInsteadOfWaiting: true };
    const resetAt = Date.now() + 60_000;
    let calls = 0;
    const limited = runWithUsageLimitWait(new RetryableStreamAbortController(), async () => { calls++; return "ran"; },
      () => ({ ready: false, resetAt }), { start() { throw new Error("must not wait"); }, end() {} }, fail);
    const error = await limited.then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(UsageLimitedError);
    expect((error as UsageLimitedError).resetAt).toBe(resetAt);
    expect(calls).toBe(0);
    // Refused mid-turn while another account can still take it: one more try, then the error.
    let tries = 0;
    const second = await runWithUsageLimitWait(new RetryableStreamAbortController(), async () => {
      if (++tries === 1) throw refused();
      return "second account";
    }, () => ({ ready: true, resetAt: null }), { start() {}, end() {} }, fail);
    expect(second).toBe("second account");
    let refusals = 0;
    const always = runWithUsageLimitWait(new RetryableStreamAbortController(), async () => { refusals++; throw refused(); },
      () => ({ ready: true, resetAt: null }), { start() {}, end() {} }, fail);
    await expect(always).rejects.toBeInstanceOf(UsageLimitedError);
    expect(refusals).toBe(2);
  });

  test("all limited waits through reset and completes only at the real end", async () => {
    const controller = new RetryableStreamAbortController();
    const resetAt = Date.now() + 30;
    let calls = 0;
    let waits = 0;
    let completed = false;
    const turn = runWithUsageLimitWait(controller, async () => { calls++; return "done"; },
      () => ({ ready: Date.now() >= resetAt, resetAt }),
      { start() { waits++; expect(completed).toBe(false); }, end() {} }, options)
      .then(result => { completed = true; return result; });
    expect(calls).toBe(0);
    expect(await turn).toBe("done");
    expect(waits).toBeGreaterThan(0);
    expect(calls).toBe(1);
  });

  test("one stretch of waiting is shown once, not restarted on every probe", async () => {
    const ac = new RetryableStreamAbortController();
    let probes = 0;
    const events: string[] = [];
    const result = await runWithUsageLimitWait(ac, async () => "ok", () => {
      probes++;
      return probes <= 4 ? { ready: false, resetAt: Date.now() + 3_600_000 } : { ready: true, resetAt: null };
    }, { start: () => events.push("start"), end: () => events.push("end") }, { probeMs: 5 });
    expect(result).toBe("ok");
    expect(events).toEqual(["start", "end"]);
  });

  test("a wait ended by Stop still ends its shown wait", async () => {
    const ac = new RetryableStreamAbortController();
    const events: string[] = [];
    const pending = runWithUsageLimitWait(ac, async () => "never", () => ({ ready: false, resetAt: null }),
      { start: () => events.push("start"), end: () => events.push("end") }, { probeMs: 5 });
    await new Promise(resolve => setTimeout(resolve, 20));
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(events).toEqual(["start", "end"]);
  });

  test("abort releases a long capacity wait without running the provider", async () => {
    const controller = new RetryableStreamAbortController();
    let ended = false;
    const turn = runWithUsageLimitWait(controller, async () => { throw new Error("must not run"); },
      () => ({ ready: false, resetAt: Date.now() + 86_400_000 }),
      { start() {}, end() { ended = true; } });
    controller.abort();
    await expect(turn).rejects.toMatchObject({ name: "AbortError" });
    expect(ended).toBe(true);
  });

  test("reconstructed wait checks persisted availability before any provider request", async () => {
    const resetAt = Date.now() + 20;
    let calls = 0;
    const availability = () => ({ ready: Date.now() >= resetAt, resetAt });
    const first = new RetryableStreamAbortController();
    const wait = runWithUsageLimitWait(first, async () => { calls++; }, availability, { start() {}, end() {} }, options);
    first.abort("daemon-restart");
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    await runWithUsageLimitWait(new RetryableStreamAbortController(), async () => { calls++; }, availability, { start() {}, end() {} }, options);
    expect(calls).toBe(1);
  });
});
