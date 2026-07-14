import { describe, expect, test } from "bun:test";
import { resolveModelTokenPricing } from "./token-pricing";

describe("model token pricing", () => {
  test("automatically prices GPT-5.6 tiers from the OpenAI family fallback", () => {
    expect(resolveModelTokenPricing("gpt-5.6-sol")).toEqual({
      provider: "openai",
      basisModel: "gpt-5.4",
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    });
    expect(resolveModelTokenPricing("gpt-5.6-terra")?.basisModel).toBe("gpt-5.4");
    expect(resolveModelTokenPricing("gpt-5.6-luna")?.basisModel).toBe("gpt-5.4");
  });

  test("uses variant overrides before provider defaults", () => {
    expect(resolveModelTokenPricing("gpt-6.1-mini")).toMatchObject({
      provider: "openai",
      basisModel: "gpt-5.4-mini",
      inputUsdPerMillion: 0.75,
      outputUsdPerMillion: 4.5,
    });
    expect(resolveModelTokenPricing("gpt-5.3-codex-spark")).toMatchObject({
      basisModel: "gpt-5.3-codex",
      inputUsdPerMillion: 1.75,
      outputUsdPerMillion: 14,
    });
    expect(resolveModelTokenPricing("deepseek-v5-flash")?.basisModel).toBe("deepseek-v4-flash");
  });

  test("inherits provider pricing for arbitrary newly advertised model ids", () => {
    expect(resolveModelTokenPricing("codex-next", [{
      id: "openai",
      models: [{ id: "codex-next" }],
    }])).toMatchObject({
      provider: "openai",
      basisModel: "gpt-5.4",
    });
  });

  test("leaves models with no provider association explicitly unpriced", () => {
    expect(resolveModelTokenPricing("unknown-model")).toBeNull();
  });
});
