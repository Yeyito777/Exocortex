import { beforeEach, describe, expect, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, MAX_CONTEXT, defaultEffortForModelId, normalizeEffortForModel } from "./messages";
import { clearPreferredProvider } from "./preferences";
import { createInitialState, resetNewConversationDefaults } from "./state";

describe("tui defaults", () => {
  beforeEach(() => {
    clearPreferredProvider();
    clearConversationDefaults();
  });
  test("starts without a chosen provider until the user picks or logs into one", () => {
    const state = createInitialState();

    expect(state.hasChosenProvider).toBe(false);
    expect(state.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(state.model).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
  });

  test("new-conversation reset ignores focused conversation settings", () => {
    const state = createInitialState();
    state.provider = "deepseek";
    state.model = "deepseek-v4-pro";
    state.effort = "max";
    state.fastMode = true;

    resetNewConversationDefaults(state);

    expect(String(state.provider)).toBe(DEFAULT_PROVIDER_ID);
    expect(String(state.model)).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    expect(String(state.effort)).toBe(defaultEffortForModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]));
    expect(state.fastMode).toBe(false);
  });

  test("starts from saved conversation defaults when configured", () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.4", effort: "high", fastMode: true });

    const state = createInitialState();

    expect(state.hasChosenProvider).toBe(true);
    expect(String(state.provider)).toBe("openai");
    expect(String(state.model)).toBe("gpt-5.4");
    expect(String(state.effort)).toBe("high");
    expect(state.fastMode).toBe(true);
  });

  test("new-conversation reset uses saved conversation defaults", () => {
    saveConversationDefaults({ provider: "deepseek", model: "deepseek-v4-flash", effort: "max", fastMode: false });
    const state = createInitialState();
    state.provider = "openai";
    state.model = "gpt-5.4";
    state.effort = "low";
    state.fastMode = true;

    resetNewConversationDefaults(state);

    expect(String(state.provider)).toBe("deepseek");
    expect(String(state.model)).toBe("deepseek-v4-flash");
    expect(String(state.effort)).toBe("max");
    expect(state.fastMode).toBe(false);
    expect(state.hasChosenProvider).toBe(true);
  });

  test("gpt-5.6 Sol has a known context window for default-state UI fallbacks", () => {
    expect(MAX_CONTEXT[DEFAULT_MODEL_BY_PROVIDER.openai]).toBe(372_000);
  });

  test("gpt-5.6-style defaults normalize to medium effort", () => {
    expect(normalizeEffortForModel({
      supportedEfforts: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      defaultEffort: "medium",
    }, null)).toBe("medium");
  });

  test("fallback default effort is medium for gpt-5.6 and gpt-5.5-family OpenAI models", () => {
    expect(defaultEffortForModelId("openai", "gpt-5.6-sol")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-terra")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-luna")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5-pro")).toBe("medium");
  });
});
