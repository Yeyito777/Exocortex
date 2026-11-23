import type { AnthropicAssistantProviderData } from "./anthropic/types";
import type { OpenAIAssistantProviderData } from "./openai/types";
import type { GeminiAssistantProviderData } from "./gemini/types";

export interface AssistantProviderData {
  openai?: OpenAIAssistantProviderData["openai"];
  anthropic?: AnthropicAssistantProviderData["anthropic"];
  gemini?: GeminiAssistantProviderData["gemini"];
}
