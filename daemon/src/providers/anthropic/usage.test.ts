import { describe, expect, test } from "bun:test";
import {
  aggregateUsage,
  applyUsageHeaders,
  CLAUDE_ACCOUNT_HEADER,
  CLAUDE_RATE_LIMIT_HEADER,
  clearUsage,
  getAccountLimitedUntil,
  getAccountUsage,
  applyPlanRateLimits,
  mergeUsage,
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
    expect(usageFromPlanRateLimits({ five_hour: null, seven_day: { utilization: 45, resets_at: null } }, previous)).toEqual({
      fiveHour: previous.fiveHour,
      sevenDay: { utilization: 45, resetsAt: null },
    });
    expect(usageFromPlanRateLimits({ five_hour: null, seven_day: null }, previous)).toBeNull();
    expect(usageFromPlanRateLimits(null, previous)).toBeNull();
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

describe("aggregateUsage", () => {
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
