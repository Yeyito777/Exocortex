import { describe, expect, test } from "bun:test";
import { configuredConversationDefaults } from "./config";
import { fastModeServiceTier, isFastMode } from "./messages";
import { resolveModelTokenPricing } from "./token-pricing";

describe("service tiers", () => {
  test("preserves old booleans and the explicit Ultrafast setting", () => {
    for (const mode of [false, true, "ultrafast"] as const) {
      expect(isFastMode(mode)).toBe(true);
      expect(configuredConversationDefaults({ defaults: { conversation: { fastMode: mode } } })?.fastMode).toBe(mode);
    }
    expect(isFastMode("priority")).toBe(false);
    expect(fastModeServiceTier(false)).toBeUndefined();
    expect(fastModeServiceTier(true)).toBe("fast");
    expect(fastModeServiceTier("ultrafast")).toBe("ultrafast");
  });

  test("uses verified GPT-6.1 Sol cached rates and long-context pricing", () => {
    expect(resolveModelTokenPricing("gpt-6.1-sol")).toMatchObject({
      inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1,
      cacheMissInputUsdPerMillion: 2.5, outputUsdPerMillion: 10,
    });
    expect(resolveModelTokenPricing("gpt-6.1-sol", { serviceTier: "fast", inputTokens: 272_001 })).toMatchObject({
      inputUsdPerMillion: 8, cachedInputUsdPerMillion: 0.4,
      cacheMissInputUsdPerMillion: 10, outputUsdPerMillion: 30,
    });
  });

  test("Ultrafast pricing never silently falls back to standard or fast", () => {
    expect(resolveModelTokenPricing("gpt-6-astra", { serviceTier: "ultrafast", inputTokens: 272_000 })).toMatchObject({
      serviceTier: "ultrafast", rateClass: "ultrafast", inputUsdPerMillion: 60,
      cachedInputUsdPerMillion: 6, cacheMissInputUsdPerMillion: 75, outputUsdPerMillion: 300,
    });
    expect(resolveModelTokenPricing("gpt-6-astra", { serviceTier: "ultrafast", inputTokens: 272_001 })).toMatchObject({
      rateClass: "ultrafast-long", inputUsdPerMillion: 120,
      cachedInputUsdPerMillion: 12, cacheMissInputUsdPerMillion: 150, outputUsdPerMillion: 450,
    });
    expect(resolveModelTokenPricing("gpt-6.1-sol", { serviceTier: "ultrafast" })).toBeNull();
    expect(resolveModelTokenPricing("gpt-5.6-sol", { serviceTier: "ultrafast" })).toBeNull();
  });
});
