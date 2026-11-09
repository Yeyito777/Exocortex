import { describe, expect, test } from "bun:test";
import type { ClaudeAccountReport } from "./account-pool";
import { formatClaudeAccountReports } from "./account-report";

const NOW = 1_800_000_000_000;
const H = 3_600_000;

function report(id: string, usage: ClaudeAccountReport["usage"]): ClaudeAccountReport {
  return {
    account: { id, configDir: `/tmp/${id}` },
    status: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
    available: true,
    limited: false,
    limitedUntil: null,
    block: null,
    usage,
    activeTurns: 0,
    conversations: 0,
  } as ClaudeAccountReport;
}

const sevenDay = { utilization: 11, resetsAt: NOW + 120 * H };
const verified = { fiveHour: null, sevenDay, noFiveHourLimit: true };
const limited = { fiveHour: { utilization: 1, resetsAt: NOW + 4 * H }, sevenDay };

describe("/account claude and the 5-hour limit", () => {
  test("an account without it reads n/a, and an unknown window still reads ?", () => {
    const text = formatClaudeAccountReports([report("main", verified), report("max2", limited), report("max3", { fiveHour: null, sevenDay })], null, NOW);
    expect(text).toContain("5-hour n/a · weekly 11%");
    expect(text).toContain("5-hour 1% (resets in 4h00m) · weekly 11%");
    expect(text).toContain("5-hour ? · weekly 11%");
  });

  test("the combined line has each window's own capacity", () => {
    const line = (combined: ClaudeAccountReport["usage"]) => formatClaudeAccountReports([report("main", verified)], combined, NOW).split("\n").find(row => row.startsWith("Combined"));
    expect(line({ fiveHour: limited.fiveHour, sevenDay, capacity: 200, fiveHourCapacity: 100 })).toBe("Combined (the usage bars): 5-hour 1/100% · weekly 11/200%");
    expect(line({ fiveHour: null, sevenDay, capacity: 200, fiveHourCapacity: 0 })).toBe("Combined (the usage bars): 5-hour n/a · weekly 11/200%");
    expect(line({ fiveHour: limited.fiveHour, sevenDay, capacity: 200 })).toBe("Combined (the usage bars): 5-hour 1/200% · weekly 11/200%");
  });

  test("the Fable allowance follows the weekly window where an account reports one, with a refusal said in words", () => {
    const fable = { utilization: 97, resetsAt: NOW + 120 * H, allowanceOfWeekly: 50 };
    const text = formatClaudeAccountReports([report("main", { ...verified, fable: { ...fable, limitedUntil: NOW + 120 * H } }), report("max2", { ...verified, fable: { ...fable, utilization: 5 } }), report("max3", verified)], { fiveHour: null, sevenDay, capacity: 300, fiveHourCapacity: 0, fable: { utilization: 102, resetsAt: NOW + 120 * H } }, NOW);
    expect(text).toContain("5-hour n/a · weekly 11% (resets in 5d0h) · Fable 97% (resets in 5d0h), Fable refused for 5d0h");
    expect(text).toContain("5-hour n/a · weekly 11% (resets in 5d0h) · Fable 5% (resets in 5d0h)\n");
    expect(text.split("\n").filter(row => row.includes("Fable"))).toHaveLength(3);
    expect(text).toContain("Combined (the usage bars): 5-hour n/a · weekly 11/300% · Fable 102/300%");
  });
});
