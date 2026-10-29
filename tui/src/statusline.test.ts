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

    test("shows the share used, what is left and the runway at this week's pace; the budget is ignored", () => {
      const block = apiKeyRows(keyWith(credit()));
      const rows = block.rows.map(stripAnsi);
      // 64.04 of 1000 is 6.4%: one cell of twenty.
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] $64.04 used · $935.96 left`);
      // 935.96 / (64.04 / 7) = 102.3 days, which ends before Oct 20 2027: yellow.
      expect(rows[1].trimEnd()).toBe("  Today:   $39.30 · ~102 days left at this week's pace");
      expect(block.rows[1]).toContain(`${theme.warning} · ~102 days left`);
      expect(block.rows[0]).toContain(`${theme.accent}$935.96 left`);
      expect(rows.every((row) => row.length === block.width)).toBe(true);
      expect(rows.join("\n")).not.toContain("unpriced");
      expect(rows.join("\n")).not.toContain("Month");
    });

    test("no history yet: nothing used, no runway", () => {
      const view = creditView(credit({ usedUsd: 0, firstTrackedDay: null, paceUsd: 0, paceDays: 0 }));
      expect(view).toMatchObject({ leftUsd: 1000, approximate: false, runway: null, runsOutBeforeExpiry: false, low: false });
      const rows = apiKeyRows(keyWith(credit({ usedUsd: 0, firstTrackedDay: null, paceUsd: 0, paceDays: 0 }), 0)).rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2591".repeat(20)}] $0.000 used · $1000.00 left`);
      expect(rows[1].trimEnd()).toBe("  Today:   $0.000");
    });

    test("history starting after the grant says since when and marks the balance approximate", () => {
      const c = credit({ firstTrackedDay: "2026-10-26", usedUsd: 30, paceUsd: 30, paceDays: 3 });
      const rows = apiKeyRows(keyWith(c, 10)).rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] $30.00 used since Oct 26 · ≈$970.00 left`);
      // 970 / (30 / 3) = 97 days.
      expect(rows[1].trimEnd()).toBe("  Today:   $10.00 · ~97 days left at the last 3 days' pace");
      expect(creditView(credit({ firstTrackedDay: "2026-10-28", paceDays: 1, paceUsd: 5 })).runway).toBe("~187 days left at today's pace");
    });

    test("a low balance is red", () => {
      const c = credit({ usedUsd: 950, paceUsd: 70, paceDays: 7 });
      const block = apiKeyRows(keyWith(c, 10));
      const rows = block.rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(19)}${"\u2591".repeat(1)}] $950.00 used · $50.00 left`);
      expect(block.rows[0]).toContain(`${theme.error}$50.00 left`);
      expect(rows[1].trimEnd()).toBe("  Today:   $10.00 · ~5 days left at this week's pace");
      expect(creditView(credit({ usedUsd: 1200 }))).toMatchObject({ leftUsd: 0, low: true, runwayDays: 0, runway: "<1 day left at this week's pace" });
    });

    test("a runway outlasting the expiry is not a warning", () => {
      const c = credit({ usedUsd: 7, paceUsd: 7, paceDays: 7 }); // $1/day: 993 days, past the expiry in 357
      const view = creditView(c);
      expect(view).toMatchObject({ runwayDays: 993, runsOutBeforeExpiry: false });
      expect(apiKeyRows(keyWith(c, 1)).rows[1]).toContain(`${theme.muted} · ~993 days left`);
      // Without an expiry nothing can run out before it.
      expect(creditView(credit({ expires: null })).runsOutBeforeExpiry).toBe(false);
      // Runway shorter than expiry, as in the first case.
      expect(creditView(credit()).runsOutBeforeExpiry).toBe(true);
    });

    test("an expired grant says so instead of a balance", () => {
      const rows = apiKeyRows(keyWith(credit({ asOf: "2027-10-21" }))).rows.map(stripAnsi);
      expect(rows[0].trimEnd()).toBe(`  Credits: [${"\u2588".repeat(1)}${"\u2591".repeat(19)}] $64.04 used · expired Oct 20`);
      expect(rows[1].trimEnd()).toBe("  Today:   $39.30");
    });

    test("the /tokens line names the grant, the balance, the runway and the unpriced count", () => {
      const state = stateWithApiKey(keyWith(credit({ firstTrackedDay: "2026-10-22" })));
      expect(usageSummary(state)).toBe(
        "API key k: $1000.00 credit, ≈$64.04 used since Oct 22 · ≈$935.96 left · ~102 days left at this week's pace"
        + " · today ≈$39.30 · 12.3K tok · 1 request not priced (no per-token rate, e.g. audio, images)",
      );
    });
  });
});
