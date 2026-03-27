import type { ModelId, EffortLevel, ApiMessage } from "../messages";

export interface ApiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "thinking"; text: string; signature: string }
  | { type: "text"; text: string };

export interface StreamResult {
  text: string;
  thinking: string;
  stopReason: string;
  blocks: ContentBlock[];
  toolCalls: ApiToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  assistantProviderData?: Record<string, unknown>;
}

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onThinking: (chunk: string) => void;
  onBlockStart?: (type: "text" | "thinking") => void;
  onSignature?: (signature: string) => void;
  onHeaders?: (headers: Headers) => void;
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string, delaySec: number) => void;
}

export interface StreamOptions {
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  tools?: unknown[];
  effort?: EffortLevel;
  promptCacheKey?: string;
}

export interface ProviderStreamMessage {
  (
    messages: ApiMessage[],
    model: ModelId,
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<StreamResult>;
}
