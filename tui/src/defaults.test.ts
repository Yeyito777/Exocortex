import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, MAX_CONTEXT, normalizeEffortForModel } from "./messages";
import { clearPreferredProvider } from "./preferences";
import { createInitialState } from "./state";

describe("tui defaults", () => {
  beforeEach(() => {
    clearPreferredProvider();
  });
  test("starts without a chosen provider until the user picks or logs into one", () => {
    const state = createInitialState();

    expect(state.hasChosenProvider).toBe(false);
    expect(state.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(state.model).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
  });

  test("gpt-5.5 has a known context window for default-state UI fallbacks", () => {
    expect(MAX_CONTEXT[DEFAULT_MODEL_BY_PROVIDER.openai]).toBe(272_000);
  });

  test("gpt-5.5-style defaults normalize to high effort", () => {
    expect(normalizeEffortForModel({
      supportedEfforts: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      defaultEffort: "high",
    }, null)).toBe("high");
  });
});
