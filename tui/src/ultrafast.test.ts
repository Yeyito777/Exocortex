import { afterEach, expect, test } from "bun:test";
import { clearConversationDefaults, configuredConversationDefaults } from "@exocortex/shared/config";
import { tryCommand } from "./commands";
import { applyProviderModelSelection } from "./commands/shared";
import { applyInlineCommands, getInlineCommandArgs } from "./inlineeffort";
import { createInitialState } from "./state";

afterEach(clearConversationDefaults);

function stateWithUltrafast(available: boolean) {
  const state = createInitialState();
  state.provider = "openai";
  state.model = "gpt-6-astra";
  state.convId = "ultrafast-test";
  state.providerRegistry = [{
    id: "openai", label: "OpenAI", defaultModel: state.model,
    allowsCustomModels: false, supportsFastMode: true,
    models: ["gpt-6-astra", "gpt-6.1-sol"].map(id => ({
      id, label: id, maxContext: 272_000, defaultEffort: "low",
      supportedEfforts: [{ effort: "low", description: "Low" }],
      supportsFastMode: true, supportsUltrafastMode: id === "gpt-6-astra" && available,
    })),
  }];
  return state;
}

test("Ultrafast selection is explicit, distinct, and can be switched off", () => {
  const state = stateWithUltrafast(true);
  expect(tryCommand("/fast ultrafast", state)).toEqual({ type: "fast_mode_changed", enabled: "ultrafast" });
  expect(state.fastMode).toBe("ultrafast");
  expect(tryCommand("/fast on", state)).toEqual({ type: "fast_mode_changed", enabled: true });
  expect(tryCommand("/fast off", state)).toEqual({ type: "fast_mode_changed", enabled: false });
});

test("unadvertised Ultrafast is rejected without changing Fast", () => {
  const state = stateWithUltrafast(false);
  state.fastMode = true;
  expect(tryCommand("/fast ultrafast", state)).toEqual({ type: "handled" });
  expect(state.fastMode).toBe(true);
  expect(state.messages.at(-1)).toMatchObject({ text: "Ultrafast is not advertised for this model/account." });
  expect(getInlineCommandArgs(state)["/fast"].some(item => item.name === "ultrafast")).toBe(false);
});

test("inline Ultrafast strips the entire command and preserves the selected tier", () => {
  const state = stateWithUltrafast(true);
  expect(applyInlineCommands("please /fast ultrafast answer", state)).toEqual({
    text: "please answer", efforts: [], fastModes: ["ultrafast"],
  });
  expect(state.fastMode).toBe("ultrafast");
  expect(getInlineCommandArgs(state)["/fast"].some(item => item.name === "ultrafast")).toBe(true);
  applyProviderModelSelection(state, "openai", "gpt-6.1-sol");
  expect(state.fastMode).toBe(false);
});

test("default-model persists Ultrafast only for advertised models", () => {
  const state = stateWithUltrafast(true);
  tryCommand("/default-model openai gpt-6-astra low ultrafast", state);
  expect(configuredConversationDefaults()?.fastMode).toBe("ultrafast");
  tryCommand("/default-model openai gpt-6.1-sol low ultrafast", state);
  expect(configuredConversationDefaults()?.model).toBe("gpt-6-astra");
});
