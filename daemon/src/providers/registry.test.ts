import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "@exocortex/shared/messages";
import { canonicalizeModel, getDefaultModel, getDefaultProvider, getModelInfo, getProvider, hasProvider, isKnownModel, normalizeEffort, supportsImageInputs } from "./registry";

describe("provider registry defaults", () => {
  test("prefers the shared default provider", () => {
    expect(getDefaultProvider().id).toBe(DEFAULT_PROVIDER_ID);
  });

  test("uses the shared default models", () => {
    expect(getDefaultModel("openai")).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
    expect(getDefaultModel("deepseek")).toBe(DEFAULT_MODEL_BY_PROVIDER.deepseek);
    expect(getDefaultModel("opencode")).toBe(DEFAULT_MODEL_BY_PROVIDER.opencode);
  });

  test("tracks per-model image input support", () => {
    expect(supportsImageInputs("openai", "gpt-6-astra")).toBe(true);
    expect(supportsImageInputs("openai", "gpt-5.5")).toBe(true);
    expect(supportsImageInputs("openai", "gpt-5.3-codex-spark")).toBe(false);
    expect(supportsImageInputs("deepseek", "deepseek-v4-pro")).toBe(false);
    expect(supportsImageInputs("opencode", "ox-alpha")).toBe(true);
  });

  test("keeps OpenCode's upstream preview id behind the provider boundary", () => {
    expect(canonicalizeModel("opencode", "ox")).toBe("ox-alpha");
    expect(canonicalizeModel("opencode", "ox-alpha")).toBe("ox-alpha");
    expect(isKnownModel("opencode", "x-preview-f-free")).toBe(false);
  });
});

describe("provider registry lookups", () => {
  test("hands out copies, so callers cannot corrupt the shared catalog", () => {
    const provider = getProvider("openai")!;
    const model = getModelInfo("openai", DEFAULT_MODEL_BY_PROVIDER.openai)!;
    provider.models.length = 0;
    provider.defaultModel = "mutated";
    model.supportedEfforts = [];
    model.defaultEffort = "mutated" as never;

    expect(getProvider("openai")!.models.length).toBeGreaterThan(0);
    expect(getDefaultModel("openai")).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
    expect(getModelInfo("openai", DEFAULT_MODEL_BY_PROVIDER.openai)!.defaultEffort).not.toBe("mutated");
    expect(normalizeEffort("openai", DEFAULT_MODEL_BY_PROVIDER.openai, undefined)).not.toBe("mutated");
  });

  test("answers existence checks without a catalog copy", () => {
    expect(hasProvider("openai")).toBe(true);
    expect(hasProvider("not-a-provider" as never)).toBe(false);
  });
});
