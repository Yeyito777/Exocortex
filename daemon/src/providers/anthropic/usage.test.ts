import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import {
  aggregateUsage,
  applyUsageHeaders,
  CLAUDE_ACCOUNT_HEADER,
  CLAUDE_RATE_LIMIT_HEADER,
  clearUsage,
  getAccountLimitedUntil,
  getAccountUsage,
  getAccountUsageUpdatedAt,
  applyPlanRateLimits,
  CLAUDE_FABLE_TURN_HEADER,
  fableFromPlanRateLimits,
  isFableScopedLimit,
  mergeUsage,
  noteAccountFableRefusal,
  usageFromPlanRateLimits,
  usageFromRateLimitInfo,
} from "./usage";

describe("usageFromPlanRateLimits", () => {
  test("reads the 0-100 utilization and ISO reset times of Claude Code's /usage data", () => {
    expect(usageFromPlanRateLimits({
      five_hour: { utilization: 1, resets_at: "2026-10-10T06:30:00.001703+00:00" },
      seven_day: { utilization: 48, resets_at: "2026-10-10T08:00:00.001754+00:00" },
      seven_day_opus: null,
    })).toEqual({
      // On the whole second, as rate_limit_events give it.
      fiveHour: { utilization: 1, resetsAt: Date.parse("2026-10-10T06:30:00Z") },
      sevenDay: { utilization: 48, resetsAt: Date.parse("2026-10-10T08:00:00Z") },
    });
    expect(usageFromPlanRateLimits({
      seven_day: { utilization: 95, resets_at: new Date(1_793_433_599_554).toISOString() },
    })?.sevenDay?.resetsAt).toBe(1_793_433_600_000);
  });

  test("keeps a window it was not told about and ignores answers without windows", () => {
    const previous = {
      fiveHour: { utilization: 20, resetsAt: 1_000 },
      sevenDay: { utilization: 40, resetsAt: 2_000 },
    };
    expect(usageFromPlanRateLimits({ five_hour: { utilization: 25, resets_at: null }, seven_day: null }, previous)).toEqual({
      fiveHour: { utilization: 25, resetsAt: null },
      sevenDay: previous.sevenDay,
    });
    expect(usageFromPlanRateLimits({ five_hour: null, seven_day: null }, previous)).toBeNull();
    expect(usageFromPlanRateLimits(null, previous)).toBeNull();
  });

  test("a report with the weekly window and no 5-hour one means no 5-hour limit, null or absent", () => {
    const previous = {
      fiveHour: { utilization: 20, resetsAt: 1_000 },
      sevenDay: { utilization: 40, resetsAt: 2_000 },
    };
    const cleared = { fiveHour: null, sevenDay: { utilization: 45, resetsAt: null }, noFiveHourLimit: true };
    // What Claude Code answers for a verified account (read from main, Nov 1 2026).
    expect(usageFromPlanRateLimits({ five_hour: null, seven_day: { utilization: 45, resets_at: null } }, previous)).toEqual(cleared);
    expect(usageFromPlanRateLimits({ seven_day: { utilization: 45, resets_at: null } }, previous)).toEqual(cleared);
  });

  test("a 5-hour window without a figure says nothing: the last value stays, and so does no limit", () => {
    const blank = { five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 45, resets_at: null } };
    const sevenDay = { utilization: 45, resetsAt: null };
    const fiveHour = { utilization: 20, resetsAt: 1_000 };
    expect(usageFromPlanRateLimits(blank, { fiveHour, sevenDay: null })).toEqual({ fiveHour, sevenDay });
    expect(usageFromPlanRateLimits(blank, { fiveHour: null, sevenDay: null, noFiveHourLimit: true })).toEqual({ fiveHour: null, sevenDay, noFiveHourLimit: true });
  });

  test("the limit coming back ends no limit", () => {
    const usage = usageFromPlanRateLimits(
      { five_hour: { utilization: 3, resets_at: null }, seven_day: { utilization: 45, resets_at: null } },
      { fiveHour: null, sevenDay: null, noFiveHourLimit: true },
    );
    expect(usage).toEqual({ fiveHour: { utilization: 3, resetsAt: null }, sevenDay: { utilization: 45, resetsAt: null } });
  });
});

