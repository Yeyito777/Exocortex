/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ModelId, Block, MessageMetadata, UsageData, ConversationSummary } from "./messages";
export type { ModelId, Block, MessageMetadata, UsageData, ConversationSummary };

// ── Commands (client → daemon) ──────────────────────────────────────

export interface PingCommand {
  type: "ping";
  reqId?: string;
}

export interface NewConversationCommand {
  type: "new_conversation";
  reqId?: string;
  model?: ModelId;
}

export interface SendMessageCommand {
  type: "send_message";
  reqId?: string;
  convId: string;
  text: string;
  /** Client-originated timestamp — the daemon stores this as the message start time. */
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

export interface SetModelCommand {
  type: "set_model";
  reqId?: string;
  convId: string;
  model: ModelId;
}

export type Command =
  | PingCommand
  | NewConversationCommand
  | SendMessageCommand
  | SetModelCommand
  | AbortCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ListConversationsCommand
  | LoadConversationCommand;

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
}

export interface StreamingStoppedEvent {
  type: "streaming_stopped";
  convId: string;
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

export interface ConversationLoadedEvent {
  type: "conversation_loaded";
  reqId?: string;
  convId: string;
  model: ModelId;
  aiMessages: AIMessagePayload[];
  /** The raw user message texts, in order, for display. */
  userMessages: string[];
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  summary: ConversationSummary;
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
  | ErrorEvent;
