import type { ModelId, EffortLevel, ApiMessage, ProviderId, ModelInfo, UsageData, ToolCallBlock, ToolResultBlock, TokenTrackingContext } from "../messages";
import type { OAuthProfile, StoredTokens } from "../store";
import type { AssistantProviderData } from "./provider-data";

export type ServiceTier = "fast";

export interface ApiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "thinking"; text: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown>; summary: string }
  | { type: "tool_result"; toolUseId: string; toolName: string; output: string; isError: boolean };

export interface StreamResult {
  text: string;
  thinking: string;
  stopReason: string;
  blocks: ContentBlock[];
  toolCalls: ApiToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  assistantProviderData?: AssistantProviderData;
}

export interface StreamRetryMetadata {
  kind?: "transient" | "usage_limit_reset";
  /** Unix epoch milliseconds when retry is expected, if known. */
  resetAt?: number;
}

export interface StreamCallbacks {
  onText: (chunk: string) => void;
  onThinking: (chunk: string) => void;
  onBlockStart?: (type: "text" | "thinking") => void;
  /** Replace the current round's live text/thinking blocks with the canonical provider state. */
  onBlocksUpdate?: (blocks: ContentBlock[]) => void;
  onSignature?: (signature: string) => void;
  onToolCall?: (block: ToolCallBlock) => void;
  onToolResult?: (block: ToolResultBlock) => void;
  onHeaders?: (headers: Headers) => void;
  onRetry?: (attempt: number, maxAttempts: number, errorMessage: string, delaySec: number, metadata?: StreamRetryMetadata) => void;
  /** Pause/resume stale-stream watchdogs around intentional long retry waits. */
  onRetryWaitStart?: () => void;
  onRetryWaitEnd?: () => void;
}

export interface StreamToolExecutionResult {
  output: string;
  isError: boolean;
  image?: { mediaType: string; base64: string };
}

export type StreamToolExecutor = (call: ApiToolCall, signal?: AbortSignal) => Promise<StreamToolExecutionResult>;

export interface StreamOptions {
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  tools?: unknown[];
  effort?: EffortLevel;
  serviceTier?: ServiceTier;
  promptCacheKey?: string;
  /** Token-accounting metadata for this request. */
  tracking?: TokenTrackingContext;
  /** Optional provider-native tool bridge. Anthropic uses this to expose Exocortex tools via MCP. */
  mcpToolExecutor?: StreamToolExecutor;
}

export interface ProviderStreamMessage {
  (
    messages: ApiMessage[],
    model: ModelId,
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<StreamResult>;
}

export interface LoginResult {
  tokens?: StoredTokens;
  profile: OAuthProfile | null;
}

export interface LoginCallbacks {
  onProgress?: (msg: string) => void;
  onOpenUrl?: (url: string) => boolean | void | Promise<boolean | void>;
}

export interface LoginOptions {
  /** Provider-specific secret supplied by the caller. DeepSeek uses this for API-key login. */
  apiKey?: string;
}

export interface EnsureAuthResult {
  status: "already_authenticated" | "refreshed" | "logged_in";
  email: string | null;
}

export interface ProviderModelSource {
  fallbackModels: ModelInfo[];
  fetch(): Promise<ModelInfo[]>;
}

export interface ProviderAuthAdapter {
  login(callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult>;
  ensureAuthenticated(callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult>;
  refreshTokens?: (refreshToken: string) => Promise<unknown>;
  verifyAuth(accessToken: string): Promise<boolean>;
  clearAuth(): boolean;
  hasConfiguredCredentials(): boolean;
}

export interface ProviderUsageAdapter {
  getLastUsage(): UsageData | null;
  refreshUsage(onUpdate: (usage: UsageData) => void): void;
  handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void;
  clearUsage(): void;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  defaultModel: ModelId;
  allowsCustomModels: boolean;
  supportsFastMode: boolean;
  models: ProviderModelSource;
  auth: ProviderAuthAdapter;
  usage: ProviderUsageAdapter;
  streamMessage: ProviderStreamMessage;
}
