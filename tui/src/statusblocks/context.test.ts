import { describe, expect, test } from "bun:test";
import { stripAnsi } from "../historycursor";
import { createInitialState } from "../state";
import { contextBlock } from "./context";

function renderedContextValue(contextTokens: number | null): string {
  const state = createInitialState();
  state.contextTokens = contextTokens;
  return stripAnsi(contextBlock(state)?.rows[0] ?? "").trim();
}

describe("context status block", () => {
  test("renders unknown context as a question mark", () => {
    expect(renderedContextValue(null)).toBe("Context: ?");
  });

  test("keeps an explicitly known empty context at zero", () => {
    expect(createInitialState().contextTokens).toBe(0);
    expect(renderedContextValue(0)).toBe("Context: 0");
  });

  test("formats known nonzero context normally", () => {
    expect(renderedContextValue(12_345)).toBe("Context: 12,345");
  });
});
