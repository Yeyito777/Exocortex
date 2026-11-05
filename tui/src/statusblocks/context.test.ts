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

  test("formats every count exactly as toLocaleString(\"en-US\")", () => {
    expect(renderedContextValue(999)).toBe("Context: 999");
    expect(renderedContextValue(1_000)).toBe("Context: 1,000");
    expect(renderedContextValue(1_048_576)).toBe("Context: 1,048,576");
    expect(renderedContextValue(2_000_000_000)).toBe("Context: 2,000,000,000");
    for (const tokens of [1, 7, 42, 999, 1_000, 9_999, 10_000, 123_456, 272_000, 1_000_000, 12_345_678, 1_234_567_890]) {
      expect(renderedContextValue(tokens)).toBe(`Context: ${tokens.toLocaleString("en-US")}`);
    }
    const state = createInitialState();
    state.providerRegistry = [{ id: state.provider, label: "Provider", models: [{ id: state.model, label: "Model", maxContext: 1_050_000 }] }] as typeof state.providerRegistry;
    expect(stripAnsi(contextBlock(state)?.rows[1] ?? "").trim()).toBe("Max Context: 1,050,000");
  });
});
