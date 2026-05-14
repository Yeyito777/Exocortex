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

  test("falls back to capitalizing the raw id when no special formatter applies", () => {
    expect(formatModelDisplayName("o3")).toBe("O3");
    expect(formatModelDisplayName("my.custom-model")).toBe("My.custom-model");
  });
});