describe("usageFromRateLimitInfo", () => {
  test("reads the 0-1 utilization and epoch-second reset times of rate_limit_events", () => {
    expect(usageFromRateLimitInfo({
      unifiedWindows: {
        five_hour: { utilization: 0.15, resetsAt: 1_791_620_000 },
        seven_day: { utilization: 0.48, resetsAt: 1_791_625_000 },
      },
    })).toEqual({
      fiveHour: { utilization: 15, resetsAt: 1_791_620_000_000 },
      sevenDay: { utilization: 48, resetsAt: 1_791_625_000_000 },
    });
  });
});

describe("usageFromRateLimitInfo on the 5-hour limit", () => {
  const sevenDay = { utilization: 0.11, resetsAt: 1_794_038_400 };
  const weekly = { utilization: 11, resetsAt: 1_794_038_400_000 };

  test("an event that leaves the window out keeps what is known: a window, or no limit", () => {
    const fiveHour = { utilization: 20, resetsAt: 1_000 };
    // Recorded from main, Nov 1 2026: a verified account's events carry only seven_day.
    const info = { status: "allowed", rateLimitType: "seven_day", unifiedWindows: { seven_day: sevenDay } };
    expect(usageFromRateLimitInfo(info, { fiveHour, sevenDay: null })).toEqual({ fiveHour, sevenDay: weekly });
    expect(usageFromRateLimitInfo(info, { fiveHour: null, sevenDay: null, noFiveHourLimit: true })).toEqual({ fiveHour: null, sevenDay: weekly, noFiveHourLimit: true });
  });

  test("an event on an account never reported is unknown, not no limit", () => {
    expect(usageFromRateLimitInfo({ unifiedWindows: { seven_day: sevenDay } })).toEqual({ fiveHour: null, sevenDay: weekly });
  });

  test("a window with no reset time does not bring a cleared limit back; a running one does", () => {
    const cleared = { fiveHour: null, sevenDay: weekly, noFiveHourLimit: true };
    const idle = { unifiedWindows: { five_hour: { utilization: 0 }, seven_day: sevenDay } };
    expect(usageFromRateLimitInfo(idle, cleared)).toEqual(cleared);
    expect(usageFromRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 0 } } }, cleared)).toBeNull();
    expect(usageFromRateLimitInfo({ unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1_793_579_400 }, seven_day: sevenDay } }, cleared)).toEqual({
      fiveHour: { utilization: 2, resetsAt: 1_793_579_400_000 },
      sevenDay: weekly,
    });
  });
});

