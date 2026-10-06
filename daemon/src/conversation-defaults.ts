/** Daemon-owned persistence and live-provider validation for new-chat defaults. */
import {
  clearConversationDefaults,
  configuredConversationDefaults,
  productConversationDefaults,
  saveConversationDefaults,
  type ConversationDefaults,
} from "@exocortex/shared/config";
import { EFFORT_LEVELS, isFastMode } from "@exocortex/shared/messages";
import type { ConversationDefaultsSnapshot } from "./protocol";
import {
  allowsCustomModels, getProvider, getSupportedEfforts, isKnownModel,
  supportsEffort, supportsFastMode, daybreakSelectionError,
} from "./providers/registry";

export function conversationDefaultsSnapshot(): ConversationDefaultsSnapshot {
  const configured = configuredConversationDefaults();
  return { defaults: configured ?? productConversationDefaults(), configured: configured !== null };
}

export function setDaemonConversationDefaults(value: unknown): ConversationDefaultsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid conversation defaults");
  }
  const defaults = value as ConversationDefaults;
  const { provider, model, effort, fastMode } = defaults;
  if (typeof provider !== "string" || !getProvider(provider)) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (typeof model !== "string" || !model.trim() || model !== model.trim()) {
    throw new Error("Invalid default model");
  }
  const daybreakError = daybreakSelectionError(provider, model);
  if (daybreakError) throw new Error(daybreakError);
  if (!isKnownModel(provider, model) && !allowsCustomModels(provider)) {
    throw new Error(`Unknown model for provider ${provider}: ${model}`);
  }
  if (!EFFORT_LEVELS.includes(effort) || (isKnownModel(provider, model) && !supportsEffort(provider, model, effort))) {
    throw new Error(`Invalid effort for ${provider}/${model}: ${effort}. Valid: ${getSupportedEfforts(provider, model).map(item => item.effort).join(", ")}`);
  }
  if (!isFastMode(fastMode) || (fastMode && !supportsFastMode(provider, model, fastMode))) {
    throw new Error(`Fast mode is only available for ${provider} conversations that support it.`);
  }
  // Copy only the validated wire fields; do not persist arbitrary IPC payload keys.
  saveConversationDefaults({ provider, model, effort, fastMode });
  return conversationDefaultsSnapshot();
}

export function resetDaemonConversationDefaults(): ConversationDefaultsSnapshot {
  clearConversationDefaults();
  return conversationDefaultsSnapshot();
}
