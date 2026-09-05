import { describe, expect, test } from "bun:test";
import { resolveModelTokenPricing } from "./token-pricing";

describe("model token pricing", () => {
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
});
