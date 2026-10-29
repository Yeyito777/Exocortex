import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import { contextBlock } from "./statusblocks/context";
import { apiKeyRows, creditView, dailyAllowance, usageBlock, usageSummary } from "./statusblocks/usage";
import type { ApiKeyCredit, ApiKeyUsage } from "./messages";
import { theme } from "./theme";
import { renderStatusLine } from "./statusline";

function stateWithUsage() {
  const state = createInitialState();
  state.provider = "openai";
  state.authByProvider.openai = true;
  state.usageByProvider.openai = {
    fiveHour: { utilization: 25, resetsAt: null },
    sevenDay: { utilization: 50, resetsAt: null },
  };
  return state;
}

describe("status line priority", () => {
  test("keeps usage over context when either fits but both do not", () => {
    const state = stateWithUsage();
    const usage = usageBlock(state)!;
    const context = contextBlock(state)!;
    for (const cols of [
      Math.max(usage.width, context.width),
      usage.width + context.width + 2,
    ]) {
      const rendered = stripAnsi(renderStatusLine(state, cols).lines.join("\n"));
      expect(rendered).toContain("5-Hour");
      expect(rendered).toContain("Weekly");
      expect(rendered).not.toContain("Context");
    }
  });

  test("keeps usage before context when both fit exactly", () => {
    const state = stateWithUsage();
    const cols = usageBlock(state)!.width + contextBlock(state)!.width + 3;
    const rendered = stripAnsi(renderStatusLine(state, cols).lines[0]);
    expect(rendered).toContain("5-Hour");
    expect(rendered).toContain("Context");
    expect(rendered.indexOf("5-Hour")).toBeLessThan(rendered.indexOf("Context"));
  });

  test("still shows context when usage is unavailable", () => {
    const state = createInitialState();
    const rendered = stripAnsi(
      renderStatusLine(state, contextBlock(state)!.width).lines.join("\n"),
    );
    expect(rendered).toContain("Context");
    expect(rendered).not.toContain("5-Hour");
  });
});