describe("an account losing the 5-hour limit", () => {
  const ACCOUNT = "test-verified";
  const FULL = { seven_day: { utilization: 11, resets_at: new Date(1_900_000_000_000).toISOString() } };
  const event = (windows: Record<string, unknown>) => new Headers({
    [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({ status: "allowed", unifiedWindows: windows }),
    [CLAUDE_ACCOUNT_HEADER]: ACCOUNT,
  });
  const seed = (fiveHour: { utilization: number; resetsAt: number | null }, now: number) =>
    applyPlanRateLimits(ACCOUNT, { five_hour: { utilization: fiveHour.utilization, resets_at: fiveHour.resetsAt ? new Date(fiveHour.resetsAt).toISOString() : null }, ...FULL }, now);

  test("the stored value (main's stale 0% with no reset) goes on the next report, also on disk", async () => {
    mkdirSync(runtimeDir(), { recursive: true });
    try {
      seed({ utilization: 0, resetsAt: null }, 1_000);
      expect(getAccountUsage(ACCOUNT)?.fiveHour).toEqual({ utilization: 0, resetsAt: null });
      applyPlanRateLimits(ACCOUNT, { five_hour: null, ...FULL }, 2_000);
      expect(getAccountUsage(ACCOUNT)).toEqual({ fiveHour: null, sevenDay: { utilization: 11, resetsAt: 1_900_000_000_000 }, noFiveHourLimit: true });
      const onDisk = JSON.parse(readFileSync(join(runtimeDir(), "usage-anthropic.json"), "utf-8"));
      expect(onDisk.accounts[ACCOUNT].usage).toEqual(getAccountUsage(ACCOUNT));
      // A restart reads it back: the row does not flash while the first report is out.
      const restartedPath = "./usage?restarted";
      const restarted = await import(restartedPath) as typeof import("./usage");
      expect(restarted.getAccountUsage(ACCOUNT)).toEqual(getAccountUsage(ACCOUNT));
    } finally {
      clearUsage(ACCOUNT);
    }
  });

  test("a window in progress goes too, and a limit on it no longer holds the account", () => {
    const now = 1_000_000;
    try {
      seed({ utilization: 100, resetsAt: now + 3_600_000 }, now);
      applyUsageHeaders(new Headers({
        [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({ status: "rejected", resetsAt: Math.floor((now + 3_600_000) / 1000) }),
        [CLAUDE_ACCOUNT_HEADER]: ACCOUNT,
      }), now);
      expect(getAccountLimitedUntil(ACCOUNT, now)).not.toBeNull();
      applyPlanRateLimits(ACCOUNT, { five_hour: null, ...FULL }, now + 1);
      expect(getAccountUsage(ACCOUNT)?.fiveHour).toBeNull();
      expect(getAccountLimitedUntil(ACCOUNT, now + 1)).toBeNull();
    } finally {
      clearUsage(ACCOUNT);
    }
  });

  test("events do not clear a window, and only a poll does: leaving it out does not put the poll off", () => {
    const now = 1_000_000;
    const running = { utilization: 20, resetsAt: 1_900_000_000_000 };
    try {
      seed(running, now);
      expect(getAccountUsageUpdatedAt(ACCOUNT)).toBe(now);
      applyUsageHeaders(event({ seven_day: { utilization: 0.12, resetsAt: 1_900_000_000 } }), now + 30_000);
      expect(getAccountUsage(ACCOUNT)?.fiveHour).toEqual(running);
      expect(getAccountUsage(ACCOUNT)?.sevenDay?.utilization).toBe(12);
      expect(getAccountUsageUpdatedAt(ACCOUNT)).toBe(now);

      // An event with the window is as fresh as ever.
      applyUsageHeaders(event({ five_hour: { utilization: 0.21, resetsAt: 1_900_000_000 }, seven_day: { utilization: 0.12, resetsAt: 1_900_000_000 } }), now + 40_000);
      expect(getAccountUsageUpdatedAt(ACCOUNT)).toBe(now + 40_000);

      // Once the poll has cleared it, events on the account count as reports again.
      applyPlanRateLimits(ACCOUNT, { five_hour: null, ...FULL }, now + 50_000);
      applyUsageHeaders(event({ seven_day: { utilization: 0.12, resetsAt: 1_900_000_000 } }), now + 60_000);
      expect(getAccountUsage(ACCOUNT)?.noFiveHourLimit).toBe(true);
      expect(getAccountUsage(ACCOUNT)?.fiveHour).toBeNull();
      expect(getAccountUsageUpdatedAt(ACCOUNT)).toBe(now + 60_000);
    } finally {
      clearUsage(ACCOUNT);
    }
  });
});

describe("aggregateUsage", () => {
  const NOW_NA = 1_791_000_000_000;
  const H_NA = 3_600_000;
  const limited = (utilization: number, reset: number) => ({ fiveHour: { utilization, resetsAt: NOW_NA + reset * H_NA }, sevenDay: { utilization: 20, resetsAt: NOW_NA + 90 * H_NA } });
  const verified = (utilization: number) => ({ fiveHour: null, sevenDay: { utilization, resetsAt: NOW_NA + 120 * H_NA }, noFiveHourLimit: true });

  test("1 of 2 without the 5-hour limit: that bar counts only the other, with only its reset", () => {
    const combined = aggregateUsage([verified(11), limited(1, 4)], NOW_NA)!;
    expect(combined.capacity).toBe(200);
    expect(combined.fiveHourCapacity).toBe(100);
    expect(combined.fiveHour).toEqual({ utilization: 1, resetsAt: NOW_NA + 4 * H_NA, resets: [NOW_NA + 4 * H_NA] });
    // Weekly never changes.
    expect(combined.sevenDay).toEqual({ utilization: 31, resetsAt: NOW_NA + 90 * H_NA, resets: [NOW_NA + 90 * H_NA, NOW_NA + 120 * H_NA] });
  });

  test("2 of 2 without it: no window and no capacity left; an older client still shows not applicable", () => {
    const combined = aggregateUsage([verified(11), verified(28)], NOW_NA)!;
    expect(combined.fiveHour).toBeNull();
    expect(combined.fiveHourCapacity).toBe(0);
    expect(combined.capacity).toBe(200);
    expect(combined.sevenDay?.utilization).toBe(39);
  });

  test("0 of 2: exactly the shape from before", () => {
    const combined = aggregateUsage([limited(1, 4), limited(2, 3)], NOW_NA)!;
    expect(combined).toEqual({
      fiveHour: { utilization: 3, resetsAt: NOW_NA + 3 * H_NA, resets: [NOW_NA + 3 * H_NA, NOW_NA + 4 * H_NA] },
      sevenDay: { utilization: 40, resetsAt: NOW_NA + 90 * H_NA, resets: [NOW_NA + 90 * H_NA, NOW_NA + 90 * H_NA] },
      capacity: 200,
    });
    expect("fiveHourCapacity" in combined).toBe(false);
  });

  test("an account not reported yet stays counted", () => {
    expect(aggregateUsage([limited(1, 4), null], NOW_NA)).not.toHaveProperty("fiveHourCapacity");
    // A partial event, not a report: the weekly window alone is not no limit.
    expect(aggregateUsage([limited(1, 4), { fiveHour: null, sevenDay: { utilization: 5, resetsAt: null } }], NOW_NA)).not.toHaveProperty("fiveHourCapacity");
    const oneKnown = aggregateUsage([verified(11), null], NOW_NA)!;
    expect(oneKnown.fiveHour).toBeNull();
    expect(oneKnown.fiveHourCapacity).toBe(100);
    expect(oneKnown.capacity).toBe(200);
  });

  test("shares generalize: 1 of 3 leaves two accounts' capacity", () => {
    const combined = aggregateUsage([verified(11), limited(1, 4), limited(2, 3)], NOW_NA)!;
    expect(combined.capacity).toBe(300);
    expect(combined.fiveHourCapacity).toBe(200);
    expect(combined.fiveHour?.utilization).toBe(3);
  });

  test("one verified account keeps the plain single-account shape", () => {
    const one = verified(11);
    expect(aggregateUsage([one], NOW_NA)).toBe(one);
  });

  const NOW = 1_800_000_000_000;
  const H = 3_600_000;

  test("one account keeps its own usage", () => {
    const one = { fiveHour: { utilization: 30, resetsAt: NOW + H }, sevenDay: { utilization: 50, resetsAt: NOW + 48 * H } };
    expect(aggregateUsage([one], NOW)).toBe(one);
  });

  test("sums the accounts on a scale of 100 per account, with every reset time soonest first", () => {
    const combined = aggregateUsage([
      { fiveHour: { utilization: 30, resetsAt: NOW + 3 * H }, sevenDay: { utilization: 50, resetsAt: NOW + 120 * H } },
      { fiveHour: { utilization: 80, resetsAt: NOW + H }, sevenDay: { utilization: 20.5, resetsAt: NOW + 72 * H } },
    ], NOW);
    expect(combined).toEqual({
      fiveHour: { utilization: 110, resetsAt: NOW + H, resets: [NOW + H, NOW + 3 * H] },
      sevenDay: { utilization: 70.5, resetsAt: NOW + 72 * H, resets: [NOW + 72 * H, NOW + 120 * H] },
      capacity: 200,
    });
  });

  test("a window past its reset adds nothing; an unknown account still adds capacity", () => {
    const combined = aggregateUsage([
      { fiveHour: { utilization: 100, resetsAt: NOW - 1 }, sevenDay: { utilization: 40, resetsAt: NOW + 10 * H } },
      null,
      { fiveHour: { utilization: 10, resetsAt: null }, sevenDay: null },
    ], NOW);
    expect(combined?.capacity).toBe(300);
    expect(combined?.fiveHour).toEqual({ utilization: 10, resetsAt: null, resets: [] });
    expect(combined?.sevenDay).toEqual({ utilization: 40, resetsAt: NOW + 10 * H, resets: [NOW + 10 * H] });
  });
});

describe("applyUsageHeaders", () => {
  function headers(info: Record<string, unknown>, account?: string): Headers {
    const h = new Headers({ [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(info) });
    if (account) h.set(CLAUDE_ACCOUNT_HEADER, account);
    return h;
  }
  const windows = { five_hour: { utilization: 0.2, resetsAt: 1_900_000_000 }, seven_day: { utilization: 0.4, resetsAt: 1_900_100_000 } };

  test("updates the account the event came from, and tracks rejection until the reset", () => {
    try {
      expect(applyUsageHeaders(headers({ status: "allowed", unifiedWindows: windows }, "test-acct-b"))).toBe("test-acct-b");
      expect(getAccountUsage("test-acct-b")?.fiveHour?.utilization).toBe(20);
      expect(getAccountLimitedUntil("test-acct-b", 1_000)).toBeNull();

      applyUsageHeaders(headers({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1_900_000_000, unifiedWindows: windows }, "test-acct-b"));
      expect(getAccountLimitedUntil("test-acct-b", 1_000)).toBe(1_900_000_000_000);
      expect(getAccountLimitedUntil("test-acct-b", 1_900_000_000_001)).toBeNull();

      applyUsageHeaders(headers({ status: "allowed" }, "test-acct-b"));
      expect(getAccountLimitedUntil("test-acct-b", 1_000)).toBeNull();

      // A turn moved onto extra usage keeps the account out of new turns too.
      applyUsageHeaders(headers({ status: "allowed", isUsingOverage: true, resetsAt: 1_900_000_500 }, "test-acct-b"));
      expect(getAccountLimitedUntil("test-acct-b", 1_000)).toBe(1_900_000_500_000);
    } finally {
      clearUsage("test-acct-b");
    }
  });
});

describe("one account's usage never goes back within a window", () => {
  const T = 1_793_301_676_441;
  const FIVE_HOUR_RESET = 1_793_305_200_000;
  const WEEKLY_RESET = 1_793_433_600_000;
  const window = (utilization: number, resetsAt: number | null) => ({ utilization, resetsAt });

  test("a report a point lower in the same window keeps the higher figure", () => {
    const previous = { fiveHour: window(41, FIVE_HOUR_RESET), sevenDay: window(95, WEEKLY_RESET) };
    expect(mergeUsage(previous, { fiveHour: window(40, FIVE_HOUR_RESET), sevenDay: window(94, WEEKLY_RESET) }, T)).toEqual(previous);
    // Growth always shows.
    expect(mergeUsage(previous, { fiveHour: window(42, FIVE_HOUR_RESET), sevenDay: window(95, WEEKLY_RESET) }, T).fiveHour?.utilization).toBe(42);
  });

  test("a new window, a past reset, a big drop or a drop off a limit takes the report", () => {
    const previous = { fiveHour: window(41, FIVE_HOUR_RESET), sevenDay: window(100, WEEKLY_RESET) };
    // The 5-hour window started over: a later reset time.
    expect(mergeUsage(previous, { fiveHour: window(2, FIVE_HOUR_RESET + 5 * 3_600_000), sevenDay: null }, T).fiveHour?.utilization).toBe(2);
    // The old window is past its reset.
    expect(mergeUsage(previous, { fiveHour: window(40, FIVE_HOUR_RESET), sevenDay: null }, FIVE_HOUR_RESET + 1).fiveHour?.utilization).toBe(40);
    // Anthropic reset the usage within the window.
    expect(mergeUsage(previous, { fiveHour: window(3, FIVE_HOUR_RESET), sevenDay: null }, T).fiveHour?.utilization).toBe(3);
    // The account has room again: routing must see it.
    expect(mergeUsage(previous, { fiveHour: null, sevenDay: window(99, WEEKLY_RESET) }, T).sevenDay?.utilization).toBe(99);
    // A window without a reset time has not started.
    expect(mergeUsage({ fiveHour: window(5, null), sevenDay: null }, { fiveHour: window(0, null), sevenDay: null }, T).fiveHour?.utilization).toBe(0);
  });

  test("the /usage poll and the rate_limit_events of Oct 29 alternate without the bar moving", () => {
    // Recorded on whale: the poll read main at 41% / 95%, the turns' events a
    // moment later at 40% / 94%, then 41% / 94%. The pooled bars went
    // 41 → 40 → 41 and 195 → 194 → 194 of 200 with no change in real usage.
    const max2 = { fiveHour: window(0, null), sevenDay: window(100, 1_793_415_600_000) };
    const event = (fiveHour: number, sevenDay: number) => new Headers({
      [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: fiveHour, resetsAt: FIVE_HOUR_RESET / 1000 },
          seven_day: { utilization: sevenDay, resetsAt: WEEKLY_RESET / 1000 },
        },
      }),
      [CLAUDE_ACCOUNT_HEADER]: "test-flicker-main",
    });
    const shown = () => {
      const pooled = aggregateUsage([getAccountUsage("test-flicker-main"), max2], T)!;
      return [Math.round(pooled.fiveHour!.utilization), Math.round(pooled.sevenDay!.utilization)];
    };
    try {
      applyPlanRateLimits("test-flicker-main", {
        five_hour: { utilization: 41, resets_at: new Date(1_793_305_199_991).toISOString() },
        seven_day: { utilization: 95, resets_at: new Date(1_793_433_599_991).toISOString() },
      }, T);
      expect(shown()).toEqual([41, 195]);
      applyUsageHeaders(event(0.40, 0.94), T + 44_881);
      expect(shown()).toEqual([41, 195]);
      applyUsageHeaders(event(0.41, 0.94), T + 66_916);
      expect(shown()).toEqual([41, 195]);
      applyUsageHeaders(event(0.42, 0.95), T + 219_765);
      expect(shown()).toEqual([42, 195]);
    } finally {
      clearUsage("test-flicker-main");
    }
  });
});

