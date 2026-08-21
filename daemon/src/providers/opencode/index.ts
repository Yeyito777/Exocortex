import { DEFAULT_MODEL_BY_PROVIDER } from "@exocortex/shared/messages";
import { streamMessage } from "./api";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";
import { FALLBACK_OPENCODE_MODELS, fetchOpenCodeModels } from "./models";
import { clearUsage, getLastUsage, handleUsageHeaders, refreshUsage } from "./usage";
import type { ProviderAdapter } from "../types";

export const openCodeProvider: ProviderAdapter = {
  id: "opencode",
  label: "OpenCode Zen",
  defaultModel: DEFAULT_MODEL_BY_PROVIDER.opencode,
  allowsCustomModels: false,
  supportsFastMode: false,
  models: {
    fallbackModels: FALLBACK_OPENCODE_MODELS,
    fetch: fetchOpenCodeModels,
  },
  auth: {
    login,
    ensureAuthenticated,
    verifyAuth,
    clearAuth,
    hasConfiguredCredentials,
    publicAccessLabel: "Public preview",
  },
  usage: {
    getLastUsage,
    refreshUsage,
    handleUsageHeaders,
    clearUsage,
  },
  streamMessage,
};
