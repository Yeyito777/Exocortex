import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "@exocortex/shared/messages";
import { getDefaultModel, getDefaultProvider, supportsImageInputs } from "./registry";

describe("provider registry defaults", () => {
  test("prefers the shared default provider", () => {
    expect(getDefaultProvider().id).toBe(DEFAULT_PROVIDER_ID);
  });

  test("uses the shared default openai model", () => {
    expect(getDefaultModel("openai")).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
  });

  test("tracks per-model image input support", () => {
    expect(supportsImageInputs("openai", "gpt-5.5")).toBe(true);
    expect(supportsImageInputs("openai", "gpt-5.3-codex-spark")).toBe(false);
    expect(supportsImageInputs("anthropic", "claude-opus-4-6")).toBe(true);
  });
});
