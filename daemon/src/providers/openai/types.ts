export interface OpenAIReasoningItem {
  id: string;
  encryptedContent: string | null;
  summaries: string[];
}

export interface OpenAIAssistantProviderData {
  openai: {
    responseId?: string;
    reasoningItems?: OpenAIReasoningItem[];
  };
}
