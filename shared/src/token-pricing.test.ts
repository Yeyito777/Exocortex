import { describe, expect, test } from "bun:test";
import { claudeRequestCostUsd, estimateUncapturedCost, pricedModelProvider, resolveAnthropicApiPricing, resolveModelTokenPricing } from "./token-pricing";
import { createTokenUsageTotals, type TokenUsageTotals } from "./messages";

describe("model token pricing", () => {
  test("prices GPT-6 Sol/Luna independently of their older tiers", () => {
    for (const [model, input, output] of [
      ["gpt-6-sol", 2, 10],
      ["gpt-6-luna", 0.1, 0.5],
    ] as const) {
      expect(resolveModelTokenPricing(model)).toMatchObject({
        basisModel: model, inputUsdPerMillion: input, outputUsdPerMillion: output,
      });
      expect(resolveModelTokenPricing(model, { serviceTier: "fast", inputTokens: 272_001 })).toMatchObject({
        basisModel: model,
        rateClass: "fast-long",
        inputUsdPerMillion: input * 4,
        cachedInputUsdPerMillion: input * 4 / 10,
        cacheMissInputUsdPerMillion: input * 5,
        outputUsdPerMillion: output * 3,
      });
    }
  });

  test("uses exact published GPT-6 Astra standard, fast, and long-context rates", () => {
    expect(resolveModelTokenPricing("gpt-6-astra")).toEqual({
      provider: "openai",
      basisModel: "gpt-6-astra",
      serviceTier: "standard",
      rateClass: "standard",
      longContext: false,
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      cacheMissInputUsdPerMillion: 12.5,
      outputUsdPerMillion: 50,
    });
    expect(resolveModelTokenPricing("gpt-6-astra", {
      serviceTier: "fast",
      inputTokens: 272_001,
    })).toMatchObject({
      serviceTier: "fast",
      rateClass: "fast-long",
      longContext: true,
      inputUsdPerMillion: 40,
      cachedInputUsdPerMillion: 4,
      cacheMissInputUsdPerMillion: 50,
      outputUsdPerMillion: 150,
    });
  });

  test("uses exact published GPT-5.6 rates, including cache writes", () => {
    expect(resolveModelTokenPricing("gpt-5.6-sol")).toEqual({
      provider: "openai",
      basisModel: "gpt-5.6-sol",
      serviceTier: "standard",
      rateClass: "standard",
      longContext: false,
      inputUsdPerMillion: 4,
      cachedInputUsdPerMillion: 0.4,
      cacheMissInputUsdPerMillion: 5,
      outputUsdPerMillion: 20,
    });
    expect(resolveModelTokenPricing("gpt-5.6-terra")).toMatchObject({
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      cacheMissInputUsdPerMillion: 2.5,
      outputUsdPerMillion: 12,
    });
    expect(resolveModelTokenPricing("gpt-5.6-luna")).toMatchObject({
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      cacheMissInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 1.2,
    });
  });

  test("selects exact fast and long-context GPT-5.6 tables", () => {
    expect(resolveModelTokenPricing("gpt-5.6-terra", {
      serviceTier: "fast",
      inputTokens: 272_001,
    })).toMatchObject({
      serviceTier: "fast",
      rateClass: "fast-long",
      longContext: true,
      inputUsdPerMillion: 8,
      cachedInputUsdPerMillion: 0.8,
      cacheMissInputUsdPerMillion: 10,
      outputUsdPerMillion: 36,
    });
    expect(resolveModelTokenPricing("gpt-5.6-terra", {
      serviceTier: "fast",
      inputTokens: 272_000,
    })?.rateClass).toBe("fast");
  });

  test("prices documented aliases and snapshots without family inference", () => {
    expect(resolveModelTokenPricing("gpt-5.6")?.basisModel).toBe("gpt-5.6-sol");
    expect(resolveModelTokenPricing("gpt-daybreak-blue-latest")).toMatchObject({
      basisModel: "gpt-5.6-sol",
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 20,
    });
    expect(resolveModelTokenPricing("gpt-5.5-2026-04-23")).toMatchObject({
      basisModel: "gpt-5.5",
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
    });
    expect(resolveModelTokenPricing("gpt-5.4-mini-2026-03-17")?.basisModel).toBe("gpt-5.4-mini");
  });

  test("keeps exact GPT-5.5, GPT-5.4, and Codex model tables", () => {
    expect(resolveModelTokenPricing("gpt-5.5")).toMatchObject({
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheMissInputUsdPerMillion: 5,
      outputUsdPerMillion: 30,
    });
    expect(resolveModelTokenPricing("gpt-5.5-pro")).toMatchObject({
      inputUsdPerMillion: 30,
      cachedInputUsdPerMillion: 30,
      outputUsdPerMillion: 180,
    });
    expect(resolveModelTokenPricing("gpt-5.4")).toMatchObject({
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    });
    expect(resolveModelTokenPricing("gpt-5.4-pro")).toMatchObject({
      inputUsdPerMillion: 30,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 180,
    });
    expect(resolveModelTokenPricing("gpt-5.4-mini")).toMatchObject({
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5,
    });
    expect(resolveModelTokenPricing("gpt-5.4-nano")).toMatchObject({
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      outputUsdPerMillion: 1.25,
    });
    expect(resolveModelTokenPricing("gpt-5.3-codex", { serviceTier: "fast" })).toMatchObject({
      inputUsdPerMillion: 3.5,
      cachedInputUsdPerMillion: 0.35,
      outputUsdPerMillion: 28,
    });
  });

  test("does not invent rates for model families or unpublished tiers", () => {
    expect(resolveModelTokenPricing("gpt-6.1-mini")).toBeNull();
    expect(resolveModelTokenPricing("gpt-5.3-codex-spark")).toBeNull();
    expect(resolveModelTokenPricing("codex-next")).toBeNull();
    expect(resolveModelTokenPricing("gpt-5.5", { serviceTier: "fast" })).toBeNull();
    expect(resolveModelTokenPricing("unknown-model")).toBeNull();
  });

  test("preserves unpublished cache rates as null", () => {
    expect(resolveModelTokenPricing("gpt-5.5", { inputTokens: 272_001 })).toMatchObject({
      rateClass: "standard-long",
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: null,
      cacheMissInputUsdPerMillion: 10,
      outputUsdPerMillion: 45,
    });
  });

  test("uses DeepSeek's exact UTC peak and off-peak schedules", () => {
    const mondayPeak = Date.UTC(2026, 7, 24, 2, 0, 0);
    const mondayOffPeak = Date.UTC(2026, 7, 24, 5, 0, 0);
    expect(resolveModelTokenPricing("deepseek-v4-pro", { timestamp: mondayPeak })).toMatchObject({
      provider: "deepseek",
      rateClass: "peak",
      inputUsdPerMillion: 1.32,
      cachedInputUsdPerMillion: 0.044,
      outputUsdPerMillion: 3.96,
    });
    expect(resolveModelTokenPricing("deepseek-v4-pro", { timestamp: mondayOffPeak })).toMatchObject({
      rateClass: "off-peak",
      inputUsdPerMillion: 0.66,
      cachedInputUsdPerMillion: 0.022,
      outputUsdPerMillion: 1.98,
    });
  });

  test("records Ox Alpha's limited-time OpenCode price as zero", () => {
    expect(resolveModelTokenPricing("ox-alpha")).toMatchObject({
      provider: "opencode",
      basisModel: "ox-alpha",
      inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0,
      cacheMissInputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
    });
  });

  test("prices GPT-6.2 Sol, with Ultrafast at 3x Standard until March 2027 and 6x after", () => {
    expect(resolveModelTokenPricing("gpt-6.2-sol")).toMatchObject({
      provider: "openai", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, cacheMissInputUsdPerMillion: 2.5, outputUsdPerMillion: 10,
    });
    expect(resolveModelTokenPricing("gpt-6.2-sol", { inputTokens: 300_000 })).toMatchObject({
      inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, cacheMissInputUsdPerMillion: 5, outputUsdPerMillion: 15,
    });
    expect(resolveModelTokenPricing("gpt-6.2-sol", { serviceTier: "ultrafast", timestamp: Date.UTC(2026, 10, 27) })).toMatchObject({
      inputUsdPerMillion: 6, cachedInputUsdPerMillion: 0.3, cacheMissInputUsdPerMillion: 7.5, outputUsdPerMillion: 30,
    });
    expect(resolveModelTokenPricing("gpt-6.2-sol", { serviceTier: "ultrafast", timestamp: Date.UTC(2027, 2, 2) })).toMatchObject({
      inputUsdPerMillion: 12, outputUsdPerMillion: 60,
    });
    expect(resolveModelTokenPricing("gpt-6.1-sol", { serviceTier: "ultrafast" })).toMatchObject({ inputUsdPerMillion: 12, outputUsdPerMillion: 60 });
  });

  test("prices the Gemini API models at their paid-tier rates, with dated changes", () => {
    expect(resolveModelTokenPricing("gemini-4-neon")).toMatchObject({
      provider: "gemini", inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.15, cacheMissInputUsdPerMillion: 3, outputUsdPerMillion: 15,
    });
    expect(resolveModelTokenPricing("gemini-4-hydrogen")).toMatchObject({ inputUsdPerMillion: 1.5, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 7.5 });
    expect(resolveModelTokenPricing("gemini-4-carbon", { timestamp: Date.UTC(2026, 10, 27) })).toMatchObject({ inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
    expect(resolveModelTokenPricing("gemini-4-argon", { timestamp: Date.UTC(2026, 11, 2) })).toMatchObject({ inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 20 });
    expect(resolveModelTokenPricing("gemini-3.8-flash", { timestamp: Date.UTC(2026, 10, 27) })).toMatchObject({ inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75 });
    expect(resolveModelTokenPricing("gemini-3.8-flash", { timestamp: Date.UTC(2027, 0, 2) })).toMatchObject({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 });
  });

  test("bills the retired DeepSeek V4 Flash names at the current Flash price", () => {
    const mondayPeak = Date.UTC(2026, 10, 23, 2);
    expect(resolveModelTokenPricing("deepseek-v4-flash", { timestamp: mondayPeak })).toMatchObject({
      inputUsdPerMillion: 0.3, cachedInputUsdPerMillion: 0.006, outputUsdPerMillion: 1.2,
    });
    expect(resolveModelTokenPricing("deepseek-flash", { timestamp: Date.UTC(2026, 10, 22, 2) })).toMatchObject({
      rateClass: "off-peak", inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.003, outputUsdPerMillion: 0.6,
    });
  });
});

describe("Claude API pricing", () => {
  test("uses each model's published cache-hit multiplier", () => {
    expect(resolveAnthropicApiPricing("claude-sonnet-5-5")?.cacheReadUsdPerMillion).toBeCloseTo(0.1);
    expect(resolveAnthropicApiPricing("claude-sonnet-5")?.cacheReadUsdPerMillion).toBeCloseTo(0.2);
    expect(resolveAnthropicApiPricing("claude-opus-5-5")).toMatchObject({ inputUsdPerMillion: 4, outputUsdPerMillion: 20, cacheWrite5mUsdPerMillion: 5, cacheWrite1hUsdPerMillion: 8 });
    expect(resolveAnthropicApiPricing("claude-opus-5-5")?.cacheReadUsdPerMillion).toBeCloseTo(0.2);
    expect(resolveAnthropicApiPricing("claude-fable-5-2")?.cacheReadUsdPerMillion).toBeCloseTo(0.2);
    expect(resolveAnthropicApiPricing("claude-haiku-5-5", 100_001)).toMatchObject({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 });
  });

  test("prices fast mode with cache multipliers on top, and only where it is published", () => {
    const fast = resolveAnthropicApiPricing("claude-opus-5-5", 0, { speed: "fast" });
    expect(fast).toMatchObject({ speed: "fast", inputUsdPerMillion: 8, outputUsdPerMillion: 40, cacheWrite5mUsdPerMillion: 10, cacheWrite1hUsdPerMillion: 16 });
    expect(fast?.cacheReadUsdPerMillion).toBeCloseTo(0.4);
    expect(resolveAnthropicApiPricing("claude-fable-5-2", 0, { speed: "fast" })).toMatchObject({ inputUsdPerMillion: 16, outputUsdPerMillion: 80 });
    expect(resolveAnthropicApiPricing("claude-sonnet-5-5", 0, { speed: "fast" })).toBeNull();
  });

  test("costs one request from its fresh input, cache reads, and each TTL's writes", () => {
    const cost = claudeRequestCostUsd("claude-opus-5-5", {
      inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000, outputTokens: 1_000_000,
    });
    expect(cost?.inputUsd).toBeCloseTo(4 + 0.2 + 5 + 8);
    expect(cost?.outputUsd).toBeCloseTo(20);
  });
});

function usage(fields: Partial<TokenUsageTotals>): TokenUsageTotals {
  const totals = { ...createTokenUsageTotals(), ...fields };
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

describe("estimates for usage without a captured cost", () => {
  const NOV = Date.UTC(2026, 10, 20, 17);

  test("brackets old Claude totals whose misses mixed fresh input with cache writes of unknown TTL", () => {
    const estimate = estimateUncapturedCost("claude-opus-5-5", usage({
      inputTokens: 11_000_000, cachedInputTokens: 10_000_000, cacheMissInputTokens: 1_000_000, outputTokens: 100_000,
    }), NOV);
    // 10M reads at $0.20, 1M misses at $4 (fresh) to $8 (1-hour write), 100K output at $20.
    expect(estimate?.inputTokens).toBe(11_000_000);
    expect(estimate?.outputTokens).toBe(100_000);
    expect(estimate?.lowUsd).toBeCloseTo(2 + 4 + 2);
    expect(estimate?.highUsd).toBeCloseTo(2 + 8 + 2);
  });

  test("is exact where the stored categories settle the rate", () => {
    // Legacy GPT-5.5 totals: a non-hit residual costs ordinary input either way.
    const estimate = estimateUncapturedCost("gpt-5.5", usage({
      inputTokens: 3_000_000, cachedInputTokens: 2_000_000, unmeasuredInputTokens: 1_000_000, outputTokens: 1_000_000,
    }), Date.UTC(2026, 6, 1));
    expect(estimate?.lowUsd).toBeCloseTo(1 + 5 + 30);
    expect(estimate?.highUsd).toBeCloseTo(1 + 5 + 30);
  });

  test("adds nothing for tokens already captured, and nothing invented for unpriced models", () => {
    const captured = usage({ inputTokens: 100, uncachedInputTokens: 100, outputTokens: 10, pricedInputTokens: 100, pricedOutputTokens: 10, estimatedInputCostUsd: 1, estimatedOutputCostUsd: 1 });
    expect(estimateUncapturedCost("gpt-6-astra", captured, NOV)).toEqual({ inputTokens: 0, outputTokens: 0, lowUsd: 0, highUsd: 0 });
    expect(estimateUncapturedCost("gpt-5.3-codex-spark", usage({ inputTokens: 100, outputTokens: 10 }), NOV)).toBeNull();
  });

  test("names the provider whose price list has the model", () => {
    expect(pricedModelProvider("claude-opus-5-5")).toBe("anthropic");
    expect(pricedModelProvider("gemini-4-neon")).toBe("gemini");
    expect(pricedModelProvider("deepseek-v4-pro")).toBe("deepseek");
    expect(pricedModelProvider("gpt-6.2-sol")).toBe("openai");
    expect(pricedModelProvider("gpt-5.3-codex-spark")).toBeNull();
  });
});
