import { afterEach, describe, expect, test } from "bun:test";
import { clearConversationDefaults, effectiveConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { assertDelegationModel, isLegacyDelegationModel, latestSizeModel, parseRequestedModel, resolveDelegationModel } from "./delegation-models";

afterEach(() => clearConversationDefaults());

describe("delegation model policy", () => {
  test("resolves numeric generations per size, not catalog order or a hardcoded family", () => {
    const models = ["gpt-6.9-sol", "gpt-5.6-terra", "gpt-6.10-sol", "gpt-7-astra", "gpt-6-astra", "gpt-5.6-sol", "gpt-10-luna", "gpt-9-luna"];
    expect(latestSizeModel("sol", models)).toBe("gpt-6.10-sol");
    expect(latestSizeModel("astra", models)).toBe("gpt-7-astra");
    expect(latestSizeModel("terra", models)).toBe("gpt-5.6-terra");
    expect(latestSizeModel("luna", models)).toBe("gpt-10-luna");
    expect(latestSizeModel("terra", [])).toBeUndefined();
    expect(isLegacyDelegationModel("openai", "gpt-6.9-sol", models)).toBe(true);
    expect(isLegacyDelegationModel("openai", "gpt-5.6-terra", models)).toBe(false);
    expect(isLegacyDelegationModel("openai", "gpt-5.4", models)).toBe(true);
  });

  test("uses the configured default and effort, upgrading only an implicit outdated size", () => {
    const saved = { provider: "openai" as const, model: "gpt-5.6-sol", effort: "xhigh" as const, fastMode: true };
    saveConversationDefaults(saved);
    expect(resolveDelegationModel({})).toEqual({ ...saved, model: "gpt-6.1-sol" });
    expect(effectiveConversationDefaults()).toEqual(saved);
    expect(resolveDelegationModel({ legacy: true })).toEqual(saved);
    expect(() => resolveDelegationModel({ model: saved.model })).toThrow("legacy:true");
    expect(resolveDelegationModel({ model: saved.model, legacy: true })).toEqual(saved);
    expect(resolveDelegationModel({ effort: "low" }).effort).toBe("low");
    saveConversationDefaults({ ...saved, model: "gpt-6-astra", effort: "xhigh" });
    expect(resolveDelegationModel({})).toMatchObject({ model: "gpt-6-astra", effort: "xhigh" });
  });

  test("normalizes configured effort after promotion and respects other providers", () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.6-sol", effort: "minimal", fastMode: false });
    expect(resolveDelegationModel({}).effort).toBe("low");
    saveConversationDefaults({ provider: "deepseek", model: "deepseek-v4-pro", effort: "high", fastMode: false });
    expect(resolveDelegationModel({})).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", effort: "high" });
    expect(resolveDelegationModel({ model: "ASTRA" })).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
  });

  test("aliases remain latest even with legacy opt-in; never invent a missing size", () => {
    for (const [alias, model] of [["astra", "gpt-6-astra"], ["sol", "gpt-6.1-sol"], ["terra", "gpt-5.6-terra"], ["luna", "gpt-6-luna"]]) {
      expect(parseRequestedModel(undefined, `openai/${alias.toUpperCase()}`)).toEqual({ provider: "openai", model });
      expect(resolveDelegationModel({ model: alias, legacy: true }).model).toBe(model);
    }
    expect(() => resolveDelegationModel({ model: "gpt-6-terra" })).toThrow("Unknown model");
    expect(() => parseRequestedModel("deepseek", "openai/astra")).toThrow("conflicts");
  });

  test("unsized older defaults fail rather than silently changing size or using legacy", () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false });
    expect(() => resolveDelegationModel({})).toThrow("legacy:true");
    expect(resolveDelegationModel({ legacy: true }).model).toBe("gpt-5.4");
    expect(() => assertDelegationModel("openai", "gpt-5.6-luna")).toThrow("gpt-6-luna");
    expect(() => resolveDelegationModel({ legacy: "true" as never })).toThrow("boolean");
  });
});
