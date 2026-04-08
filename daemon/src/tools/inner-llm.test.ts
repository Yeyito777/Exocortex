import { describe, expect, test } from "bun:test";
import { DEFAULT_PROVIDER_ID } from "@exocortex/shared/messages";
import { isKnownModel } from "../providers/registry";
import { getInnerLlmSummaryOptions } from "./inner-llm";

describe("getInnerLlmSummaryOptions", () => {
  test("defaults to the app default provider", () => {
    const options = getInnerLlmSummaryOptions();
    expect(options.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(options.model).toBe("gpt-5.4-mini");
  });

  test("uses Anthropic's summary model when the conversation provider is anthropic", () => {
    expect(getInnerLlmSummaryOptions({ provider: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  test("uses OpenAI's summary model when the conversation provider is openai", () => {
    expect(getInnerLlmSummaryOptions({ provider: "openai" })).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
  });

  test("always chooses a model known to the selected provider", () => {
    for (const provider of ["openai", "anthropic"] as const) {
      const options = getInnerLlmSummaryOptions({ provider });
      expect(isKnownModel(provider, options.model)).toBe(true);
    }
  });
});
