import { describe, expect, test } from "bun:test";
import { renderMetadata } from "./metadata";

describe("renderMetadata", () => {
  test("renders formatted provider model names", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 4_000,
      model: "deepseek-v4-pro",
      tokens: 123,
    });

    expect(line).toContain("DeepSeek V4 Pro | 123 tokens | 3s");
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

  test("renders formatted DeepSeek model names with spaces", () => {
    const [line] = renderMetadata({
      startedAt: 1_000,
      endedAt: 3_000,
      model: "deepseek-v4-pro",
      tokens: 42,
    });

    expect(line).toContain("DeepSeek V4 Pro | 42 tokens | 2s");
  });

  test("renders minutes and seconds", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 42 tokens | 23m 2s");
  });

  test("renders hours", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 60 * 60 + 2 * 60 + 3) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 42 tokens | 1h 2m 3s");
  });

  test("renders days", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (1 * 24 * 60 * 60 + 2 * 60 * 60 + 3 * 60 + 4) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 42 tokens | 1d 2h 3m 4s");
  });

  test("renders weeks", () => {
    const [line] = renderMetadata({
      startedAt: 0,
      endedAt: (2 * 7 * 24 * 60 * 60 + 1 * 24 * 60 * 60 + 23 * 60 * 60 + 23 * 60 + 2) * 1000,
      model: "gpt-5.4",
      tokens: 42,
    });

    expect(line).toContain("Gpt-5.4 | 42 tokens | 2w 1d 23h 23m 2s");
  });
});
