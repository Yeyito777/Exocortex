import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_GEMINI_MODELS, fetchGeminiModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshRemoteUsage, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const geminiProvider: ProviderAdapter = {
  id: "gemini",
  label: "Gemini",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.gemini,
  allowsCustomModels: false,
  supportsFastMode: false,
  models: {
    fallbackModels: FALLBACK_GEMINI_MODELS,
    fetch: fetchGeminiModels,
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
