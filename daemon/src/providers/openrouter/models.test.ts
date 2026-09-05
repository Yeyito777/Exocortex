import { describe, expect, test } from "bun:test";
import { FALLBACK_OPENROUTER_MODELS, parseOpenRouterModels } from "./models";
import { getDefaultModel, getProvider, supportsImageInputs } from "../registry";

describe("OpenRouter curated catalog", () => {
  test("registers Hermes 405B as the default and four chat-only picks", () => {
    expect(getDefaultModel("openrouter")).toBe("nousresearch/hermes-4-405b");
    expect(getProvider("openrouter")?.allowsCustomModels).toBe(false);
    expect(FALLBACK_OPENROUTER_MODELS).toHaveLength(4);
    for (const model of FALLBACK_OPENROUTER_MODELS) {
      expect(model.supportsTools).toBe(false);
      expect(supportsImageInputs("openrouter", model.id)).toBe(false);
    }
  });
  test("filters unavailable and unrelated models; reads capabilities conservatively", () => {
    const models = parseOpenRouterModels({ data: [
      { id: "unrelated/model" },
      { id: "nousresearch/hermes-4-405b", context_length: 64000, supported_parameters: ["reasoning", "tools"], architecture: { input_modalities: ["text"] } },
      { id: "thedrummer/cydonia-24b-v4.1", context_length: -1 },
    ] });
    expect(models.map((model) => model.id)).toEqual(["nousresearch/hermes-4-405b", "thedrummer/cydonia-24b-v4.1"]);
    expect(models[0]).toMatchObject({ maxContext: 64000, supportsTools: true, defaultEffort: "high" });
    expect(models[1]).toMatchObject({ maxContext: 131072, supportsTools: false, supportedEfforts: [], defaultEffort: "none" });
    expect(parseOpenRouterModels({ data: [] })).toEqual([]);
    expect(() => parseOpenRouterModels({})).toThrow("Invalid OpenRouter");
  });
});
