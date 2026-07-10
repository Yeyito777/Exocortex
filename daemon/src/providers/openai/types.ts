export interface OpenAIReasoningItem {
  id: string;
  encryptedContent: string | null;
  summaries: string[];
  rawContent?: string[];
}

/** Opaque checkpoint returned by the Responses API's native compaction path. */
export interface OpenAICompactionItem {
  id?: string;
  encryptedContent: string;
  /** Provider-native turn lineage that must round-trip with the opaque blob. */
  internalChatMessageMetadataPassthrough?: unknown;
}

export interface OpenAIAssistantProviderData {
  openai: {
    /** Scope required to replay encrypted/opaque items from this response. */
    replayScope?: {
      model: string;
      /** One-way account identity hash; never a token, email, or account UUID. */
      accountScope?: string;
    };
    responseId?: string;
    reasoningItems?: OpenAIReasoningItem[];
    compactionItems?: OpenAICompactionItem[];
  };
}