describe("API-key usage", () => {
  const spend = (estimatedCostUsd: number, unpricedRequests = 0) => ({ inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 300, requests: 3, estimatedCostUsd, unpricedRequests });

  function stateWithApiKey(apiKey: ApiKeyUsage) {
    const state = createInitialState();
    state.provider = "openai";
    state.authByProvider.openai = true;
    state.usageByProvider.openai = { fiveHour: null, sevenDay: null, apiKey };
    return state;
  }

  test("without a budget shows plain amounts, aligned with the plan bars, at its measured width", () => {
    const state = stateWithApiKey({ label: "sk-proj-…abcd", today: spend(0.0421, 1), month: spend(14.87, 3) });
    const block = usageBlock(state)!;
    const rows = block.rows.map(stripAnsi);
    expect(rows[0].trimEnd()).toBe("  Today:  $0.042");
    expect(rows[1].trimEnd()).toBe("  Month:  $14.87");
    expect(rows.every((row) => row.length === block.width)).toBe(true);
    const rendered = stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(rendered).not.toContain("5-Hour");
    expect(rendered).not.toContain("sk-proj");
    expect(rendered).not.toContain("unpriced");
    expect(rows[0].indexOf("$")).toBe(stripAnsi(usageBlock(stateWithUsage())!.rows[0]).indexOf("["));
    // /tokens keeps the count, explained.
    expect(usageSummary(state)).toContain("3 requests not priced (no per-token rate, e.g. audio, images)");
  });

  test("with a budget draws the month against it and today against its share of what is left", () => {
    const now = new Date(2026, 9, 25, 12).getTime(); // Oct 25: 7 days left, today included
    const apiKey = { label: "sk-proj-…abcd", today: spend(0.412), month: spend(14.87), monthlyBudgetUsd: 20 };
    expect(dailyAllowance(apiKey, 20, now)).toBeCloseTo((20 - (14.87 - 0.412)) / 7, 10);
    const block = apiKeyRows(apiKey, now);
    const rows = block.rows.map(stripAnsi);
    expect(rows[0].trimEnd()).toBe(`  Today:  [${"\u2588".repeat(10)}${"\u2591".repeat(10)}] $0.412 / $0.792`);
    expect(rows[1].trimEnd()).toBe(`  Month:  [${"\u2588".repeat(15)}${"\u2591".repeat(5)}] $14.87 / $20.00`);
    expect(rows.every((row) => row.length === block.width)).toBe(true);
    expect(rows[0].indexOf("[")).toBe(stripAnsi(usageBlock(stateWithUsage())!.rows[0]).indexOf("["));
  });

  test("past the budget, today is its plain spend, never a $0.000 limit", () => {
    const now = new Date(2026, 9, 31, 12).getTime();
    const apiKey = { label: "k", today: spend(1), month: spend(25, 2), monthlyBudgetUsd: 20 };
    expect(dailyAllowance(apiKey, 20, now)).toBe(0);
    const block = apiKeyRows(apiKey, now);
    const rows = block.rows.map(stripAnsi);
    expect(rows[0].trimEnd()).toBe("  Today:  $1.00");
    expect(rows[1].trimEnd()).toBe(`  Month:  [${"\u2588".repeat(20)}] $25.00 / $20.00`);
    expect(rows.join("\n")).not.toContain("$0.000");
    expect(rows.join("\n")).not.toContain("unpriced");
    expect(rows.every((row) => row.length === block.width)).toBe(true);
    // The month's spend is red past the budget.
    expect(block.rows[1]).toContain(`${theme.error}$25.00`);
  });

  describe("against a credit grant", () => {
    const credit = (overrides: Partial<ApiKeyCredit> = {}): ApiKeyCredit => ({
      amountUsd: 1000,
      since: "2026-10-20",
      expires: "2027-10-20",
      asOf: "2026-10-28",
      usedUsd: 64.04,
      firstTrackedDay: "2026-10-20",
      paceUsd: 64.04,
      paceDays: 7,
      ...overrides,
    });
    const keyWith = (c: ApiKeyCredit, today = 39.3, budget: number | null = 20): ApiKeyUsage =>
      ({ label: "k", today: spend(today, 1), month: spend(64.04, 11), monthlyBudgetUsd: budget, credit: c });

    // Oct 28 to the expiry on Oct 20 2027: 357 days, today included.
    const DAYS_TO_EXPIRY = 357;

    test("under the pace: the balance over the grant, and today against what lasts until expiry; the budget is ignored", () => {
      const c = credit({ usedUsd: 64.44 });
      const block = apiKeyRows(keyWith(c, 1.5));
      const rows = block.rows.map(stripAnsi);
      // 64.44 of 1000 is 6.4%: one cell of twenty; 935.56 left shows as $936.
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] $936 / $1000`);
      // This morning's balance: 1000 - (64.44 - 1.50) = 937.06, over 357 days = $2.62/day; 1.50 of it is 11 cells.
      expect(creditView(c, 1.5).paceUsd).toBeCloseTo(937.06 / DAYS_TO_EXPIRY, 10);
      expect(rows[1].trimEnd()).toBe(`  Today:   [${"\u2588".repeat(11)}${"\u2591".repeat(9)}] $1.50 / $2.62`);
      expect(block.rows[0]).toContain(`${theme.accent}$936`);
      expect(block.rows[1]).toContain(`${theme.accent}$1.50`);
      expect(rows.every((row) => row.length === block.width)).toBe(true);
      const text = rows.join("\n");
      for (const gone of ["used", "since", "≈", "days left", "unpriced", "Month"]) expect(text).not.toContain(gone);
    });

    test("over the pace: today's spend is red and its bar full", () => {
      const block = apiKeyRows(keyWith(credit({ usedUsd: 64.44 }), 39.7));
      const rows = block.rows.map(stripAnsi);
      // 1000 - (64.44 - 39.70) = 975.26 this morning, over 357 days.
      expect(rows[1].trimEnd()).toBe(`  Today:   [${"\u2588".repeat(20)}] $39.70 / $2.73`);
      expect(block.rows[1]).toContain(`${theme.error}$39.70`);
      expect(rows.every((row) => row.length === block.width)).toBe(true);
    });

    test("no history yet: nothing used, the whole grant spread to expiry", () => {
      const c = credit({ usedUsd: 0, firstTrackedDay: null, paceUsd: 0, paceDays: 0 });
      expect(creditView(c, 0)).toMatchObject({ leftUsd: 1000, approximate: false, runway: null, low: false });
      const rows = apiKeyRows(keyWith(c, 0)).rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2591".repeat(20)}] $1000 / $1000`);
      expect(rows[1].trimEnd()).toBe(`  Today:   [${"\u2591".repeat(20)}] $0.00 / $2.80`);
    });

    test("a low balance is red, and the pace shrinks with it", () => {
      const c = credit({ usedUsd: 950, paceUsd: 70, paceDays: 7 });
      const block = apiKeyRows(keyWith(c, 10));
      const rows = block.rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(19)}${"\u2591".repeat(1)}] $50 / $1000`);
      expect(block.rows[0]).toContain(`${theme.error}$50`);
      // (1000 - 940) / 357 = $0.17/day.
      expect(rows[1].trimEnd()).toBe(`  Today:   [${"\u2588".repeat(20)}] $10.00 / $0.17`);
      expect(block.rows[1]).toContain(`${theme.error}$10.00`);
      // Nothing left at all: no pace, today is its plain spend.
      const spent = apiKeyRows(keyWith(credit({ usedUsd: 1200 }), 5)).rows.map(stripAnsi);
      expect(spent[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(20)}] $0 / $1000`);
      expect(spent[1].trimEnd()).toBe("  Today:   $5.00");
    });

    test("an expired grant says so; today is its plain spend", () => {
      const block = apiKeyRows(keyWith(credit({ asOf: "2027-10-20" })));
      const rows = block.rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] expired Oct 20`);
      expect(block.rows[0]).toContain(`${theme.error}expired Oct 20`);
      expect(rows[1].trimEnd()).toBe("  Today:   $39.30");
      // The day before it expires, that one day gets the whole balance.
      expect(creditView(credit({ asOf: "2027-10-19", usedUsd: 100 }), 0).paceUsd).toBe(900);
    });

    test("without an expiry, today is its plain spend", () => {
      const c = credit({ expires: null });
      expect(creditView(c, 39.3).paceUsd).toBeNull();
      const rows = apiKeyRows(keyWith(c)).rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] $936 / $1000`);
      expect(rows[1].trimEnd()).toBe("  Today:   $39.30");
    });

    test("the runway stays out of the bar but is in /tokens", () => {
      expect(creditView(credit(), 39.3).runway).toBe("~102 days left at this week's pace");
      expect(creditView(credit({ firstTrackedDay: "2026-10-28", paceDays: 1, paceUsd: 5 }), 5).runway).toBe("~187 days left at today's pace");
      expect(creditView(credit({ firstTrackedDay: "2026-10-26", usedUsd: 30, paceUsd: 30, paceDays: 3 }), 10).runway).toBe("~97 days left at the last 3 days' pace");
      expect(creditView(credit({ usedUsd: 1200 }), 0).runway).toBe("<1 day left at this week's pace");
    });

    test("the /tokens line has the balance, the pace, the first counted day, the runway and the unpriced count", () => {
      const state = stateWithApiKey(keyWith(credit({ firstTrackedDay: "2026-10-22", usedUsd: 64.44 }), 39.7));
      expect(usageSummary(state)).toBe(
        "API key k: ≈$936 / $1000 credit left (counted from Oct 22; earlier days not seen) · $2.73/day to last until Oct 20 2027"
        + " · ~102 days left at this week's pace · today ≈$39.70 · 12.3K tok · 1 request not priced (no per-token rate, e.g. audio, images)",
      );
      expect(usageSummary(stateWithApiKey(keyWith(credit({ asOf: "2027-10-21" }))))).toBe(
        "API key k: $1000 credit expired Oct 20 2027 · today ≈$39.30 · 12.3K tok · 1 request not priced (no per-token rate, e.g. audio, images)",
      );
      expect(usageSummary(stateWithApiKey(keyWith(credit({ expires: null }))))).toBe(
        "API key k: ≈$936 / $1000 credit left · ~102 days left at this week's pace · today ≈$39.30 · 12.3K tok · 1 request not priced (no per-token rate, e.g. audio, images)",
      );
    });
  });
});
