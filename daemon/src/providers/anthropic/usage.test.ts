import { describe, expect, test } from "bun:test";
import {
  aggregateUsage,
  applyUsageHeaders,
  CLAUDE_ACCOUNT_HEADER,
  CLAUDE_RATE_LIMIT_HEADER,
  clearUsage,
  getAccountLimitedUntil,
  getAccountUsage,
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
      fiveHour: { utilization: 1, resetsAt: Date.parse("2026-10-10T06:30:00.001703+00:00") },
      sevenDay: { utilization: 48, resetsAt: Date.parse("2026-10-10T08:00:00.001754+00:00") },
    });
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
