/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, TokenStatsSnapshot, TokenUsageSource } from "./messages";
export type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, TokenStatsSnapshot, TokenUsageSource };

// ── Commands (client → daemon) ──────────────────────────────────────

export interface PingCommand {
  type: "ping";
  reqId?: string;
}

export interface NewConversationCommand {
  type: "new_conversation";
  reqId?: string;
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: boolean;
  /** Initial title. Clients that don't set this get an empty title. */
  title?: string;
}

export interface ParentNotificationTarget {
  /** Parent conversation to notify when this detached child task completes. */
  convId: string;
  /** Maximum characters of child result to include in the parent notification. */
  maxChars?: number;
}

export interface SendMessageCommand {
  type: "send_message";
  reqId?: string;
  convId: string;
  text: string;
  /** Client-originated timestamp — the daemon stores this as the message start time. */
  startedAt: number;
  /** Base64-encoded image attachments from clipboard paste. */
  images?: ImageAttachment[];
  /** If true, acknowledge immediately and run the assistant turn in the daemon. */
  detached?: boolean;
  /** Optional parent conversation to notify when the detached turn completes. */
  notifyParent?: ParentNotificationTarget;
}

export interface ReplayConversationCommand {
  type: "replay_conversation";
  reqId?: string;
  convId: string;
  /** Client-originated timestamp for the replayed assistant turn. */
  startedAt: number;
}

export interface AbortCommand {
  type: "abort";
  reqId?: string;
  convId: string;
}

export interface SubscribeCommand {
  type: "subscribe";
  reqId?: string;
  convId: string;
}

export interface UnsubscribeCommand {
  type: "unsubscribe";
  reqId?: string;
  convId: string;
}

export interface ListConversationsCommand {
  type: "list_conversations";
  reqId?: string;
}

export interface LoadConversationCommand {
  type: "load_conversation";
  reqId?: string;
  convId: string;
}

export interface LoadToolOutputsCommand {
  type: "load_tool_outputs";
  reqId?: string;
  convId: string;
}

export interface SetModelCommand {
  type: "set_model";
  reqId?: string;
  convId: string;
  provider?: ProviderId;
  model: ModelId;
}

export interface SetEffortCommand {
  type: "set_effort";
  reqId?: string;
  convId: string;
  effort: EffortLevel;
}

export interface SetFastModeCommand {
  type: "set_fast_mode";
  reqId?: string;
  convId: string;
  enabled: boolean;
}

export type TrimMode = "messages" | "thinking" | "toolresults";

export type ExternalToolDaemonAction = "start" | "stop" | "restart" | "status";

export interface ManageExternalToolDaemonCommand {
  type: "manage_external_tool_daemon";
  reqId?: string;
  toolName: string;
  action: ExternalToolDaemonAction;
}

export interface TrimConversationCommand {
  type: "trim_conversation";
  reqId?: string;
  convId: string;
  mode: TrimMode;
  count: number;
}

export interface DeleteConversationCommand {
  type: "delete_conversation";
  reqId?: string;
  convId: string;
}

export interface MarkConversationCommand {
  type: "mark_conversation";
  reqId?: string;
  convId: string;
  marked: boolean;
}

export interface PinConversationCommand {
  type: "pin_conversation";
  reqId?: string;
  convId: string;
  pinned: boolean;
}

export interface MoveConversationCommand {
  type: "move_conversation";
  reqId?: string;
  convId: string;
  direction: "up" | "down";
}

export interface RenameConversationCommand {
  type: "rename_conversation";
  reqId?: string;
  convId: string;
  title: string;
}

export interface GenerateTitleCommand {
  type: "generate_title";
  reqId?: string;
  convId: string;
}

export interface CloneConversationCommand {
  type: "clone_conversation";
  reqId?: string;
  convId: string;
}

export interface UndoDeleteCommand {
  type: "undo_delete";
  reqId?: string;
}

export type QueueTiming = "next-turn" | "message-end";

