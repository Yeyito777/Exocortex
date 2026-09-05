import { beforeEach, expect, test } from "bun:test";
import { createInitialState } from "./state";
import { tryCommand, getCommandArgs } from "./commands";
import { clearPreferredProvider } from "./preferences";
import { configuredConversationDefaults, defaultExocortexConfig, readExocortexConfig, writeExocortexConfig } from "@exocortex/shared/config";
import type { ProviderInfo } from "./messages";

const provider: ProviderInfo = {
  id: "openrouter", label: "OpenRouter", defaultModel: "nousresearch/hermes-4-405b", allowsCustomModels: false, supportsFastMode: false,
  models: [{ id: "nousresearch/hermes-4-405b", label: "Hermes 4 405B", maxContext: 131072, supportedEfforts: [{ effort: "high", description: "On" }, { effort: "none", description: "Off" }], defaultEffort: "high", supportsImages: false, supportsTools: false }],
};

beforeEach(() => { clearPreferredProvider(); writeExocortexConfig(defaultExocortexConfig()); });
function state() {
  const result = createInitialState();
  result.providerRegistry = [structuredClone(provider)];
  return result;
}

test("OpenRouter API-key login sends the key only in the login action", () => {
  const s = state();
  expect(tryCommand("/login openrouter synthetic-test-key", s)).toMatchObject({ type: "login", provider: "openrouter", apiKey: "synthetic-test-key" });
  expect(JSON.stringify(s.messages)).not.toContain("synthetic-test-key");
  expect(s.provider).toBe("openrouter");
  expect(s.model).toBe(provider.defaultModel);
});

test("OpenRouter model selection warns about unavailable tools", () => {
  const s = state();
  s.fastMode = true;
  tryCommand(`/model openrouter ${provider.defaultModel}`, s);
  expect(s.provider).toBe("openrouter");
  expect(s.model).toBe(provider.defaultModel);
  expect(s.fastMode).toBe(false);
  expect(JSON.stringify(s.messages)).toContain("chat-only");
  expect(getCommandArgs(s)["/model openrouter"]?.[0]?.desc).toContain("chat only");
});

test("OpenRouter defaults persist a namespaced model ID", () => {
  const s = state();
  tryCommand(`/default-model openrouter/${provider.defaultModel} none`, s);
  expect(configuredConversationDefaults(readExocortexConfig())).toMatchObject({ provider: "openrouter", model: provider.defaultModel, effort: "none", fastMode: false });
});

test("non-reasoning models do not claim a high effort setting", () => {
  const s = state();
  s.providerRegistry[0]!.models[0]!.supportedEfforts = [];
  tryCommand("/model openrouter", s);
  expect(JSON.stringify(s.messages)).toContain("Effort: not supported");
});
