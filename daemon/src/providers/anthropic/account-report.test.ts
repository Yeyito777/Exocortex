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

describe("/account claude and a long-lived token", () => {
  const DAY = 24 * H;
  const withToken = (mintedAt: number, tokenProblem?: string): ClaudeAccountReport => {
    const base = report("max2", verified);
    return {
      ...base,
      account: { ...base.account, token: { secret: "CLAUDE_SETUP_TOKEN_MAX2", mintedAt: new Date(mintedAt).toISOString() } },
      status: { loggedIn: true, authMethod: tokenProblem ? "claude.ai" : "oauth_token", subscriptionType: "max", ...(tokenProblem ? { tokenProblem } : {}) },
    };
  };
  const text = (entry: ClaudeAccountReport) => formatClaudeAccountReports([entry], null, NOW);

  test("says until when the token lasts, and reminds in its last month", () => {
    const fresh = text(withToken(NOW - 10 * DAY));
    expect(fresh).toContain("max2 — max — ready");
    expect(fresh).toContain(`long-lived token until ${new Date(NOW + 355 * DAY).toISOString().slice(0, 10)}`);
    expect(fresh).not.toContain("setup-token");
    const ending = text(withToken(NOW - 350 * DAY));
    expect(ending).toContain("long-lived token ends in 15d0h");
    expect(ending).toContain("mint a new one with `claude setup-token`, then scripts/claude-account-token max2");
    expect(text(withToken(NOW - 366 * DAY))).toContain("long-lived token past its year");
  });

  test("says why a token is not in use", () => {
    expect(text(withToken(NOW - 10 * DAY, "HTTP 401 OAuth token has expired"))).toContain("long-lived token not in use (HTTP 401 OAuth token has expired)");
    expect(text(report("main", verified))).not.toContain("long-lived token");
  });
});