export interface QueueMessageCommand {
  type: "queue_message";
  reqId?: string;
  convId: string;
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

export interface UnqueueMessageCommand {
  type: "unqueue_message";
  reqId?: string;
  convId: string;
  text: string;
}

export interface UnwindConversationCommand {
  type: "unwind_conversation";
  reqId?: string;
  convId: string;
  /** Index counting only user messages (0-based). Everything from this message onward is removed. */
  userMessageIndex: number;
}

export interface SetSystemInstructionsCommand {
  type: "set_system_instructions";
  reqId?: string;
  convId: string;
  /** The instructions text. Empty string clears them. */
  text: string;
}

export interface LlmCompleteCommand {
  type: "llm_complete";
  reqId?: string;
  system: string;
  userText: string;
  provider?: ProviderId;
  /** Model to use. Defaults to the provider's default model. */
  model?: ModelId;
  /** Max output tokens. Defaults to 16000 (must exceed thinking budget for non-adaptive models). */
  maxTokens?: number;
  /** Optional source label for token accounting. */
  trackingSource?: TokenUsageSource;
}

export interface GetSystemPromptCommand {
  type: "get_system_prompt";
  reqId?: string;
  /** If set, includes per-conversation system instructions in the output. */
  convId?: string;
}

export interface TranscribeAudioCommand {
  type: "transcribe_audio";
  reqId?: string;
  /** Base64-encoded audio payload (typically WAV) captured by the TUI. */
  audioBase64: string;
  /** MIME type for the uploaded audio. */
  mimeType: string;
}

export interface LoginCommand {
  type: "login";
  reqId?: string;
  provider?: ProviderId;
}

export interface LogoutCommand {
  type: "logout";
  reqId?: string;
  provider?: ProviderId;
}

export type Command =
  | PingCommand
  | NewConversationCommand
  | SendMessageCommand
  | ReplayConversationCommand
  | SetModelCommand
  | SetEffortCommand
  | SetFastModeCommand
  | ManageExternalToolDaemonCommand
  | TrimConversationCommand
  | AbortCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ListConversationsCommand
  | LoadConversationCommand
  | LoadToolOutputsCommand
  | DeleteConversationCommand
  | MarkConversationCommand
  | PinConversationCommand
  | MoveConversationCommand
  | RenameConversationCommand
  | GenerateTitleCommand
  | CloneConversationCommand
  | UndoDeleteCommand
  | QueueMessageCommand
  | UnqueueMessageCommand
  | UnwindConversationCommand
  | SetSystemInstructionsCommand
  | LlmCompleteCommand
  | GetSystemPromptCommand
  | TranscribeAudioCommand
  | LoginCommand
  | LogoutCommand;

// ── Events (daemon → client) ────────────────────────────────────────

export interface PongEvent {
  type: "pong";
  reqId?: string;
}

export interface AckEvent {
  type: "ack";
  reqId?: string;
  convId?: string;
}

export interface ConversationCreatedEvent {
  type: "conversation_created";
  reqId?: string;
  convId: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
}

export interface StreamingStartedEvent {
  type: "streaming_started";
  convId: string;
  provider: ProviderId;
  model: ModelId;
  /** When the AI started processing. Lets late-joining clients show the correct elapsed time. */
  startedAt: number;
  /** Accumulated blocks so far — included for late-joining clients. */
  blocks?: Block[];
  /** Accumulated output tokens so far — included for late-joining clients. */
  tokens?: number;
}

export interface StreamingStoppedEvent {
  type: "streaming_stopped";
  convId: string;
  /** On abort/error: the blocks that were safe to persist. TUI replaces its pending blocks with these. */
  persistedBlocks?: Block[];
}

export interface BlockStartEvent {
  type: "block_start";
  convId: string;
  blockType: "text" | "thinking";
}

export interface TextChunkEvent {
  type: "text_chunk";
  convId: string;
  text: string;
}

export interface ThinkingChunkEvent {
  type: "thinking_chunk";
  convId: string;
  text: string;
}

/** Replace the live text/thinking tail with the daemon's canonical current-round blocks. */
export interface StreamingSyncEvent {
  type: "streaming_sync";
  convId: string;
  blocks: Block[];
}

export interface ToolCallEvent {
  type: "tool_call";
  convId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  convId: string;
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export interface TokensUpdateEvent {
  type: "tokens_update";
  convId: string;
  tokens: number;
}

export interface ContextUpdateEvent {
  type: "context_update";
  convId: string;
  contextTokens: number;
}

export interface MessageCompleteEvent {
  type: "message_complete";
  convId: string;
  blocks: Block[];
  endedAt: number;
  tokens: number;
}

export interface UsageUpdateEvent {
  type: "usage_update";
  provider: ProviderId;
  usage: UsageData | null;
}

export interface TokenStatsEvent {
  type: "token_stats";
  reqId?: string;
  stats: TokenStatsSnapshot;
}

export interface ConversationsListEvent {
  type: "conversations_list";
  reqId?: string;
  conversations: ConversationSummary[];
}

export interface AIMessagePayload {
  blocks: Block[];
  metadata: MessageMetadata | null;
}

export type DisplayEntry =
  | { type: "system_instructions"; text: string }
  | { type: "user"; text: string; images?: ImageAttachment[]; metadata?: MessageMetadata | null }
  | { type: "ai"; blocks: Block[]; metadata: MessageMetadata | null }
  | { type: "system"; text: string; color?: string };

export interface QueuedMessageInfo {
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

export interface ToolOutputInfo {
  toolCallId: string;
  output: string;
}

export interface ConversationLoadedEvent {
  type: "conversation_loaded";
  reqId?: string;
  convId: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  /** All messages in display order, excluding the currently in-flight assistant tail. */
  entries: DisplayEntry[];
  /** Live assistant snapshot for actively streaming conversations. */
  pendingAI?: AIMessagePayload;
  /** Last known input token count for this conversation. */
  contextTokens: number | null;
  /** Whether tool_result block outputs are present in entries. */
  toolOutputsIncluded: boolean;
  /** Messages currently queued for delivery (so the TUI can show shadows). */
  queuedMessages?: QueuedMessageInfo[];
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  summary: ConversationSummary;
}

export interface ConversationDeletedEvent {
  type: "conversation_deleted";
  convId: string;
}

export interface ConversationRestoredEvent {
  type: "conversation_restored";
  reqId?: string;
  summary: ConversationSummary;
}

export interface ConversationMarkedEvent {
  type: "conversation_marked";
  convId: string;
  marked: boolean;
}

export interface ConversationPinnedEvent {
  type: "conversation_pinned";
  convId: string;
  pinned: boolean;
}

export interface ConversationMovedEvent {
  type: "conversation_moved";
  conversations: ConversationSummary[];
}

export interface UserMessageEvent {
  type: "user_message";
  convId: string;
  text: string;
  /** Client-originated timestamp when available; daemon-generated for queued sends. */
  startedAt?: number;
  images?: ImageAttachment[];
}

export interface StreamRetryEvent {
  type: "stream_retry";
  convId: string;
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  delaySec: number;
  kind?: "transient" | "usage_limit_reset";
  /** Unix epoch milliseconds when retry is expected, if known. */
  resetAt?: number;
}

export interface SystemMessageEvent {
  type: "system_message";
  convId: string;
  text: string;
  color?: string;
}

export interface ProviderAuthInfo {
  configured: boolean;
  authenticated: boolean;
  status: "not_logged_in" | "logged_in" | "expired" | "refreshable";
  email: string | null;
  displayName: string | null;
  organizationName: string | null;
  organizationType: string | null;
  organizationRole: string | null;
  workspaceRole: string | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  scopes: string[];
  expiresAt: number | null;
  updatedAt: string | null;
  source: string | null;
}

export interface ToolsAvailableEvent {
  type: "tools_available";
  providers: ProviderInfo[];
  tools: ToolDisplayInfo[];
  authByProvider: Record<ProviderId, boolean>;
  authInfoByProvider: Record<ProviderId, ProviderAuthInfo>;
  externalToolStyles?: ExternalToolStyle[];
}

export interface HistoryUpdatedEvent {
  type: "history_updated";
  convId: string;
  /** The full message history after modification (same format as conversation_loaded). */
  entries: DisplayEntry[];
  /** Updated input token count. */
  contextTokens: number | null;
  /** Whether tool_result block outputs are present in entries. */
  toolOutputsIncluded: boolean;
}

export interface ToolOutputsLoadedEvent {
  type: "tool_outputs_loaded";
  reqId?: string;
  convId: string;
  outputs: ToolOutputInfo[];
}

export interface SystemInstructionsUpdatedEvent {
  type: "system_instructions_updated";
  convId: string;
  /** The new instructions text. Empty string means cleared. */
  text: string;
}

export interface LlmCompleteResultEvent {
  type: "llm_complete_result";
  reqId?: string;
  text: string;
}

export interface SystemPromptEvent {
  type: "system_prompt";
  reqId?: string;
  systemPrompt: string;
}

export interface TranscriptionResultEvent {
  type: "transcription_result";
  reqId?: string;
  text: string;
}

export interface ExternalToolDaemonStatus {
  toolName: string;
  action: ExternalToolDaemonAction;
  configured: boolean;
  managed: boolean;
  running: boolean;
  pid: number | null;
  restartPolicy: "on-failure" | "always" | "never" | null;
  message: string;
}

export interface ExternalToolDaemonResultEvent {
  type: "external_tool_daemon_result";
  reqId?: string;
  status: ExternalToolDaemonStatus;
}

export interface AuthStatusEvent {
  type: "auth_status";
  reqId?: string;
  /** Optional user-visible status text. openUrl-only events should not print a blank line. */
  message?: string;
  /** When set, the TUI should open this URL in the user's browser. */
  openUrl?: string;
}

export interface ErrorEvent {
  type: "error";
  reqId?: string;
  convId?: string;
  message: string;
}

export type Event =
  | PongEvent
  | AckEvent
  | ConversationCreatedEvent
  | StreamingStartedEvent
  | StreamingStoppedEvent
  | BlockStartEvent
  | TextChunkEvent
  | ThinkingChunkEvent
  | StreamingSyncEvent
  | ToolCallEvent
  | ToolResultEvent
  | TokensUpdateEvent
  | ContextUpdateEvent
  | MessageCompleteEvent
  | UsageUpdateEvent
  | TokenStatsEvent
  | ConversationsListEvent
  | ConversationLoadedEvent
  | ConversationUpdatedEvent
  | ConversationDeletedEvent
  | ConversationRestoredEvent
  | ConversationMarkedEvent
  | ConversationPinnedEvent
  | ConversationMovedEvent
  | UserMessageEvent
  | StreamRetryEvent
  | SystemMessageEvent
  | ToolsAvailableEvent
  | HistoryUpdatedEvent
  | ToolOutputsLoadedEvent
  | SystemInstructionsUpdatedEvent
  | LlmCompleteResultEvent
  | SystemPromptEvent
  | TranscriptionResultEvent
  | ExternalToolDaemonResultEvent
  | AuthStatusEvent
  | ErrorEvent;
