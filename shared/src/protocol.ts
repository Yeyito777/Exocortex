/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo, ExternalToolStyle, ImageAttachment } from "./messages";
export type { ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo, ExternalToolStyle, ImageAttachment };

// ── Commands (client → daemon) ──────────────────────────────────────

export interface PingCommand {
  type: "ping";
  reqId?: string;
}

export interface NewConversationCommand {
  type: "new_conversation";
  reqId?: string;
  model?: ModelId;
  effort?: EffortLevel;
  /** Initial title. Clients that don't set this get an empty title. */
  title?: string;
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

export interface SetModelCommand {
  type: "set_model";
  reqId?: string;
  convId: string;
  model: ModelId;
}

export interface SetEffortCommand {
  type: "set_effort";
  reqId?: string;
  convId: string;
  effort: EffortLevel;
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

export interface LlmCompleteCommand {
  type: "llm_complete";
  reqId?: string;
  system: string;
  userText: string;
  /** Model to use. Defaults to "haiku". */
  model?: ModelId;
  /** Max output tokens. Defaults to 16000 (must exceed thinking budget for non-adaptive models). */
  maxTokens?: number;
}

export interface GetSystemPromptCommand {
  type: "get_system_prompt";
  reqId?: string;
}

export interface LoginCommand {
  type: "login";
  reqId?: string;
}

export interface LogoutCommand {
  type: "logout";
  reqId?: string;
}

export type Command =
  | PingCommand
  | NewConversationCommand
  | SendMessageCommand
  | SetModelCommand
  | SetEffortCommand
  | AbortCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ListConversationsCommand
  | LoadConversationCommand
  | DeleteConversationCommand
  | MarkConversationCommand
  | PinConversationCommand
  | MoveConversationCommand
  | RenameConversationCommand
  | CloneConversationCommand
  | UndoDeleteCommand
  | QueueMessageCommand
  | UnqueueMessageCommand
  | UnwindConversationCommand
  | LlmCompleteCommand
  | GetSystemPromptCommand
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
  model: ModelId;
}

export interface StreamingStartedEvent {
  type: "streaming_started";
  convId: string;
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
  usage: UsageData;
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
  | { type: "user"; text: string; images?: ImageAttachment[] }
  | { type: "ai"; blocks: Block[]; metadata: MessageMetadata | null }
  | { type: "system"; text: string; color?: string };

export interface QueuedMessageInfo {
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

export interface ConversationLoadedEvent {
  type: "conversation_loaded";
  reqId?: string;
  convId: string;
  model: ModelId;
  effort: EffortLevel;
  /** All messages in display order. */
  entries: DisplayEntry[];
  /** Last known input token count for this conversation. */
  contextTokens: number | null;
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
  images?: ImageAttachment[];
}

export interface StreamRetryEvent {
  type: "stream_retry";
  convId: string;
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  delaySec: number;
}

export interface SystemMessageEvent {
  type: "system_message";
  convId: string;
  text: string;
  color?: string;
}

export interface ToolsAvailableEvent {
  type: "tools_available";
  tools: ToolDisplayInfo[];
  externalToolStyles?: ExternalToolStyle[];
}

export interface HistoryUpdatedEvent {
  type: "history_updated";
  convId: string;
  /** The full message history after modification (same format as conversation_loaded). */
  entries: DisplayEntry[];
  /** Updated input token count. */
  contextTokens: number | null;
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

export interface AuthStatusEvent {
  type: "auth_status";
  reqId?: string;
  message: string;
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
  | ToolCallEvent
  | ToolResultEvent
  | TokensUpdateEvent
  | ContextUpdateEvent
  | MessageCompleteEvent
  | UsageUpdateEvent
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
  | LlmCompleteResultEvent
  | SystemPromptEvent
  | AuthStatusEvent
  | ErrorEvent;
