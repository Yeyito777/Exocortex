import { afterEach, describe, expect, test } from "bun:test";
import { clearProviderAuth, saveProviderAuth } from "../store";
import { buildToolSystemHints, getToolDefs, getToolDisplayInfo } from "./registry";

function setOpenAIConfigured(configured: boolean): void {
  clearProviderAuth("openai");
  if (!configured) return;
  saveProviderAuth("openai", {
    tokens: {
      accessToken: "token-123",
      refreshToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
    },
    profile: null,
    updatedAt: new Date().toISOString(),
  });
}

afterEach(() => {
  clearProviderAuth("openai");
});

describe("tool availability", () => {
  test("hides generate_image when OpenAI auth is not configured", () => {
    setOpenAIConfigured(false);
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(buildToolSystemHints()).not.toContain("website frontends");
  });

  test("shows generate_image when OpenAI auth is configured", () => {
    setOpenAIConfigured(true);
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(true);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image" && tool.label === "Image")).toBe(true);
    expect(buildToolSystemHints()).toContain("website frontends");
  });
});
