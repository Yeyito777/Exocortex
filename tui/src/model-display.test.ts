import { describe, expect, test } from "bun:test";
import { formatModelDisplayName } from "./messages";

describe("formatModelDisplayName", () => {
  test("formats OpenAI model ids by capitalizing the leading word", () => {
    expect(formatModelDisplayName("gpt-5.4")).toBe("Gpt-5.4");
    expect(formatModelDisplayName("gpt-5.4-mini")).toBe("Gpt-5.4-mini");
    expect(formatModelDisplayName("gpt-5.3-codex-spark")).toBe("Gpt-5.3-codex-spark");
  });

  test("formats Anthropic model ids into family-version labels", () => {
    expect(formatModelDisplayName("claude-opus-4-6")).toBe("Opus-4.6");
    expect(formatModelDisplayName("claude-sonnet-4-6")).toBe("Sonnet-4.6");
    expect(formatModelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku-4.5");
  });

  test("falls back to capitalizing the raw id when no special formatter applies", () => {
    expect(formatModelDisplayName("o3")).toBe("O3");
    expect(formatModelDisplayName("my.custom-model")).toBe("My.custom-model");
  });
});
