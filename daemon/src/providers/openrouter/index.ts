import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_OPENROUTER_MODELS, fetchOpenRouterModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const openRouterProvider: ProviderAdapter = {
  id: "openrouter",
  label: "OpenRouter",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.openrouter,
  allowsCustomModels: false,
  supportsFastMode: false,
  models: {
    fallbackModels: FALLBACK_OPENROUTER_MODELS,
    fetch: fetchOpenRouterModels,
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