/** main's `/usage` report on Nov 9 2026 (Claude Code 2.1.321), the keys that matter. */
const FABLE_REPORT = {
  five_hour: null,
  seven_day: { utilization: 43, resets_at: "2026-11-14T07:59:59.679428+00:00" },
  extra_usage: { is_enabled: false, disabled_reason: "out_of_credits" },
  limits: [
    { kind: "weekly_all", group: "weekly", percent: 43, resets_at: "2026-11-14T07:59:59.679428+00:00", severity: "normal", is_active: true, scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 11, resets_at: "2026-11-14T07:59:59.679591+00:00", severity: "normal", is_active: false, scope: { model: { display_name: "Fable", id: null }, surface: null } },
  ],
  cedar_ember: null,
  weekly_scoped_shares: [{ limit_index: 1, used_percent_of_weekly: 6, allowance_percent_of_weekly: 50 }],
  model_scoped: [{ display_name: "Fable", utilization: 11, resets_at: "2026-11-14T07:59:59.679591+00:00" }],
};

describe("the Fable allowance in Claude Code's /usage report", () => {
  const RESET = Date.parse("2026-11-14T08:00:00Z");

  test("is the weekly row scoped to Fable, with its share of the weekly limit", () => {
    expect(usageFromPlanRateLimits(FABLE_REPORT)).toEqual({
      fiveHour: null,
      sevenDay: { utilization: 43, resetsAt: RESET },
      noFiveHourLimit: true,
      fable: { utilization: 11, resetsAt: RESET, allowanceOfWeekly: 50, limitedUntil: null },
    });
  });

  test("matches the model's name in any case, and falls back to the report's model_scoped entry", () => {
    const lower = { ...FABLE_REPORT, limits: [FABLE_REPORT.limits[0], { ...FABLE_REPORT.limits[1], scope: { model: { display_name: "fable 5.2" } } }] };
    expect(fableFromPlanRateLimits(lower)?.utilization).toBe(11);
    const { limits: _rows, ...noRows } = FABLE_REPORT;
    expect(fableFromPlanRateLimits(noRows)).toEqual({ utilization: 11, resetsAt: RESET, limitedUntil: null });
  });

  test("absent from the plan's rows means no Fable limit; a report with no rows says nothing", () => {
    expect(fableFromPlanRateLimits({ ...FABLE_REPORT, limits: [FABLE_REPORT.limits[0]], model_scoped: [] })).toBeNull();
    expect(fableFromPlanRateLimits({ seven_day: FABLE_REPORT.seven_day })).toBeUndefined();
    expect(usageFromPlanRateLimits({ seven_day: FABLE_REPORT.seven_day })).not.toHaveProperty("fable");
  });

  test("is kept per account with the usage snapshot, on disk too, and an event's window updates it", () => {
    const account = "test-fable-report";
    try {
      const now = Date.parse("2026-11-09T20:00:00Z");
      applyPlanRateLimits(account, FABLE_REPORT, now);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 11, resetsAt: RESET, allowanceOfWeekly: 50 });
      const saved = JSON.parse(readFileSync(join(runtimeDir(), "usage-anthropic.json"), "utf-8"));
      expect(saved.accounts[account].usage.fable).toEqual({ utilization: 11, resetsAt: RESET, allowanceOfWeekly: 50 });
      // A turn's rate_limit_event carries the allowance as the seven_day_overage_included window.
      const event = { status: "allowed", unifiedWindows: { seven_day: { utilization: 0.45, resetsAt: RESET / 1000 }, seven_day_overage_included: { utilization: 0.2, resetsAt: RESET / 1000 } } };
      applyUsageHeaders(new Headers({ [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(event), [CLAUDE_ACCOUNT_HEADER]: account }), now);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 20, resetsAt: RESET, allowanceOfWeekly: 50 });
      // An event without it keeps what is known.
      applyUsageHeaders(new Headers({ [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.46, resetsAt: RESET / 1000 } } }), [CLAUDE_ACCOUNT_HEADER]: account }), now);
      expect(getAccountUsage(account)?.fable?.utilization).toBe(20);
    } finally {
      clearUsage(account);
    }
  });
});

