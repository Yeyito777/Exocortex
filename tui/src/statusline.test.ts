import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import { contextBlock } from "./statusblocks/context";
import { apiKeyRows, dailyAllowance, usageBlock } from "./statusblocks/usage";
import type { ApiKeyUsage } from "./messages";
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
    expect(rows[1].trimEnd()).toBe("  Month:  $14.87 +3 unpriced");
    expect(rows.every((row) => row.length === block.width)).toBe(true);
    const rendered = stripAnsi(renderStatusLine(state, 200).lines.join("\n"));
    expect(rendered).not.toContain("5-Hour");
    expect(rendered).not.toContain("sk-proj");
    expect(rows[0].indexOf("$")).toBe(stripAnsi(usageBlock(stateWithUsage())!.rows[0]).indexOf("["));
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

  test("past the budget, today's allowance is zero and the bars stay full", () => {
    const now = new Date(2026, 9, 31, 12).getTime();
    const apiKey = { label: "k", today: spend(1), month: spend(25, 2), monthlyBudgetUsd: 20 };
    expect(dailyAllowance(apiKey, 20, now)).toBe(0);
    const rows = apiKeyRows(apiKey, now).rows.map(stripAnsi);
    expect(rows[0]).toContain(`[${"\u2588".repeat(20)}] $1.00 / $0.000`);
    expect(rows[1]).toContain(`[${"\u2588".repeat(20)}] $25.00 / $20.00 +2 unpriced`);
  });
});
