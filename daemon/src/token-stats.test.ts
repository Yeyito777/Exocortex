import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tokenStatsDir } from "@exocortex/shared/paths";
import { getTokenStatsSnapshot, recordTokenUsage, resetTokenStatsForTest } from "./token-stats";

function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

describe("token stats", () => {
  beforeEach(() => {
    resetTokenStatsForTest();
  });

  afterEach(() => {
    resetTokenStatsForTest();
  });

  test("records totals by provider, model, and source", () => {
    const first = recordTokenUsage("openai", "gpt-5.4", { inputTokens: 120, outputTokens: 30 }, { source: "conversation", conversationId: "conv-1" });
    const second = recordTokenUsage("openai", "gpt-5.4-mini", { inputTokens: 40, outputTokens: 10 }, { source: "llm_complete" });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.day).toBe(todayKey());
    expect(snapshot.today.inputTokens).toBe(160);
    expect(snapshot.today.outputTokens).toBe(40);
    expect(snapshot.today.totalTokens).toBe(200);
    expect(snapshot.today.requests).toBe(2);
    expect(snapshot.today.byProvider.openai).toMatchObject({
      inputTokens: 160,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 40,
      totalTokens: 200,
      requests: 2,
    });
    expect(snapshot.today.byModel["gpt-5.4"]).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 30,
      totalTokens: 150,
      requests: 1,
    });
    expect(snapshot.today.byModel["gpt-5.4-mini"]).toMatchObject({
      inputTokens: 40,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 50,
      requests: 1,
    });
    expect(snapshot.today.bySource.conversation).toMatchObject({
      inputTokens: 120,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 30,
      totalTokens: 150,
      requests: 1,
    });
    expect(snapshot.today.bySource.llm_complete).toMatchObject({
      inputTokens: 40,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 10,
      totalTokens: 50,
      requests: 1,
    });
    expect(snapshot.lifetime.totalTokens).toBe(200);
    expect(snapshot.days).toHaveLength(1);
  });

  test("canonicalizes provider alias models before aggregating", () => {
    recordTokenUsage("deepseek", "pro", { inputTokens: 500, outputTokens: 100 }, { source: "conversation" });

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.byModel.pro).toBeUndefined();
    expect(snapshot.today.byModel["deepseek-v4-pro"]).toMatchObject({
      inputTokens: 500,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 100,
      totalTokens: 600,
      requests: 1,
    });
  });

  test("records cache hits, cache misses/writes, ordinary input, and exact GPT-5.6 cost", () => {
    recordTokenUsage("openai", "gpt-5.6-sol", {
      inputTokens: 120,
      cachedInputTokens: 90,
      cacheMissInputTokens: 20,
      outputTokens: 30,
    }, { source: "conversation" });

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.cachedInputTokens).toBe(90);
    expect(snapshot.today.cacheMissInputTokens).toBe(20);
    expect(snapshot.today.uncachedInputTokens).toBe(10);
    expect(snapshot.today.unmeasuredInputTokens).toBe(0);
    expect(snapshot.today.estimatedInputCostUsd).toBeCloseTo(0.000176);
    expect(snapshot.today.estimatedOutputCostUsd).toBeCloseTo(0.0006);
    expect(snapshot.today.pricedInputTokens).toBe(120);
    expect(snapshot.today.pricedOutputTokens).toBe(30);
  });

  test("keeps provider input without complete cache details explicitly unmeasured", () => {
    recordTokenUsage("openai", "gpt-5.6-sol", {
      inputTokens: 120,
      cachedInputTokens: 90,
      outputTokens: 30,
    }, { source: "conversation" });

    const totals = getTokenStatsSnapshot().today;
    expect(totals.cachedInputTokens).toBe(90);
    expect(totals.cacheMissInputTokens).toBe(0);
    expect(totals.uncachedInputTokens).toBe(0);
    expect(totals.unmeasuredInputTokens).toBe(30);
    expect(totals.pricedInputTokens).toBe(90);
    expect(totals.estimatedInputCostUsd).toBeCloseTo(0.000036);
  });

  test("uses the provider-reported billing tier and per-request long-context table", () => {
    recordTokenUsage("openai", "gpt-5.6-terra", {
      inputTokens: 300_000,
      cachedInputTokens: 100_000,
      cacheMissInputTokens: 100_000,
      outputTokens: 1_000,
      // A requested fast call can be downgraded and billed as standard.
      billingServiceTier: "standard",
    }, { source: "conversation" }, { serviceTier: "fast" });

    const totals = getTokenStatsSnapshot().today;
    expect(totals.estimatedInputCostUsd).toBeCloseTo(0.94);
    expect(totals.estimatedOutputCostUsd).toBeCloseTo(0.018);
    expect(totals.pricedInputTokens).toBe(300_000);
  });

  test("uses DeepSeek's explicit hit/miss fields and UTC rate period", () => {
    const mondayPeak = Date.UTC(2026, 7, 24, 2, 0, 0);
    recordTokenUsage("deepseek", "deepseek-v4-pro", {
      inputTokens: 1_000_000,
      cachedInputTokens: 750_000,
      cacheMissInputTokens: 250_000,
      outputTokens: 100_000,
    }, { source: "conversation" }, { timestamp: mondayPeak });

    const lifetime = getTokenStatsSnapshot().lifetime;
    expect(lifetime.estimatedInputCostUsd).toBeCloseTo(0.363);
    expect(lifetime.estimatedOutputCostUsd).toBeCloseTo(0.396);
  });

  test("merges token stats from other instance files into the lifetime snapshot", () => {
    recordTokenUsage("openai", "gpt-5.4", { inputTokens: 10, outputTokens: 5 }, { source: "conversation" });

    mkdirSync(tokenStatsDir(), { recursive: true });
    writeFileSync(join(tokenStatsDir(), "other-worktree.json"), JSON.stringify({
      version: 1,
      instance: "other-worktree",
      updatedAt: Date.now() - 1000,
      days: {
        [todayKey()]: {
          inputTokens: 20,
          cachedInputTokens: 15,
          uncachedInputTokens: 5,
          outputTokens: 10,
          totalTokens: 30,
          requests: 1,
          byProvider: {
            deepseek: {
              inputTokens: 20,
              cachedInputTokens: 15,
              uncachedInputTokens: 5,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
          byModel: {
            "deepseek-v4-pro": {
              inputTokens: 20,
              cachedInputTokens: 15,
              uncachedInputTokens: 5,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
          bySource: {
            conversation: {
              inputTokens: 20,
              cachedInputTokens: 15,
              uncachedInputTokens: 5,
              outputTokens: 10,
              totalTokens: 30,
              requests: 1,
            },
          },
        },
      },
    }, null, 2));

    const snapshot = getTokenStatsSnapshot();
    expect(snapshot.today.totalTokens).toBe(45);
    expect(snapshot.today.requests).toBe(2);
    expect(snapshot.today.byProvider.openai?.totalTokens).toBe(15);
    expect(snapshot.today.byProvider.deepseek?.totalTokens).toBe(30);
    expect(snapshot.lifetime.totalTokens).toBe(45);
    expect(snapshot.today.byProvider.deepseek?.cachedInputTokens).toBe(15);
    // V1 called every non-hit token "uncached" before cache writes/misses were
    // tracked separately; the migration keeps that residual unclassified.
    expect(snapshot.today.byProvider.deepseek?.uncachedInputTokens).toBe(0);
    expect(snapshot.today.byProvider.deepseek?.unmeasuredInputTokens).toBe(5);
    expect(snapshot.today.byProvider.deepseek?.pricedInputTokens).toBe(0);
  });
});