describe("running out of Fable allowance limits Fable only", () => {
  const account = "test-fable-limit";
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const RESET = Date.parse("2026-11-14T08:00:00Z");
  const windows = { seven_day: { utilization: 0.6, resetsAt: RESET / 1000 }, seven_day_overage_included: { utilization: 1, resetsAt: RESET / 1000, status: "rejected" } };
  function event(info: Record<string, unknown>, fableTurn = false, at = NOW): void {
    const headers = new Headers({ [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(info), [CLAUDE_ACCOUNT_HEADER]: account });
    if (fableTurn) headers.set(CLAUDE_FABLE_TURN_HEADER, "1");
    applyUsageHeaders(headers, at);
  }

  test("a refusal naming the allowance keeps the account usable and holds Fable until the allowance resets", () => {
    try {
      event({ status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: RESET / 1000, overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false, unifiedWindows: windows }, true);
      // Not an account at a usage limit: its other models go on, and nothing sends turns to API credits.
      expect(getAccountLimitedUntil(account, NOW)).toBeNull();
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 100, resetsAt: RESET, limitedUntil: RESET });
      expect(getAccountUsage(account)?.sevenDay?.utilization).toBe(60);
    } finally {
      clearUsage(account);
    }
  });

  test("a refusal that names no window is Fable's on a Fable turn with plan usage left, and the account's otherwise", () => {
    const open = { five_hour: { utilization: 0.3, resetsAt: NOW / 1000 + 3600 }, seven_day: { utilization: 0.6, resetsAt: RESET / 1000 } };
    expect(isFableScopedLimit({ status: "rejected", errorCode: "credits_required", unifiedWindows: open }, true)).toBe(true);
    expect(isFableScopedLimit({ status: "rejected", rateLimitType: "overage", unifiedWindows: open }, true)).toBe(true);
    // Another model's turn, a named plan window, or a full plan window: the account's limit.
    expect(isFableScopedLimit({ status: "rejected", unifiedWindows: open }, false)).toBe(false);
    expect(isFableScopedLimit({ status: "rejected", rateLimitType: "seven_day", unifiedWindows: open }, true)).toBe(false);
    expect(isFableScopedLimit({ status: "rejected", unifiedWindows: { ...open, seven_day: { utilization: 1, resetsAt: RESET / 1000 } } }, true)).toBe(false);
    expect(isFableScopedLimit({ status: "rejected", unifiedWindows: { ...open, five_hour: { utilization: 0.97, resetsAt: 1, status: "rejected" } } }, true)).toBe(false);
    // Named, it is the allowance's whatever the turn.
    expect(isFableScopedLimit({ status: "rejected", rateLimitType: "seven_day_overage_included" }, false)).toBe(true);
    try {
      event({ status: "rejected", resetsAt: RESET / 1000, unifiedWindows: open }, false);
      expect(getAccountLimitedUntil(account, NOW)).toBe(RESET);
      expect(getAccountUsage(account)?.fable).toBeUndefined();
    } finally {
      clearUsage(account);
    }
  });

  test("Fable billed to extra usage holds Fable, not the account", () => {
    try {
      event({ status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: RESET / 1000, overageStatus: "allowed", isUsingOverage: true, unifiedWindows: windows }, true);
      expect(getAccountLimitedUntil(account, NOW)).toBeNull();
      expect(getAccountUsage(account)?.fable?.limitedUntil).toBe(RESET);
    } finally {
      clearUsage(account);
    }
  });

  test("the hold ends when a Fable request goes through, a full report shows allowance left, or its time passes", () => {
    try {
      const refuse = () => event({ status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: RESET / 1000, unifiedWindows: windows }, true);
      refuse();
      // Another model's allowed request says nothing about Fable.
      event({ status: "allowed", unifiedWindows: windows });
      expect(getAccountUsage(account)?.fable?.limitedUntil).toBe(RESET);
      event({ status: "allowed", unifiedWindows: windows }, true);
      expect(getAccountUsage(account)?.fable?.limitedUntil).toBeUndefined();

      refuse();
      // A report still at 100% keeps it; one under 100% ends it.
      const full = { ...FABLE_REPORT, limits: [FABLE_REPORT.limits[0], { ...FABLE_REPORT.limits[1], percent: 100 }] };
      applyPlanRateLimits(account, full, NOW);
      expect(getAccountUsage(account)?.fable).toMatchObject({ utilization: 100, limitedUntil: RESET });
      applyPlanRateLimits(account, { ...FABLE_REPORT, limits: [FABLE_REPORT.limits[0], { ...FABLE_REPORT.limits[1], percent: 96 }] }, NOW);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 96, resetsAt: RESET, allowanceOfWeekly: 50 });

      refuse();
      // Past the reset the next reading drops it.
      event({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.01, resetsAt: RESET / 1000 + 7 * 86_400 }, seven_day_overage_included: { utilization: 0, resetsAt: RESET / 1000 + 7 * 86_400 } } }, false, RESET + 60_000);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 0, resetsAt: RESET + 7 * 86_400_000, allowanceOfWeekly: 50 });
    } finally {
      clearUsage(account);
    }
  });

  test("a refusal known only from a turn's error is held too: until the allowance's known reset, else briefly", () => {
    try {
      noteAccountFableRefusal(account, null, NOW);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 100, resetsAt: null, limitedUntil: NOW + 15 * 60_000 });
      expect(getAccountLimitedUntil(account, NOW)).toBeNull();
      clearUsage(account);
      applyPlanRateLimits(account, FABLE_REPORT, NOW);
      noteAccountFableRefusal(account, null, NOW);
      expect(getAccountUsage(account)?.fable).toEqual({ utilization: 11, resetsAt: RESET, allowanceOfWeekly: 50, limitedUntil: RESET });
      // Under /proxy the hold is capped: the remote judges, and a later turn finds out.
      clearUsage(account);
      noteAccountFableRefusal(account, RESET, NOW, 15 * 60_000);
      expect(getAccountUsage(account)?.fable?.limitedUntil).toBe(NOW + 15 * 60_000);
    } finally {
      clearUsage(account);
    }
  });
});
