import { describe, expect, test } from "bun:test";
import { renderMetadata } from "./metadata";

describe("renderMetadata", () => {
  test("renders formatted Anthropic model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 4_000,
      model: "claude-opus-4-6",
      tokens: 123,
    });

    expect(line).toContain("Opus-4.6 | 123 tokens | 3s");
  });

  test("renders formatted OpenAI model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "gpt-5.4-mini",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4-mini | 42 tokens | 2s");
  });
});
