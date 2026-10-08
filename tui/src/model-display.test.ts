import { describe, expect, test } from "bun:test";
import { formatModelDisplayName } from "./messages";

describe("formatModelDisplayName", () => {
  test("formats OpenAI model ids by capitalizing the leading word", () => {
    expect(formatModelDisplayName("gpt-5.4")).toBe("Gpt-5.4");
    expect(formatModelDisplayName("gpt-5.4-mini")).toBe("Gpt-5.4-mini");
    expect(formatModelDisplayName("gpt-5.3-codex-spark")).toBe("Gpt-5.3-codex-spark");
  });

  test("formats DeepSeek model ids into provider-version labels", () => {
    expect(formatModelDisplayName("deepseek-v4-pro")).toBe("DeepSeek V4 Pro");
    expect(formatModelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
  });

  test("formats Claude model ids as family-version", () => {
    expect(formatModelDisplayName("claude-opus-5-5")).toBe("Opus-5.5");
    expect(formatModelDisplayName("claude-fable-5-1")).toBe("Fable-5.1");
    expect(formatModelDisplayName("claude-sonnet-5-5-20260901")).toBe("Sonnet-5.5");
    expect(formatModelDisplayName("claude-opus-5-5[1m]")).toBe("Opus-5.5");
    expect(formatModelDisplayName("claude-haiku-5-20260901")).toBe("Haiku-5");
  });

  test("formats the canonical Ox Alpha model id", () => {
    expect(formatModelDisplayName("ox-alpha")).toBe("Ox Alpha");
  });

  test("formats the GPT-6 Astra model id like the Codex catalog", () => {
    expect(formatModelDisplayName("gpt-6-astra")).toBe("GPT-6-Astra");
  });

  test("formats the hidden Daybreak Blue model id", () => {
    expect(formatModelDisplayName("gpt-daybreak-blue-latest")).toBe("Daybreak Blue");
  });

  test("falls back to capitalizing the raw id when no special formatter applies", () => {
    expect(formatModelDisplayName("o3")).toBe("O3");
    expect(formatModelDisplayName("my.custom-model")).toBe("My.custom-model");
  });
});
