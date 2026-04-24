import { loadProviderAuth, type StoredAuth } from "../store";

/** Runtime availability gate for OpenAI-backed inner tools. */
export function hasOpenAIAuth(): boolean {
  const stored = loadProviderAuth<StoredAuth>("openai");
  return !!stored?.tokens?.accessToken || !!stored?.tokens?.refreshToken;
}
