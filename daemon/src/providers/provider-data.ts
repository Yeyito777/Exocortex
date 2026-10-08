import type { AnthropicAssistantProviderData } from "./anthropic/types";
import type { OpenAIAssistantProviderData } from "./openai/types";

export interface AssistantProviderData {
  openai?: OpenAIAssistantProviderData["openai"];
  anthropic?: AnthropicAssistantProviderData["anthropic"];
}
