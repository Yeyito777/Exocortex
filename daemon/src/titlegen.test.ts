import { describe, expect, test } from "bun:test";
import { sanitizeGeneratedTitle, titleModelForProvider } from "./titlegen";

describe("titleModelForProvider", () => {
  test("uses GPT-5.6 Luna for OpenAI titles, not the unsupported mini model", () => {
    expect(titleModelForProvider("openai")).toBe("gpt-5.6-luna");
  });

  test("keeps other providers on their own title models", () => {
    expect(titleModelForProvider("deepseek")).toBe("deepseek-v4-flash");
    expect(titleModelForProvider("opencode")).toBe("ox-alpha");
    expect(titleModelForProvider("openrouter")).toBe("nousresearch/hermes-4-70b");
  });
});

describe("sanitizeGeneratedTitle", () => {
  test("keeps decimal points in model names", () => {
    expect(sanitizeGeneratedTitle("exo gpt 5.5 support")).toBe("exo gpt 5.5 support");
    expect(sanitizeGeneratedTitle("exo gpt-5.5 support")).toBe("exo gpt-5.5 support");
  });

  test("strips sentence punctuation periods and quotes", () => {
    expect(sanitizeGeneratedTitle('"context tool."')).toBe("context tool");
  });
});
