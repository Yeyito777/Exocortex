import { describe, expect, test } from "bun:test";
import { sanitizeGeneratedTitle } from "./titlegen";

describe("sanitizeGeneratedTitle", () => {
  test("keeps decimal points in model names", () => {
    expect(sanitizeGeneratedTitle("exo gpt 5.5 support")).toBe("exo gpt 5.5 support");
    expect(sanitizeGeneratedTitle("exo gpt-5.5 support")).toBe("exo gpt-5.5 support");
  });

  test("strips sentence punctuation periods and quotes", () => {
    expect(sanitizeGeneratedTitle('"context tool."')).toBe("context tool");
  });
});
