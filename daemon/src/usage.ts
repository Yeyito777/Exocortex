import type { ProviderId, UsageData } from "./messages";
import {
  clearUsage as clearAnthropicUsage,
  getLastUsage as getAnthropicUsage,
  refreshUsage as refreshAnthropicUsage,
  handleUsageHeaders as handleAnthropicUsageHeaders,
} from "./providers/anthropic/usage";
import {
  clearUsage as clearOpenAIUsage,
  getLastUsage as getOpenAIUsage,
  refreshUsage as refreshOpenAIUsage,
  handleUsageHeaders as handleOpenAIUsageHeaders,
} from "./providers/openai/usage";

export function getLastUsage(provider: ProviderId): UsageData | null {
  switch (provider) {
    case "anthropic":
      return getAnthropicUsage();
    case "openai":
      return getOpenAIUsage();
    default:
      return null;
  }
}

export function refreshUsage(provider: ProviderId, onUpdate: (usage: UsageData) => void): void {
  switch (provider) {
    case "anthropic":
      refreshAnthropicUsage(onUpdate);
      return;
    case "openai":
      refreshOpenAIUsage(onUpdate);
      return;
    default:
      return;
  }
}

export function handleUsageHeaders(provider: ProviderId, headers: Headers, onUpdate: (usage: UsageData) => void): void {
  switch (provider) {
    case "anthropic":
      handleAnthropicUsageHeaders(headers, onUpdate);
      return;
    case "openai":
      handleOpenAIUsageHeaders(headers, onUpdate);
      return;
    default:
      return;
  }
}

export function clearUsage(provider: ProviderId): void {
  switch (provider) {
    case "anthropic":
      clearAnthropicUsage();
      return;
    case "openai":
      clearOpenAIUsage();
      return;
    default:
      return;
  }
}
