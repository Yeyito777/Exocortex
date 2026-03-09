/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ModelId, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo } from "./messages";
export type { ModelId, Block, MessageMetadata, UsageData, ConversationSummary, ToolDisplayInfo };

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

export interface UndoDeleteCommand {
  type: "undo_delete";
  reqId?: string;
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
  | LoadConversationCommand
  | DeleteConversationCommand
  | MarkConversationCommand
  | PinConversationCommand
  | MoveConversationCommand
  | RenameConversationCommand
  | UndoDeleteCommand;

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
  | { type: "user"; text: string }
  | { type: "ai"; blocks: Block[]; metadata: MessageMetadata | null }
  | { type: "system"; text: string; color?: string };

export interface ConversationLoadedEvent {
  type: "conversation_loaded";
  reqId?: string;
  convId: string;
  model: ModelId;
  /** All messages in display order. */
  entries: DisplayEntry[];
  /** Last known input token count for this conversation. */
  contextTokens: number | null;
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
  | ErrorEvent;
