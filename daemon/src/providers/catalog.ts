import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "@exocortex/shared/messages";
import { anthropicProvider } from "./anthropic";
import { deepseekProvider } from "./deepseek";
import { openaiProvider } from "./openai";
import type { ProviderAdapter } from "./types";

const PROVIDERS_BY_ID: Record<ProviderId, ProviderAdapter> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  deepseek: deepseekProvider,
};

export function getProviderAdapter(providerId: ProviderId): ProviderAdapter {
  return PROVIDERS_BY_ID[providerId];
}

export function getProviderAdapters(): ProviderAdapter[] {
  return DEFAULT_PROVIDER_ORDER.map((providerId) => PROVIDERS_BY_ID[providerId]);
}
