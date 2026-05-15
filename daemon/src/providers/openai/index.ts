import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { createOpenAITurnSession, prewarmOpenAIConversation, streamMessage } from "./api";
import { ensureAuthenticated, hasConfiguredCredentials, login, logout, refreshTokens, verifyAuth } from "./auth";
import { FALLBACK_OPENAI_MODELS, fetchOpenAIModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const openaiProvider: ProviderAdapter = {
  id: "openai",
  label: "OpenAI",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.openai,
  allowsCustomModels: true,
  supportsFastMode: true,
  models: {
    fallbackModels: FALLBACK_OPENAI_MODELS,
    fetch: fetchOpenAIModels,
  },
  auth: {
    login,
    ensureAuthenticated,
    refreshTokens,
    verifyAuth: (accessToken) => verifyAuth(accessToken),
    clearAuth: logout,
    hasConfiguredCredentials,
  },
  usage: {
    getLastUsage,
    refreshUsage,
    handleUsageHeaders,
    clearUsage,
  },
  streamMessage,
  createTurnSession: createOpenAITurnSession,
  prewarmConversation: prewarmOpenAIConversation,
};
