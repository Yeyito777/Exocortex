import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_DEEPSEEK_MODELS, fetchDeepSeekModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const deepseekProvider: ProviderAdapter = {
  id: "deepseek",
  label: "DeepSeek",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.deepseek,
  allowsCustomModels: true,
  supportsFastMode: false,
  models: {
    fallbackModels: FALLBACK_DEEPSEEK_MODELS,
    fetch: fetchDeepSeekModels,
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
