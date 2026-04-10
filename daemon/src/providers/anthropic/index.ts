import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_ANTHROPIC_MODELS, fetchAnthropicModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const anthropicProvider: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.anthropic,
  allowsCustomModels: false,
  supportsFastMode: false,
  models: {
    fallbackModels: FALLBACK_ANTHROPIC_MODELS,
    fetch: fetchAnthropicModels,
  },
  auth: {
    login,
    ensureAuthenticated,
    verifyAuth,
    clearAuth,
    hasConfiguredCredentials,
  },
  usage: {
    getLastUsage,
    refreshUsage,
    handleUsageHeaders,
    clearUsage,
  },
  streamMessage,
};
