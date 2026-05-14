import type { OpenAIAssistantProviderData } from "./openai/types";

export interface AssistantProviderData {
  openai?: OpenAIAssistantProviderData["openai"];
}
