import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, MAX_CONTEXT, defaultEffortForModelId, normalizeEffortForModel } from "./messages";
import { clearPreferredProvider, savePreferredProvider } from "./preferences";
import { createInitialState, newConversationSelection, resetNewConversationDefaults } from "./state";
import { receiveConversationDefaults } from "./events/conversation-defaults";

describe("tui defaults", () => {
  beforeEach(() => {
    clearPreferredProvider();
    clearConversationDefaults();
  });
  afterEach(() => { clearPreferredProvider(); clearConversationDefaults(); });
  test("uses only a temporary fallback until the daemon supplies its defaults", () => {
    const state = createInitialState();

    expect(state.hasChosenProvider).toBe(false);
    expect(state.provider).toBe(DEFAULT_PROVIDER_ID);
    expect(state.model).toBe(DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    expect(newConversationSelection(state)).toEqual({});
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

  test("does not use TUI-host defaults or a locally saved provider", () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.4", effort: "high", fastMode: true });
    savePreferredProvider("deepseek");

    const state = createInitialState();

    expect(state.conversationDefaults).toBeNull();
    expect(state.hasChosenProvider).toBe(false);
    expect(state.model).toBe(DEFAULT_MODEL_BY_PROVIDER.openai);
    expect(state.fastMode).toBe(false);
  });

  test("bootstrap and new-conversation reset use the daemon's cached defaults", () => {
    const state = createInitialState();
    receiveConversationDefaults(state, {
      configured: true,
      defaults: { provider: "deepseek", model: "deepseek-v4-flash", effort: "max", fastMode: false },
    });
    expect(state.model).toBe("deepseek-v4-flash");
    expect(newConversationSelection(state)).toEqual(state.conversationDefaults!.defaults);
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

  test("refreshes the cache without changing a focused conversation or edited draft", () => {
    const state = createInitialState();
    const snapshot = {
      configured: true,
      defaults: { provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false },
    } as const;
    state.convId = "focused";
    state.model = "focused-model";
    receiveConversationDefaults(state, snapshot, true);
    expect(state.model).toBe("focused-model");
    expect(state.conversationDefaults).toEqual(snapshot);
    state.convId = null;
    state.hasChosenProvider = true;
    receiveConversationDefaults(state, snapshot);
    expect(state.model).toBe("focused-model");
    receiveConversationDefaults(state, snapshot, true);
    expect(state.model).toBe("deepseek-v4-pro");
  });

  test("broadcast changes update unedited drafts immediately", () => {
    const state = createInitialState();
    receiveConversationDefaults(state, {
      configured: true,
      defaults: { provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false },
    });
    receiveConversationDefaults(state, {
      configured: true,
      defaults: { provider: "deepseek", model: "deepseek-v4-flash", effort: "high", fastMode: false },
    });
    expect(state.model).toBe("deepseek-v4-flash");
    expect(state.effort).toBe("high");
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
    expect(defaultEffortForModelId("openai", "gpt-6-sol")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-6-luna")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-sol")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-terra")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.6-luna")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5")).toBe("medium");
    expect(defaultEffortForModelId("openai", "gpt-5.5-pro")).toBe("medium");
  });
});
