import { describe, expect, test } from "bun:test";
import { usageFromPlanRateLimits, usageFromRateLimitInfo } from "./usage";

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
