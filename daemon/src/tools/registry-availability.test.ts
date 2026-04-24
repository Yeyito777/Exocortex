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
  test("hides OpenAI-backed tools when OpenAI auth is not configured", () => {
    setOpenAIConfigured(false);
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDefs().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image")).toBe(false);
    expect(getToolDisplayInfo().some((tool) => tool.name === "transcribe_audio")).toBe(false);
    expect(buildToolSystemHints()).not.toContain("Use image generation to create assets");
    expect(buildToolSystemHints()).not.toContain("Use audio transcription");
  });

  test("shows OpenAI-backed tools when OpenAI auth is configured", () => {
    setOpenAIConfigured(true);
    expect(getToolDefs().some((tool) => tool.name === "generate_image")).toBe(true);
    expect(getToolDefs().some((tool) => tool.name === "transcribe_audio")).toBe(true);
    expect(getToolDisplayInfo().some((tool) => tool.name === "generate_image" && tool.label === "Image")).toBe(true);
    expect(getToolDisplayInfo().some((tool) => tool.name === "transcribe_audio" && tool.label === "Transcribe" && tool.color === "#f2fa9c")).toBe(true);
    expect(buildToolSystemHints()).toContain("Use image generation to create assets when you need them");
    expect(buildToolSystemHints()).toContain("Use audio transcription when you need to understand spoken content in an audio file.");
  });
});
