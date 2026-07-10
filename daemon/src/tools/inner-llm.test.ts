import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_ID } from "@exocortex/shared/messages";
import { allowsCustomModels, isKnownModel } from "../providers/registry";
import { getInnerLlmSummaryOptions } from "./inner-llm";

describe("getInnerLlmSummaryOptions", () => {
  test("defaults to the app default provider", () => {
    const options = getInnerLlmSummaryOptions();
    expect(options.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(options.model).toBe("gpt-5.6-terra");
    expect(options.effort).toBe("none");
  });

  test("uses OpenAI's Terra summary model on the fast tier with no reasoning", () => {
    expect(getInnerLlmSummaryOptions({ provider: "openai" })).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "none",
      preferHttp: true,
      serviceTier: "fast",
    });
  });

  test("uses DeepSeek's flash model with thinking disabled when the conversation provider is deepseek", () => {
    expect(getInnerLlmSummaryOptions({ provider: "deepseek" })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      effort: "none",
      preferHttp: false,
    });
  });

  test("always chooses a known model or a custom model for providers that allow custom ids", () => {
    for (const provider of ["openai", "deepseek"] as const) {
      const options = getInnerLlmSummaryOptions({ provider });
      expect(isKnownModel(provider, options.model) || allowsCustomModels(provider)).toBe(true);
    }
  });
});
