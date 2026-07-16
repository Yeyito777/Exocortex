/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, FolderSummary, SidebarItemRef, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, TokenStatsSnapshot, TokenUsageSource, ConversationGoal, ConversationGoalStatus, UserMessageContextCheckpoint, ExternalNotificationDelivery } from "./messages";
export type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, FolderSummary, SidebarItemRef, ToolDisplayInfo, ExternalToolStyle, ImageAttachment, TokenStatsSnapshot, TokenUsageSource, ConversationGoal, ConversationGoalStatus, UserMessageContextCheckpoint, ExternalNotificationDelivery };

// ── Commands (client → daemon) ──────────────────────────────────────

export interface PingCommand {
  type: "ping";
  reqId?: string;
}

/** Service wrapper handshake before it sends the daemon its shutdown signal. */
export interface PrepareShutdownCommand {
  type: "prepare_shutdown";
  reqId?: string;
  mode: "stop" | "restart";
}

export interface NewConversationCommand {
  type: "new_conversation";
  reqId?: string;
  /** Optional client-generated id so follow-up commands (notably early abort) can target the conversation before the create ack arrives. */
  convId?: string;
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: boolean;
  /** Initial title. Clients that don't set this get an empty title. */
  title?: string;
  /** Optional prompt text used to auto-generate a title before any message is sent. */
  titleContext?: string;
  /**
   * Optional first user message to append atomically with conversation creation.
   * This lets clients create the conversation with a daemon-owned pending title
   * without persisting a title-generation placeholder before the daemon owns the
   * message context needed to resolve it.
   */
  initialMessage?: {
    text: string;
    startedAt: number;
    images?: ImageAttachment[];
  };
  /** Folder to create the conversation in. Null/omitted means the sidebar root. */
  folderId?: string | null;
  /** If true, the daemon creates/reuses the top-level "subagents" folder for this conversation. */
  subagent?: boolean;
  /** Optional goal to set immediately after creating the conversation. */
  goalObjective?: string;
  /** Optional goal permission. Defaults to true. If goalCompletable is false, this is forced false. */
  goalPausable?: boolean;
  /** Optional goal permission. Defaults to true. If false, goalPausable is also forced false. */
  goalCompletable?: boolean;
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
  /** Optional machine-readable reason used by the daemon to render a clearer system message. */
  reason?: "user" | "daemon-restart";
}

export interface BackgroundToolCommand {
  type: "background_tool";
  reqId?: string;
  convId: string;
}

export interface PrewarmConversationCommand {
  type: "prewarm_conversation";
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
  /** Client wall-clock time used only to diagnose IPC/event-loop queue delay. */
  requestedAt?: number;
  /** Number of newest user turns to include in the opening payload. */
  turns?: number;
}

