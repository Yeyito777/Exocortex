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

  test("GPT-6 Astra has a known Codex context window for default-state UI fallbacks", () => {
    expect(MAX_CONTEXT[DEFAULT_MODEL_BY_PROVIDER.openai]).toBe(272_000);
  });

  test("GPT-6 Astra defaults normalize to low effort", () => {
    expect(normalizeEffortForModel({
      supportedEfforts: [
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
      defaultEffort: "low",
    }, null)).toBe("low");
  });

  test("fallback default effort follows the OpenAI model tier", () => {
    expect(defaultEffortForModelId("openai", "gpt-6-astra")).toBe("low");
    expect(defaultEffortForModelId("openai", "gpt-5.6-sol")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-terra")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-luna")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5-pro")).toBe("medium");
  });
});
