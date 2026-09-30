import { afterEach, expect, test } from "bun:test";
import { clearConversationDefaults, configuredConversationDefaults } from "@exocortex/shared/config";
import { getCommandArgs, tryCommand } from "./commands";
import { applyProviderModelSelection } from "./commands/shared";
import { applyInlineCommands, getInlineCommandArgs, previewInlineCommands } from "./inlineeffort";
import { createInitialState } from "./state";
import { getPromptHighlightRanges, highlightPromptInput } from "./prompthighlight";
import { updateAutocomplete } from "./autocomplete";
import { theme } from "./theme";

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
  expect(tryCommand("/ultrafast", state)).toEqual({ type: "fast_mode_changed", enabled: "ultrafast" });
  expect(state.fastMode).toBe("ultrafast");
  expect(tryCommand("/ultrafast", state)).toEqual({ type: "fast_mode_changed", enabled: false });
  expect(tryCommand("/ultrafast on", state)).toEqual({ type: "fast_mode_changed", enabled: "ultrafast" });
  expect(tryCommand("/ultrafast off", state)).toEqual({ type: "fast_mode_changed", enabled: false });
  expect(tryCommand("/fast on", state)).toEqual({ type: "fast_mode_changed", enabled: true });
  expect(tryCommand("/fast off", state)).toEqual({ type: "fast_mode_changed", enabled: false });
});

test("unadvertised Ultrafast is rejected without changing Fast", () => {
  const state = stateWithUltrafast(false);
  state.fastMode = true;
  expect(tryCommand("/ultrafast", state)).toEqual({ type: "handled" });
  expect(state.fastMode).toBe(true);
  expect(state.messages.at(-1)).toMatchObject({ text: "Ultrafast is not advertised for this model/account." });
  expect(getInlineCommandArgs(state)["/fast"].some(item => item.name === "ultrafast")).toBe(false);
});

test("inline Ultrafast strips the entire command and preserves the selected tier", () => {
  const state = stateWithUltrafast(true);
  expect(applyInlineCommands("please /ultrafast answer", state)).toEqual({
    text: "please answer", efforts: [], fastModes: ["ultrafast"],
  });
  expect(state.fastMode).toBe("ultrafast");
  expect(getInlineCommandArgs(state)["/ultrafast"].map(item => item.name)).toEqual(["on", "off"]);
  applyProviderModelSelection(state, "openai", "gpt-6.1-sol");
  expect(state.fastMode).toBe(false);
});

test("speed commands followed by prompts reach the inline parser, including one-word prompts", () => {
  for (const command of ["/fast", "/ultrafast"]) {
    const state = stateWithUltrafast(true);
    for (const input of [`${command} hello`, `${command} on hello there`]) {
      expect(tryCommand(input, state)).toBeNull();
      expect(previewInlineCommands(input, state).text).toBe(input.endsWith("there") ? "hello there" : "hello");
    }
  }
});

test("speed commands switch tiers rather than disabling a different tier", () => {
  const state = stateWithUltrafast(true);
  state.fastMode = true;
  expect(applyInlineCommands("/ultrafast answer /fast", state).fastModes).toEqual(["ultrafast", true]);
  expect(state.fastMode).toBe(true);
});

test("unavailable inline Ultrafast blocks the prompt without partial setting changes", () => {
  const state = stateWithUltrafast(false);
  state.fastMode = false;
  const input = "please /fast on /ultrafast on answer";
  expect(applyInlineCommands(input, state)).toEqual({
    text: input, efforts: [], fastModes: [], error: "Ultrafast is not advertised for this model/account.",
  });
  expect(state.fastMode).toBe(false);
});

test("Ultrafast syntax highlights and completes consistently regardless of entitlement", () => {
  for (const available of [false, true]) {
    const state = stateWithUltrafast(available);
    expect(getCommandArgs(state)["/ultrafast"]).toEqual(getInlineCommandArgs(state)["/ultrafast"]);
    expect(getCommandArgs(state)["/fast"].map(item => item.name)).toEqual(["on", "off"]);
    const input = "please /ultrafast ON answer /fast off now";
    expect(getPromptHighlightRanges(state, input)).toEqual([{ start: 7, end: 20 }, { start: 28, end: 37 }]);
    expect(highlightPromptInput(state, [input], input, 120, 0)).toEqual([
      `please ${theme.command}/ultrafast ON${theme.reset} answer ${theme.command}/fast off${theme.reset} now`,
    ]);
    state.inputBuffer = "please /ultraf";
    state.cursorPos = state.inputBuffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches.map(item => item.name)).toEqual(["/ultrafast"]);
    state.inputBuffer = "please /ultrafast o";
    state.cursorPos = state.inputBuffer.length;
    updateAutocomplete(state);
    expect(state.autocomplete?.matches.map(item => item.name)).toEqual(["on", "off"]);
  }
});

test("default-model persists Ultrafast only for advertised models", () => {
  const state = stateWithUltrafast(true);
  tryCommand("/default-model openai gpt-6-astra low ultrafast", state);
  expect(configuredConversationDefaults()?.fastMode).toBe("ultrafast");
  tryCommand("/default-model openai gpt-6.1-sol low ultrafast", state);
  expect(configuredConversationDefaults()?.model).toBe("gpt-6-astra");
});