export interface LoadConversationHistoryCommand {
  type: "load_conversation_history";
  reqId?: string;
  convId: string;
  /** UI action that caused this page request; diagnostic only. */
  requestSource?: "initial-backfill" | "viewport";
  /** Absolute entry cursor returned by the preceding history payload. */
  beforeEntryIndex: number;
  /** Maximum number of user turns to load before the cursor. */
  turns: number;
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

export type GoalAction = "show" | "set" | "pause" | "resume" | "complete";

export interface SetGoalCommand {
  type: "set_goal";
  reqId?: string;
  convId: string;
  action: GoalAction;
  objective?: string;
  pausable?: boolean;
  completable?: boolean;
}

export type TrimMode = "messages" | "thinking" | "toolresults";

export type ExternalToolDaemonAction = "start" | "stop" | "restart" | "status";

export interface ManageExternalToolDaemonCommand {
  type: "manage_external_tool_daemon";
  reqId?: string;
  toolName: string;
  action: ExternalToolDaemonAction;
}

/** A tool-owned external event source that conversations may subscribe to. */
export interface ExternalNotificationSource {
  toolName: string;
  id: string;
  label: string;
  description?: string;
  /** Last time the source announced itself to this daemon. */
  registeredAt: number;
}

/** A durable route from an external event source to an Exocortex conversation. */
export interface ExternalNotificationSubscription {
  id: string;
  toolName: string;
  sourceId: string;
  sourceLabel: string;
  sourceDescription?: string;
  convId: string;
  delivery: ExternalNotificationDelivery;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterExternalNotificationSourceCommand {
  type: "register_external_notification_source";
  reqId?: string;
  toolName: string;
  source: {
    id: string;
    label: string;
    description?: string;
  };
}

export interface ListExternalNotificationSourcesCommand {
  type: "list_external_notification_sources";
  reqId?: string;
  toolName?: string;
}

export interface ListExternalNotificationSubscriptionsCommand {
  type: "list_external_notification_subscriptions";
  reqId?: string;
  toolName?: string;
  sourceId?: string;
  convId?: string;
}

export interface SubscribeExternalNotificationCommand {
  type: "subscribe_external_notification";
  reqId?: string;
  toolName: string;
  sourceId: string;
  /** Snapshot metadata permits migration before a source daemon has registered. */
  sourceLabel?: string;
  sourceDescription?: string;
  convId: string;
  delivery?: ExternalNotificationDelivery;
}

export interface UnsubscribeExternalNotificationCommand {
  type: "unsubscribe_external_notification";
  reqId?: string;
  subscriptionId?: string;
  toolName?: string;
  sourceId?: string;
  convId?: string;
}

export interface UpdateExternalNotificationSubscriptionCommand {
  type: "update_external_notification_subscription";
  reqId?: string;
  subscriptionId: string;
  delivery?: ExternalNotificationDelivery;
  enabled?: boolean;
}

export interface PublishExternalNotificationCommand {
  type: "publish_external_notification";
  reqId?: string;
  toolName: string;
  sourceId: string;
  /** Stable platform event/batch id used for per-subscription deduplication. */
  eventId: string;
  /** Tool-formatted content; the daemon adds the trusted provenance envelope. */
  text: string;
  occurredAt?: number;
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

export interface DeleteConversationsCommand {
  type: "delete_conversations";
  reqId?: string;
  convIds: string[];
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

export interface CreateFolderCommand {
  type: "create_folder";
  reqId?: string;
  name: string;
  parentId?: string | null;
  /** Optional items to move into the new folder, preserving the given order. */
  items?: SidebarItemRef[];
}

export interface RenameFolderCommand {
  type: "rename_folder";
  reqId?: string;
  folderId: string;
  name: string;
}

export interface PinFolderCommand {
  type: "pin_folder";
  reqId?: string;
  folderId: string;
  pinned: boolean;
}

export interface PinSidebarItemsCommand {
  type: "pin_sidebar_items";
  reqId?: string;
  pins: { item: SidebarItemRef; pinned: boolean }[];
}

export interface MoveSidebarItemCommand {
  type: "move_sidebar_item";
  reqId?: string;
  item: SidebarItemRef;
  direction: "up" | "down";
}

export interface MoveSidebarItemsOptions {
  /** When moving within a folder for reordering, keep the existing pinned state. */
  preservePinned?: boolean;
  /** Used when no insertion anchor exists, e.g. moving a visual block to the bottom. */
  placement?: "bottom";
}

export interface MoveSidebarItemsCommand extends MoveSidebarItemsOptions {
  type: "move_sidebar_items";
  reqId?: string;
  items: SidebarItemRef[];
  parentId: string | null;
  /** Optional insertion anchor in the destination parent. Items are inserted before it. */
  before?: SidebarItemRef;
}

export interface DeleteFolderCommand {
  type: "delete_folder";
  reqId?: string;
  folderId: string;
  /**
   * recursive moves the entire folder tree to undoable trash.
   * unwrap removes only the folder shell and moves children up to the parent.
   * Defaults to recursive for backwards-compatible callers that omit it.
   */
  mode?: "recursive" | "unwrap";
}

export interface LoadFolderInstructionsCommand {
  type: "load_folder_instructions";
  reqId?: string;
  folderId: string;
}

export interface SetFolderInstructionsCommand {
  type: "set_folder_instructions";
  reqId?: string;
  folderId: string;
  /** Empty string clears the folder instructions document. */
  text: string;
}

export interface UndoDeleteCommand {
  type: "undo_delete";
  reqId?: string;
}

export interface RedoDeleteCommand {
  type: "redo_delete";
  reqId?: string;
}

export type QueueTiming = "next-turn" | "message-end";

export type QueueWaitTarget =
  | { type: "global" }
  | { type: "conversation"; convId: string; label: string }
  | { type: "folder"; folderId: string; label: string };

/** Canonical daemon-owned queue entry shared by every connected client. */
export interface QueuedMessageInfo {
  /** Stable client- or daemon-generated identity used for optimistic reconciliation. */
  id: string;
  convId: string;
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
  /** Ordinary stream queues are delivered next-turn/message-end; global-idle entries wait on waitTarget. */
  source: "daemon" | "global-idle";
  target?: "conversation" | "new-conversation";
  /** Captured settings used when target=new-conversation is created atomically with enqueue. */
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: boolean;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
  createdAt: number;
}

export interface QueueMessageCommand {
  type: "queue_message";
  reqId?: string;
  /** Stable optimistic id. The daemon generates one when omitted by non-UI callers. */
  queueId?: string;
  convId: string;
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
  source?: "daemon" | "global-idle";
  target?: "conversation" | "new-conversation";
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: boolean;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
}

export interface UnqueueMessageCommand {
  type: "unqueue_message";
  reqId?: string;
  /** Stable id is authoritative. convId/text remain optional for daemon-internal/legacy callers. */
  queueId?: string;
  convId?: string;
  text?: string;
}

export interface UpdateQueuedMessageCommand {
  type: "update_queued_message";
  reqId?: string;
  queueId: string;
  text: string;
  timing: QueueTiming;
  images?: ImageAttachment[];
}

export interface MoveQueuedMessageCommand {
  type: "move_queued_message";
  reqId?: string;
  queueId: string;
  direction: "up" | "down";
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

/** OpenAI OAuth flow selected by the user. Browser remains the default. */
export type OpenAILoginMethod = "browser" | "code";

export interface DeviceCodeAuthPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInSeconds: number;
}

export interface LoginCommand {
  type: "login";
  reqId?: string;
  provider?: ProviderId;
  /** Provider-specific secret. DeepSeek uses this for `/login deepseek <api-key>`. */
  apiKey?: string;
  /** Provider-specific subcommand. OpenAI supports add/remove. */
  action?: "add" | "remove";
  /** Provider-specific subcommand target. OpenAI remove uses this as email/censored-email. */
  target?: string;
  /** OpenAI OAuth flow. Omitted for the backwards-compatible browser flow. */
  method?: OpenAILoginMethod;
}

export interface AccountCommand {
  type: "account";
  reqId?: string;
  provider?: ProviderId;
  /** Account selector, currently OpenAI email/censored-email. Omitted to list accounts. */
  target?: string;
}

export interface LogoutCommand {
  type: "logout";
  reqId?: string;
  provider?: ProviderId;
}

export type Command =
  | PingCommand
  | PrepareShutdownCommand
  | NewConversationCommand
  | SendMessageCommand
  | ReplayConversationCommand
  | SetModelCommand
  | SetEffortCommand
  | SetFastModeCommand
  | SetGoalCommand
  | ManageExternalToolDaemonCommand
  | RegisterExternalNotificationSourceCommand
  | ListExternalNotificationSourcesCommand
  | ListExternalNotificationSubscriptionsCommand
  | SubscribeExternalNotificationCommand
  | UnsubscribeExternalNotificationCommand
  | UpdateExternalNotificationSubscriptionCommand
  | PublishExternalNotificationCommand
  | TrimConversationCommand
  | AbortCommand
  | BackgroundToolCommand
  | PrewarmConversationCommand
  | SubscribeCommand
  | UnsubscribeCommand
  | ListConversationsCommand
  | LoadConversationCommand
  | LoadConversationHistoryCommand
  | LoadToolOutputsCommand
  | DeleteConversationCommand
  | DeleteConversationsCommand
  | MarkConversationCommand
  | PinConversationCommand
  | MoveConversationCommand
  | RenameConversationCommand
  | GenerateTitleCommand
  | CloneConversationCommand
  | CreateFolderCommand
  | RenameFolderCommand
  | PinFolderCommand
  | PinSidebarItemsCommand
  | MoveSidebarItemCommand
  | MoveSidebarItemsCommand
  | DeleteFolderCommand
  | LoadFolderInstructionsCommand
  | SetFolderInstructionsCommand
  | UndoDeleteCommand
  | RedoDeleteCommand
  | QueueMessageCommand
  | UnqueueMessageCommand
  | UpdateQueuedMessageCommand
  | MoveQueuedMessageCommand
  | UnwindConversationCommand
  | SetSystemInstructionsCommand
  | LlmCompleteCommand
  | GetSystemPromptCommand
  | TranscribeAudioCommand
  | LoginCommand
  | AccountCommand
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
  goal?: ConversationGoal | null;
}

export type StreamingSnapshotKind = "start" | "catchup" | "heartbeat";

export interface StreamingStartedEvent {
  type: "streaming_started";
  convId: string;
  provider: ProviderId;
  model: ModelId;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  /** Why this streaming_started event was emitted. Omitted by older daemons. */
  snapshotKind?: StreamingSnapshotKind;
  /** When the AI started processing. Lets late-joining clients show the correct elapsed time. */
  startedAt: number;
  /** Accumulated blocks so far — included for late-joining clients and periodic catch-up snapshots. */
  blocks?: Block[];
  /** Canonical active-turn blocks represented by history before this live tail. */
  blockOffset?: number;
  /** Accumulated output tokens so far — included for late-joining clients and periodic catch-up snapshots. */
  tokens?: number;
  /** Active native-compaction start time for late-join/catch-up status rendering. */
  compactionStartedAt?: number | null;
}

export type StreamingStopReason = "daemon-restart";

export interface StreamingStoppedEvent {
  type: "streaming_stopped";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  /** Machine-readable reason for non-normal stops that clients must handle specially. */
  reason?: StreamingStopReason;
  /** On abort/error: the blocks that were safe to persist. TUI replaces its pending blocks with these. */
  persistedBlocks?: Block[];
}

export interface BlockStartEvent {
  type: "block_start";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  blockType: "text" | "thinking";
}

export interface TextChunkEvent {
  type: "text_chunk";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  text: string;
}

export interface ThinkingChunkEvent {
  type: "thinking_chunk";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  text: string;
}

/** Replace the live text/thinking tail with the daemon's canonical current-round blocks. */
export interface StreamingSyncEvent {
  type: "streaming_sync";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  blocks: Block[];
}

export interface ToolCallEvent {
  type: "tool_call";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export interface TokensUpdateEvent {
  type: "tokens_update";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  tokens: number;
}

export interface ContextUpdateEvent {
  type: "context_update";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  contextTokens: number;
}

export interface MessageCompleteEvent {
  type: "message_complete";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
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
  folders?: FolderSummary[];
}

export interface AIMessagePayload {
  blocks: Block[];
  metadata: MessageMetadata | null;
  /** Canonical active-turn blocks represented by entries before this live tail. */
  blockOffset?: number;
}

export type DisplayEntry =
  | { type: "system_instructions"; text: string }
  | { type: "user"; text: string; images?: ImageAttachment[]; metadata?: MessageMetadata | null; contextCheckpoint?: UserMessageContextCheckpoint }
  | { type: "ai"; blocks: Block[]; metadata: MessageMetadata | null }
  | { type: "system"; text: string; color?: string; metadata?: MessageMetadata | null };

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
  /** The requested newest history window in display order, plus pinned system instructions. */
  entries: DisplayEntry[];
  /** Absolute index of the first included non-instructions history entry. */
  historyStartIndex?: number;
  /** Absolute index of the first loaded user message. */
  historyStartUserIndex?: number;
  /** Total number of non-instructions history entries in the snapshot. */
  historyTotalEntries?: number;
  /** Whether older history can be requested before historyStartIndex. */
  hasOlderHistory?: boolean;
  /** Live assistant snapshot for actively streaming conversations. */
  pendingAI?: AIMessagePayload;
  /** Last known input token count for this conversation. */
  contextTokens: number | null;
  /** Whether tool_result block outputs are present in entries. */
  toolOutputsIncluded: boolean;
  /** Messages currently queued for delivery (so the TUI can show shadows). */
  queuedMessages?: QueuedMessageInfo[];
  /** Persistent objective attached to this conversation, if any. */
  goal?: ConversationGoal | null;
}

export interface ConversationHistoryLoadedEvent {
  type: "conversation_history_loaded";
  reqId?: string;
  convId: string;
  /** Echo of the UI action that caused this page request. */
  requestSource?: "initial-backfill" | "viewport";
  /** Older entries immediately preceding the client's current history window. */
  entries: DisplayEntry[];
  /** Absolute index of the first returned entry. */
  historyStartIndex: number;
  /** Absolute index of the first returned user message. */
  historyStartUserIndex: number;
  /** Absolute exclusive end cursor for this page. */
  historyEndIndex: number;
  /** Total entries in the snapshot used to build this page. */
  historyTotalEntries: number;
  /** Whether more history exists before historyStartIndex. */
  hasOlderHistory: boolean;
}

export interface GoalUpdatedEvent {
  type: "goal_updated";
  reqId?: string;
  convId: string;
  goal: ConversationGoal | null;
  message?: string;
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  summary: ConversationSummary;
  /** Set when this update represents a stream transitioning to stopped for a special reason. */
  streamStopReason?: StreamingStopReason;
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
  folders?: FolderSummary[];
}

export interface UserMessageEvent {
  type: "user_message";
  convId: string;
  /** Monotonic daemon event sequence when emitted inside an active stream (diagnostics). */
  streamSeq?: number;
  text: string;
  /** Client-originated timestamp when available; daemon-generated for queued sends. */
  startedAt?: number;
  images?: ImageAttachment[];
  /** Queue identity when this user message was accepted from the daemon-owned queue. */
  queueId?: string;
}

/** Authoritative full queue snapshot, broadcast after every mutation and during bootstrap. */
export interface QueueUpdatedEvent {
  type: "queue_updated";
  messages: QueuedMessageInfo[];
  /**
   * Queue ids conclusively touched for the requesting client. Enqueues settle
   * regardless of presence (an absent id may already be delivered/rejected);
   * unqueues settle only when the id is absent from `messages`.
   */
  settledQueueIds?: string[];
}

/** Asynchronous queue delivery/drop notice (for example a deleted wait target). */
export interface QueueNoticeEvent {
  type: "queue_notice";
  queueId: string;
  convId?: string;
  message: string;
  level: "warning" | "error";
}

export interface StreamRetryEvent {
  type: "stream_retry";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
  delaySec: number;
  kind?: "transient" | "usage_limit_reset";
  /** Unix epoch milliseconds when retry is expected, if known. */
  resetAt?: number;
}

export interface ContextCompactionStatusEvent {
  type: "context_compaction_status";
  convId: string;
  /** Monotonic daemon event sequence for the active stream. */
  streamSeq?: number;
  active: boolean;
  startedAt?: number;
  /** Successful completion time. When present, clients retain a history divider. */
  completedAt?: number;
}

export interface SystemMessageEvent {
  type: "system_message";
  convId: string;
  /** Monotonic daemon event sequence when emitted inside an active stream (diagnostics). */
  streamSeq?: number;
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
  /** Connected accounts for providers that support multi-account auth. */
  accounts?: ProviderAuthAccountInfo[];
  /** The account currently selected/last used by the provider. */
  currentAccount?: ProviderAuthAccountInfo | null;
}

export interface ProviderAuthAccountInfo {
  email: string | null;
  displayName: string | null;
  subscriptionType: string | null;
  accountId: string | null;
  current: boolean;
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
  /** Monotonic daemon event sequence when emitted inside an active stream (diagnostics). */
  streamSeq?: number;
  /** The newest buffered history window after modification. */
  entries: DisplayEntry[];
  /** Absolute index of the first included non-instructions history entry. */
  historyStartIndex?: number;
  /** Absolute index of the first loaded user message. */
  historyStartUserIndex?: number;
  /** Total number of non-instructions history entries in the snapshot. */
  historyTotalEntries?: number;
  /** Whether older history can be requested before historyStartIndex. */
  hasOlderHistory?: boolean;
  /** True when a destructive rewrite invalidated previously loaded absolute ranges. */
  resetHistoryWindow?: boolean;
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

export interface FolderInstructionsLoadedEvent {
  type: "folder_instructions_loaded";
  reqId?: string;
  folderId: string;
  text: string;
}

export interface FolderInstructionsUpdatedEvent {
  type: "folder_instructions_updated";
  reqId?: string;
  folderId: string;
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

export interface ExternalNotificationSourceEvent {
  type: "external_notification_source";
  reqId?: string;
  source: ExternalNotificationSource;
}

export interface ExternalNotificationSourcesEvent {
  type: "external_notification_sources";
  reqId?: string;
  sources: ExternalNotificationSource[];
}

export interface ExternalNotificationSubscriptionEvent {
  type: "external_notification_subscription";
  reqId?: string;
  subscription: ExternalNotificationSubscription;
}

export interface ExternalNotificationSubscriptionsEvent {
  type: "external_notification_subscriptions";
  reqId?: string;
  subscriptions: ExternalNotificationSubscription[];
  /** Number removed when this event acknowledges an unsubscribe command. */
  removed?: number;
}

export type ExternalNotificationDeliveryStatus = "started" | "queued" | "inbox" | "duplicate" | "failed";

export interface ExternalNotificationPublishDelivery {
  subscriptionId: string;
  convId: string;
  status: ExternalNotificationDeliveryStatus;
  message?: string;
}

export interface ExternalNotificationPublishResultEvent {
  type: "external_notification_publish_result";
  reqId?: string;
  toolName: string;
  sourceId: string;
  eventId: string;
  deliveries: ExternalNotificationPublishDelivery[];
}

export interface AuthStatusEvent {
  type: "auth_status";
  reqId?: string;
  /** Optional user-visible status text. openUrl-only events should not print a blank line. */
  message?: string;
  /** When set, the TUI should open this URL in the user's browser. */
  openUrl?: string;
  /** Headless-friendly device authorization instructions. */
  deviceCode?: DeviceCodeAuthPrompt;
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
  | ConversationHistoryLoadedEvent
  | GoalUpdatedEvent
  | ConversationUpdatedEvent
  | ConversationDeletedEvent
  | ConversationRestoredEvent
  | ConversationMarkedEvent
  | ConversationPinnedEvent
  | ConversationMovedEvent
  | QueueUpdatedEvent
  | QueueNoticeEvent
  | UserMessageEvent
  | StreamRetryEvent
  | ContextCompactionStatusEvent
  | SystemMessageEvent
  | ToolsAvailableEvent
  | HistoryUpdatedEvent
  | ToolOutputsLoadedEvent
  | SystemInstructionsUpdatedEvent
  | FolderInstructionsLoadedEvent
  | FolderInstructionsUpdatedEvent
  | LlmCompleteResultEvent
  | SystemPromptEvent
  | TranscriptionResultEvent
  | ExternalToolDaemonResultEvent
  | ExternalNotificationSourceEvent
  | ExternalNotificationSourcesEvent
  | ExternalNotificationSubscriptionEvent
  | ExternalNotificationSubscriptionsEvent
  | ExternalNotificationPublishResultEvent
  | AuthStatusEvent
  | ErrorEvent;
