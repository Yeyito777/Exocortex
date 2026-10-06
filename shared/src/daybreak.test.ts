import { expect, test } from "bun:test";
import { DAYBREAK_MODEL_ID, migrateLegacyDaybreak, openAIWireModel } from "./daybreak";
import { defaultEffortForModelId, MAX_CONTEXT } from "./messages";
import { formatModelDisplayName } from "./model-display";
import { resolveModelTokenPricing } from "./token-pricing";
import { configuredConversationDefaults, defaultExocortexConfig } from "./config";

test("the Daybreak product alias inherits base identity, fallback context, effort and pricing", () => {
  expect(openAIWireModel(DAYBREAK_MODEL_ID)).toBe("gpt-6-sol");
  expect(openAIWireModel("gpt-6.1-sol")).toBe("gpt-6.1-sol");
  expect(defaultEffortForModelId("openai", DAYBREAK_MODEL_ID)).toBe(defaultEffortForModelId("openai", "gpt-6-sol"));
  expect(MAX_CONTEXT[DAYBREAK_MODEL_ID]).toBe(MAX_CONTEXT["gpt-6-sol"]);
  expect(formatModelDisplayName(DAYBREAK_MODEL_ID)).toBe("GPT-6-Sol-Daybreak");
  for (const serviceTier of ["standard", "fast", "ultrafast"] as const) {
    expect(resolveModelTokenPricing(DAYBREAK_MODEL_ID, { serviceTier })).toEqual(resolveModelTokenPricing("gpt-6-sol", { serviceTier }));
  }
});

test("legacy selection migration preserves history and does not leave a second mode flag", () => {
  for (const selection of [
    { provider: "openai" as const, model: "gpt-daybreak-blue-latest" },
    { provider: "openai" as const, model: "gpt-6-sol", daybreak: true },
  ]) {
    const messages = [{ model: "gpt-daybreak-blue-latest" }];
    const migrated = migrateLegacyDaybreak({ ...selection, messages });
    expect(migrated.model).toBe(DAYBREAK_MODEL_ID);
    expect(migrated).not.toHaveProperty("daybreak");
    expect(migrated.messages).toBe(messages);
  }
});

test("saved legacy model defaults use the selectable alias without changing unrelated settings", () => {
  const config = defaultExocortexConfig();
  config.defaults = { conversation: { provider: "openai", model: "gpt-daybreak-blue-latest", effort: "low", fastMode: false } };
  expect(configuredConversationDefaults(config)).toEqual({ provider: "openai", model: DAYBREAK_MODEL_ID, effort: "low", fastMode: false });
  expect(config.defaults.conversation?.model).toBe("gpt-daybreak-blue-latest");
});
