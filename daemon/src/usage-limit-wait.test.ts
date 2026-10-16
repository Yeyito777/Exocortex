import { describe, expect, test } from "bun:test";
import { claudeDailyReset, isUsageLimitError, runWithUsageLimitWait } from "./usage-limit-wait";
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
