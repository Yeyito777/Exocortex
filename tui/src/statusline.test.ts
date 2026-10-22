import { describe, expect, test } from "bun:test";
import { stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import { contextBlock } from "./statusblocks/context";
import { usageBlock } from "./statusblocks/usage";
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
  test("shows the key's counted spend instead of plan bars, at its measured width", () => {
    const state = createInitialState();
    state.provider = "openai";
    state.authByProvider.openai = true;
    const spend = { inputTokens: 12_000, cachedInputTokens: 0, outputTokens: 300, requests: 3, estimatedCostUsd: 0.0421, unpricedRequests: 1 };
    state.usageByProvider.openai = {
      fiveHour: null,
      sevenDay: null,
      apiKey: { label: "sk-proj-…abcd", today: spend, month: { ...spend, estimatedCostUsd: 1.5, inputTokens: 2_000_000 } },
    };
    const block = usageBlock(state)!;
    const rows = block.rows.map(stripAnsi);
    expect(rows[0]).toContain("API key sk-proj-…abcd · billed per token");
    expect(rows[1]).toContain("Today: ≈$0.042 · 12.3K tok +1 unpriced");
    expect(rows[1]).toContain("Month: ≈$1.50 · 2.0M tok +1 unpriced");
    expect(rows.every((row) => row.length === block.width)).toBe(true);
    expect(stripAnsi(renderStatusLine(state, 200).lines.join("\n"))).not.toContain("5-Hour");
  });
});
