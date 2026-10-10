import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_ANTHROPIC_MODELS, fetchAnthropicModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshRemoteUsage, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const anthropicProvider: ProviderAdapter = {
  id: "anthropic",
  label: "Anthropic",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.anthropic,
  allowsCustomModels: true,
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
    refreshRemoteUsage,
    handleUsageHeaders,
    clearUsage,
  },
  streamMessage,
};
