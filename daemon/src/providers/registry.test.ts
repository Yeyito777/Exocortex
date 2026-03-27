import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "@exocortex/shared/messages";
import { getDefaultModel, getDefaultProvider } from "./registry";

describe("provider registry defaults", () => {
  test("prefers the shared default provider", () => {
    expect(getDefaultProvider().id).toBe(DEFAULT_PROVIDER_ID);
  });

  test("uses the shared default openai model", () => {
    expect(getDefaultModel("openai")).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
  });
});
