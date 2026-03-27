import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, normalizeEffortForModel } from "./messages";
import { createInitialState } from "./state";

describe("tui defaults", () => {
  test("starts on the shared default provider and model", () => {
    const state = createInitialState();

    expect(state.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(state.model).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
  });

  test("gpt-5.4 normalizes to high effort by default", () => {
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
