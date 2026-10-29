import type { FastMode } from "./messages";
import type { ConversationDefaults } from "./config";
import type { ActiveTaskInfo } from "./messages";
import type { GenerationThroughput } from "./messages";
import type { MessageBilling } from "./messages";
/**
 * @exocortex/shared — IPC protocol.
 *
 * The single source of truth for the wire contract between
 * exocortexd and its clients.
 *
 * Transport: Unix domain socket, newline-delimited JSON.
 * Commands flow client → daemon. Events flow daemon → client.
 */

import type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, FolderSummary, SidebarItemRef, ToolDisplayInfo, ExternalToolStyle, ToolCallPresentation, ImageAttachment, ImageRef, TokenStatsSnapshot, TokenUsageSource, ConversationGoal, ConversationGoalStatus, ConversationBtw, UserMessageContextCheckpoint, ExternalNotificationDelivery, UserMessageAutomation } from "./messages";
import type { UpdateStatus } from "./updatecheck";
import type { ChronoRecurrence } from "./chrono";
import type { SidebarDigest } from "./sidebar-digest";
import type { SidebarViewHint } from "./sidebar-first-page";
export type { SidebarViewHint };
import type { ProviderProxiesEvent, ProviderProxyCommand, ProviderProxyInfo, ProviderProxyLinkCommand, ProviderProxyLinkEvent } from "./provider-proxy";
import type { UserMacro } from "./user-macros";
export type { UserMacro };
import type { AppClientInfo, AppConversationInfo, AppLifetime, AppRouteSpec, AppSystemSpec, AppToolsSpec, TurnStopReason } from "./app-api";
export type { AppBuiltinTool, AppClientInfo, AppConversationInfo, AppLifetime, AppRouteSpec, AppSystemBase, AppSystemSpec, AppToolDef, AppToolsSpec, TurnStopReason } from "./app-api";
export type * from "./provider-proxy";
export type { ProviderId, ProviderInfo, ModelId, EffortLevel, Block, MessageMetadata, UsageData, ConversationSummary, FolderSummary, SidebarItemRef, ToolDisplayInfo, ExternalToolStyle, ToolCallPresentation, ImageAttachment, ImageRef, TokenStatsSnapshot, TokenUsageSource, ConversationGoal, ConversationGoalStatus, ConversationBtw, UserMessageContextCheckpoint, ExternalNotificationDelivery, UserMessageAutomation };

// ── Commands (client → daemon) ──────────────────────────────────────

/**
 * The connection bootstrap: answered with `pong`, then tools_available,
 * user_macros, usage_update per provider, update_status (with the
 * update-status-push capability, once known) and the large conversations_list,
 * queue_updated and connectivity_status. See docs/daemon-ipc.md.
 */
export interface PingCommand {
  type: "ping";
  reqId?: string;
  /** Read-only update query without the normal conversation/usage bootstrap. */
  updateStatusOnly?: boolean;
}

/** Defaults are persisted and validated on the connected daemon host. */
export interface SetConversationDefaultsCommand {
  type: "set_conversation_defaults";
  reqId?: string;
  defaults: ConversationDefaults;
}

export interface ResetConversationDefaultsCommand {
  type: "reset_conversation_defaults";
  reqId?: string;
}

/** User macros are persisted and validated on the connected daemon host. */
export interface SaveUserMacroCommand {
  type: "save_user_macro";
  reqId?: string;
  macro: UserMacro;
  /** Refuse to replace an existing macro of the same name. */
  create?: boolean;
}

export interface DeleteUserMacroCommand {
  type: "delete_user_macro";
  reqId?: string;
  name: string;
}

/**
 * Read one filesystem directory for prompt-line path completion.
 *
 * `directory` remains in the spelling used by the prompt (for example `~/src/`
 * or `../`) so the client can cache and reuse the result without learning the
 * daemon host's absolute home/cwd paths.
 */
export interface ListPathDirectoryCommand {
  type: "list_path_directory";
  reqId: string;
  directory: string;
  /** Entry-name prefix already typed after the final slash. */
  prefix: string;
}

/** Resolve a Markdown local-file destination on the daemon host. */
export interface ResolveFileLinkCommand {
  type: "resolve_file_link";
  reqId: string;
  convId: string;
  target: string;
}

export interface PathDirectoryEntry {
  name: string;
  type: "dir" | "file";
}

export interface PathDirectoryListing {
  /** Prompt-spelled directory token corresponding to these entries. */
  directory: string;
  /** Every returned entry starts with this prefix. */
  prefix: string;
  entries: PathDirectoryEntry[];
  /** True when an unusually large directory was bounded for IPC safety. */
  truncated?: boolean;
}

export type DaemonShutdownMode = "stop" | "restart";

/** Service wrapper handshake before it sends the daemon its shutdown signal. */
export interface PrepareShutdownCommand {
  type: "prepare_shutdown";
  reqId?: string;
  mode: DaemonShutdownMode;
  /**
   * Restart only: also interrupt running turns for replay and answer with
   * shutdown_prepared once they settle. Daemons predating this answer ack.
   */
  interruptForReplay?: boolean;
  /** Upper bound on waiting for interrupted turns to settle. */
  timeoutMs?: number;
}

/** Ask the daemon on this connection to restart its own process instance. */
export interface RestartDaemonCommand {
  type: "restart_daemon";
  reqId?: string;
}

export interface NewConversationCommand {
  /** Apply current-generation delegation model policy (independent of folder placement). */
  delegation?: boolean;
  legacy?: boolean;
  type: "new_conversation";
  reqId?: string;
  /** Optional client-generated id so follow-up commands (notably early abort) can target the conversation before the create ack arrives. */
  convId?: string;
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: FastMode;
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
  /** Optional goal active-time limit in milliseconds. */
  goalMaxTimeMs?: number;
  /** @deprecated Retired; daemon rejects requests containing this field. */
  draftToolPolicyId?: string;
  /**
   * App conversation (docs/app-api.md): the app's name. Defaults to the name
   * the connection declared in client_capabilities; the fields below need it.
   */
  app?: string;
  /** App conversations only; default "saved". */
  lifetime?: AppLifetime;
  /** Temporary app conversations only: deleted this long after their last activity (default 1 h). */
  idleTtlMs?: number;
  /** App conversations only: the app's system prompt and what it is added to (default base "none"). */
  system?: AppSystemSpec;
  /** App conversations only: an existing absolute directory tools run in. Never created, moved or deleted. */
  cwd?: string;
  /** App conversations only: built-in tools by neutral name and the app's own tools (default none). */
  tools?: AppToolsSpec;
  /** App conversations only: how its Claude turns may be billed (default: as an ordinary conversation). */
  route?: AppRouteSpec;
}

export interface ParentNotificationTarget {
  /** Parent conversation to notify when this detached child task completes. */
  convId: string;
  /** Maximum characters of child result to include in the parent notification. */
  maxChars?: number;
}

export interface SendMessageCommand {
  /**
   * Sent by the `exo` CLI, not typed by the owner: the prompt is stored as an
   * automated `exo_send`, never in the owner's bubble.
   */
  delegation?: boolean;
  /**
   * The conversation sending a delegation (the CLI reads its shell's
   * EXOCORTEX_PARENT_CONV_ID); recorded as the prompt's automation source.
   * Ignored without `delegation` or when no such conversation exists.
   */
  sender?: string;
  legacy?: boolean;
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
  /** Answer this request with turn_result when the turn ends (docs/app-api.md). */
  awaitResult?: boolean;
}

export interface ReplayConversationCommand {
  type: "replay_conversation";
  reqId?: string;
  convId: string;
  /** Client-originated timestamp for the replayed assistant turn. */
  startedAt: number;
}

export interface CompactConversationCommand {
  type: "compact_conversation";
  reqId?: string;
  convId: string;
  /** Client-originated timestamp used for progress and cancellation state. */
  startedAt: number;
}

/** Start an isolated BTW thread owned by a conversation until explicitly closed. */
export interface BtwQueryCommand {
  type: "btw_query";
  reqId?: string;
  /** Client-generated identity used to reject stale events and closes. */
  sessionId: string;
  convId: string;
  query: string;
  startedAt: number;
}

/** Add a question to an existing retained BTW thread. */
export interface BtwFollowupCommand {
  type: "btw_followup";
  reqId?: string;
  convId: string;
  /** Existing panel/thread identity. */
  sessionId: string;
  /** Client-generated mutation identity for this follow-up turn. */
  turnId: string;
  query: string;
  startedAt: number;
}

/** Close a conversation's durable BTW session, aborting it first when still running. */
export interface BtwCloseCommand {
  type: "btw_close";
  reqId?: string;
  convId: string;
  sessionId?: string;
}

export interface AbortCommand {
  type: "abort";
  reqId?: string;
  convId: string;
  /**
   * Identity of the stream the client intended to interrupt. The daemon ignores
   * the command if that stream has already stopped and a queued turn has begun.
   * Omitted by legacy and daemon-internal callers that intentionally target the
   * conversation's current stream.
   */
  expectedStartedAt?: number;
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
  /** Reserve transport for a client-generated draft ID without creating history. */
  draft?: boolean;
}

/**
 * history-block-pagination: history windows are byte-budgeted and may begin or
 * end inside an AI entry (historyStartBlockIndex / beforeBlockIndex).
 *
 * token-stats-on-demand: the client asks for token_stats with get_token_stats
 * instead of receiving the (hundreds of KB) snapshot on every connect and
 * after every completed turn.
 *
 * sidebar-digest-sync: the client can rebuild a conversations_list that
 * carries `sidebarBuckets` (see ClientCapabilitiesCommand.sidebarDigest).
 *
 * history-folded-elision: history pages requested folded (viewport.folded,
 * load_conversation_history `folded`) leave out the content of the work a
 * folded client hides (see ElidedBlockRef); the client fetches it with
 * load_display_blocks before showing it.
 *
 * history-revisions: the daemon pushes history_revisions whenever what a
 * conversation's history pages show may have changed (see HistoryRevisionsEvent),
 * so a client that keeps opened pages can tell a current copy from a stale one.
 */
export type ClientCapability = "targeted-unwind" | "sidebar-reorder-delta" | "sidebar-state-patch" | "history-block-pagination" | "token-stats-on-demand" | "sidebar-digest-sync" | "update-status-push" | "sidebar-incremental" | "client-exec-alive" | "history-folded-elision" | "history-revisions";

/** Answered with token_stats carrying the same reqId. Older daemons answer with an Unknown command error. */
export interface GetTokenStatsCommand {
  type: "get_token_stats";
  reqId?: string;
}

/** Connection-scoped feature negotiation for backwards-compatible events. */
export interface ClientCapabilitiesCommand {
  type: "client_capabilities";
  /** Answered with app_welcome when `app` is set; otherwise unanswered. */
  reqId?: string;
  capabilities: ClientCapability[];
  /**
   * This connection is an app client (docs/app-api.md): it gets answers to its
   * own requests and events for the conversations it owns or subscribes to,
   * never the TUI's broadcasts. Answered with app_welcome.
   */
  app?: AppClientInfo;
  /**
   * The machine a TUI connected over /ssh runs on. The daemon sends that
   * connection client_exec_request for the model's client_bash calls.
   */
  clientHost?: ClientHostInfo;
  /**
   * With sidebar-digest-sync: the conversation list the client already holds
   * (see shared/src/sidebar-digest.ts). The connection's next
   * conversations_list then carries only rows of buckets whose hash differs.
   * Used once; older daemons ignore it.
   */
  sidebarDigest?: SidebarDigest;
  /**
   * With sidebar-incremental: what the sidebar will draw first. The next
   * ping bootstrap (without a digest) sends the conversation list in two
   * parts, a first page for this view, then the rest. Used once.
   */
  sidebarView?: SidebarViewHint;
}

/** The user's own machine, as announced by an SSH-connected TUI or a linking daemon. */
export interface ClientHostInfo {
  hostname: string;
  user: string;
  /** Node's process.platform, e.g. "linux", "darwin", "win32". */
  platform: string;
  home: string;
  /**
   * The announcing install's random ID (clientInstallId), so two machines
   * with the same user@hostname are told apart. Older clients send none.
   */
  installId?: string;
}

/**
 * With client-exec-alive: the TUI has client_exec_requests running (sent at
 * once for a new one, then every EXEC_ALIVE_INTERVAL_MS), so the daemon fails
 * a call fast when the TUI is frozen or gone instead of waiting out its timeout.
 */
export interface ClientExecAliveCommand {
  type: "client_exec_alive";
  execIds: string[];
}

/** The outcome of one client_exec_request, run on the TUI's machine. */
export interface ClientExecResultCommand {
  type: "client_exec_result";
  execId: string;
  /** Interleaved stdout and stderr, at most 1MB. */
  output: string;
  byteTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Why the command could not start or finish, if it could not. */
  error?: string;
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

/** Opt-in to incremental history responses. SHA-256 (lowercase hex) of each
 * JSON.stringify(displayEntry), in cache order; at most 2048 entries. The client
 * must retain these exact immutable entries until this request completes.
 * Omitted/invalid hashes receive the normal full response. */
export interface CachedHistoryRequest {
  cachedEntryHashes?: string[];
}

export interface LoadConversationCommand extends CachedHistoryRequest {
  type: "load_conversation";
  reqId?: string;
  convId: string;
  /** Client wall-clock time used only to diagnose IPC/event-loop queue delay. */
  requestedAt?: number;
  /**
   * Number of newest user turns (1..100) to include in the opening payload.
   * The TUI sizes this to its terminal height; byte-budgeted clients still
   * receive at most HISTORY_PAGE_BYTE_BUDGET of history.
   */
  turns?: number;
  /**
   * The client's history viewport in terminal cells (rows 1..1000, cols
   * 1..4000). With `history-block-pagination`, the opening window holds as
   * many turns as it takes (up to 100) for its estimated rendered rows to
   * fill two of these screens, still within the byte budget; `turns` is then
   * ignored. Older daemons ignore it and honor `turns`. `folded` says the
   * client folds each turn's work and each notification to one row, so turns
   * are estimated that way; with `history-folded-elision` the opening window
   * and its initialBackfill also leave out the content of that work.
   */
  viewport?: { rows: number; cols: number; folded?: boolean };
  /**
   * The history page the client would request next (older than the opening
   * window): the daemon sends it right after this conversation_loaded, as the
   * conversation_history_loaded answer to `reqId`, from the same snapshot, so
   * opening takes one round trip instead of two. The loaded event names
   * `reqId` in `initialBackfillReqId` when the page follows; otherwise (no
   * older history, an older daemon) the client requests it as before.
   */
  initialBackfill?: { reqId: string; turns: number } & CachedHistoryRequest;
  /**
   * Fetch the pages without opening the conversation: no subscription, no
   * unread change, no prewarm, no streaming or BTW catch-up. A client keeping
   * a copy of recently opened conversations refreshes it this way. Only for
   * daemons that answered get_history_revisions: an older daemon ignores the
   * flag and opens the conversation.
   */
  peek?: true;
}

/**
 * The current history revision of each named conversation (see
 * HistoryRevisionsEvent), answered with history_revisions carrying the same
 * reqId. Unknown and deleted conversations are left out. Older daemons
 * answer with an Unknown command error.
 */
export interface GetHistoryRevisionsCommand {
  type: "get_history_revisions";
  reqId?: string;
  /** At most 512 conversation ids. */
  convIds: string[];
}

export interface LoadConversationHistoryCommand extends CachedHistoryRequest {
  type: "load_conversation_history";
  reqId?: string;
  convId: string;
  /** UI action that caused this page request; diagnostic only. */
  requestSource?: "initial-backfill" | "viewport";
  /** Absolute entry cursor returned by the preceding history payload. */
  beforeEntryIndex: number;
  /** Block cursor within the entry at beforeEntryIndex; its earlier blocks end the page. */
  beforeBlockIndex?: number;
  /** Maximum number of user turns to load before the cursor. */
  turns: number;
  /**
   * The client folds each turn's work (as viewport.folded on an open). With
   * `history-folded-elision`, the page leaves out the content of that work.
   */
  folded?: boolean;
}

/**
 * Fetch the content of elided blocks (ElidedBlockRef): for each range, blocks
 * [start, end) of the display entry at `entry`. Answered with
 * display_blocks_loaded; older daemons answer with an Unknown command error.
 */
export interface LoadDisplayBlocksCommand {
  type: "load_display_blocks";
  reqId?: string;
  convId: string;
  ranges: Array<{ entry: number; start: number; end: number }>;
  /** Stop the reply at about this many serialized bytes (still at least one block); default and cap 2 MB. */
  maxBytes?: number;
}

/**
 * Fetch a bounded preview of a stored or user-pasted image for display.
 * `png` is for terminal graphics; `rgba` returns raw 8-bit RGBA pixels at
 * exactly the requested size (for character-cell fallbacks).
 */
export interface GetImageCommand {
  type: "get_image";
  reqId: string;
  /** Needed for user-pasted images, which live in the conversation itself. */
  convId?: string;
  imageId: string;
  format: "png" | "rgba";
  /** png: fit within these bounds (never upscaled). rgba: exact output size. */
  width: number;
  height: number;
  /** png: a history thumbnail, which the daemon may quantize to 256 colours. Older daemons ignore it. */
  purpose?: "thumbnail";
}

export interface LoadToolOutputsCommand {
  type: "load_tool_outputs";
  reqId?: string;
  convId: string;
  /**
   * Limit the response to tool results currently materialized by the client.
   * Omission preserves compatibility with clients that expect the full transcript.
   */
  toolCallIds?: string[];
}

export interface SetModelCommand {
  delegation?: boolean;
  legacy?: boolean;
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
  enabled: FastMode;
}

export type GoalAction = "show" | "set" | "pause" | "resume" | "complete" | "clear";

export interface SetGoalCommand {
  type: "set_goal";
  reqId?: string;
  convId: string;
  action: GoalAction;
  objective?: string;
  /** Optional active-time limit in milliseconds for `set`. */
  maxTimeMs?: number;
}

export type ChronoAction = "list" | "create" | "cancel";

/** A Chrono repeat as typed by a user or model; the daemon resolves it to a ChronoRecurrence. */
export interface ChronoRepeat {
  unit: "minute" | "hour" | "day" | "week" | "month";
  interval?: number;
  weekdays?: Array<"sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat">;
}

/** User-managed Chrono schedules owned by one conversation (`/chrono`). */
export interface ChronoCommand {
  type: "chrono";
  reqId?: string;
  convId: string;
  action: ChronoAction;
  /** For create: first occurrence as an ISO-8601 instant with an explicit offset. */
  at?: string;
  repeat?: ChronoRepeat;
  /** For create: IANA timezone whose wall clock day/week/month repeats keep. */
  timezone?: string;
  /** For create: exactly one of a message (starts a model turn) or a shell command (runs without one). */
  message?: string;
  command?: string;
  /** For cancel: an exact schedule id, a unique prefix of its short id, or `all`. */
  scheduleId?: string;
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

/** JSON-compatible untrusted data published alongside an external event's text. */
export type ExternalNotificationJsonValue =
  | null
  | boolean
  | number
  | string
  | ExternalNotificationJsonValue[]
  | { [key: string]: ExternalNotificationJsonValue };

/** Optional model escalation after a subscription command soft-wake. */
export interface ExternalNotificationHardWake {
  /** `failure` includes a script-defined non-zero exit; `always` also wakes on success. */
  when: "failure" | "always";
  message: string;
  includeOutput: boolean;
}

/** Subscriber-owned static command run for each event without invoking a model. */
export interface ExternalNotificationSoftWake {
  command: string;
  timeoutMs: number;
  hardWake?: ExternalNotificationHardWake;
}

/** A durable route from an external event source to an Exocortex conversation. */
export interface ExternalNotificationSubscription {
  id: string;
  toolName: string;
  sourceId: string;
  sourceLabel: string;
  sourceDescription?: string;
  /** Short user-set display name; shown instead of `sourceLabel` when present. */
  name?: string;
  convId: string;
  delivery: ExternalNotificationDelivery;
  /** Required when delivery is `soft`; external event content is provided as JSON on stdin. */
  softWake?: ExternalNotificationSoftWake;
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
  /** Short display name (max 48 chars). Omitted keeps an existing route's name. */
  name?: string;
  convId: string;
  delivery?: ExternalNotificationDelivery;
  softWake?: ExternalNotificationSoftWake;
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
  softWake?: ExternalNotificationSoftWake;
  enabled?: boolean;
  /** Rename the route (max 48 chars); an empty string clears the name. */
  name?: string;
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
  /** Optional structured untrusted event data for deterministic soft-wake commands. */
  data?: ExternalNotificationJsonValue;
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

export interface MuteConversationCommand {
  type: "mute_conversation";
  reqId?: string;
  convId: string;
  muted: boolean;
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

export interface MuteFolderCommand {
  type: "mute_folder";
  reqId?: string;
  folderId: string;
  muted: boolean;
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

/**
 * When a queued message is delivered to a streaming conversation.
 * - "next-turn": joins the active turn. A person's message steers it now: the
 *   response being generated is preempted (its streamed part is kept) and a
 *   backgroundable running tool is moved to the background. Automated entries
 *   wait for the next tool boundary. Claude Code takes every entry in at its
 *   own next tool boundary instead, without preempting.
 * - "message-end": starts a new turn after the active one ends.
 */
export type QueueTiming = "next-turn" | "message-end";

export type QueueWaitTarget =
  | { type: "global" }
  | { type: "conversation"; convId: string; label: string }
  | { type: "folder"; folderId: string; label: string }
  /**
   * Due `delayMs` after the entry's daemon-assigned `createdAt`, then sent once
   * its own conversation is idle. Timed entries never block the idle FIFO.
   */
  | { type: "delay"; delayMs: number; label: string };

/** A slash command that the daemon can execute when a durable queue entry becomes ready. */
export interface QueuedCommandInvocation {
  /** Registered slash-command name, including its leading slash. Arguments remain in the entry text. */
  name: string;
}

/** Canonical daemon-owned queue entry shared by every connected client. */
export interface QueuedMessageInfo {
  /** Stable client- or daemon-generated identity used for optimistic reconciliation. */
  id: string;
  convId: string;
  text: string;
  /** A queued command to execute instead of delivering text as a user message. */
  command?: QueuedCommandInvocation;
  timing: QueueTiming;
  images?: ImageAttachment[];
  /** Ordinary stream queues are delivered next-turn/message-end; global-idle entries wait. */
  source: "daemon" | "global-idle";
  /** Present when this queued prompt was authored by Exocortex automation rather than a user/client. */
  automation?: UserMessageAutomation;
  target?: "conversation" | "new-conversation";
  /** Captured settings used when target=new-conversation is created atomically with enqueue. */
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: FastMode;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
  createdAt: number;
}

export interface QueueMessageCommand {
  /** As SendMessageCommand.delegation: queued by the `exo` CLI, stored as automated. */
  delegation?: boolean;
  /** As SendMessageCommand.sender. */
  sender?: string;
  legacy?: boolean;
  type: "queue_message";
  reqId?: string;
  /** Stable optimistic id. The daemon generates one when omitted by non-UI callers. */
  queueId?: string;
  convId: string;
  text: string;
  /** Execute a supported command when this queue entry becomes ready. */
  command?: QueuedCommandInvocation;
  timing: QueueTiming;
  images?: ImageAttachment[];
  source?: "daemon" | "global-idle";
  target?: "conversation" | "new-conversation";
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  fastMode?: FastMode;
  folderId?: string | null;
  waitTarget?: QueueWaitTarget;
  /** @deprecated Retired; daemon rejects requests containing this field. */
  draftToolPolicyId?: string;
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
  /** Globally unique mutation identity; separate from socket-local request correlation. */
  operationId: string;
  convId: string;
  /** Index counting only user messages (0-based). Everything from this message onward is removed. */
  userMessageIndex: number;
  /** Stable target identity when the message has daemon-authored metadata. */
  expectedStartedAt?: number;
  /** Daemon-authored hash of the transcript prefix through the selected message. */
  targetFingerprint?: string;
}

export interface SetSystemInstructionsCommand {
  type: "set_system_instructions";
  reqId?: string;
  convId: string;
  /**
   * The instructions text. Empty string clears them. Accepted while the
   * conversation streams: reads see it at once, history gets it once idle.
   */
  text: string;
}

/** Read every instruction scope that applies to a conversation (or a draft in a folder). */
export interface LoadInstructionsCommand {
  type: "load_instructions";
  reqId?: string;
  /** The conversation whose own instructions to read; omit for a draft. */
  convId?: string;
  /** The folder whose own instructions to read; omit or null outside folders. */
  folderId?: string | null;
}

/**
 * Read what the model is told about each tool on a conversation's provider and
 * route: internal tools (schema description and prompt hint) and external tools
 * (manifest systemHint), exactly as injected. Answered with
 * tool_instructions_loaded; save_tool_instructions writes edited blocks back.
 */
export interface LoadToolInstructionsCommand {
  type: "load_tool_instructions";
  reqId?: string;
  /** The conversation whose provider and model decide the route; omit for a draft. */
  convId?: string;
  /** A draft's provider and model; ignored with convId. Defaults to the daemon's. */
  provider?: ProviderId;
  model?: ModelId;
}

/** One edited block of /instructions tools. */
export interface ToolInstructionsEdit {
  /** The block's id from tool_instructions_loaded. */
  id: string;
  /** The new text as the model should get it; empty clears a hint. */
  text: string;
  /** The block's text as loaded; when the daemon's differs the save is refused unless `force`. */
  expected: string;
}

/**
 * Write edited /instructions tools blocks to the files they come from (a
 * built-in tool's text file, an external tool's manifest systemHint), commit
 * each repository with exactly those paths, pull --rebase and push. Answered
 * with tool_instructions_saved, or an error when nothing was written. The
 * next turn of every conversation gets the new text.
 */
export interface SaveToolInstructionsCommand {
  type: "save_tool_instructions";
  reqId?: string;
  /** As in load_tool_instructions: the route the blocks were loaded for, so placeholders expand alike. */
  convId?: string;
  provider?: ProviderId;
  model?: ModelId;
  edits: ToolInstructionsEdit[];
  /** Overwrite blocks that changed since they were loaded. */
  force?: boolean;
}

/** Set this install's app-wide instructions (config/system.md), layered after the read-only base. */
export interface SetGlobalInstructionsCommand {
  type: "set_global_instructions";
  reqId?: string;
  /** Empty string clears them. */
  text: string;
  /** When set, the write is refused if the current text differs (edited elsewhere meanwhile). */
  expectedText?: string;
}

export interface LlmCompleteCommand {
  delegation?: boolean;
  legacy?: boolean;
  effort?: EffortLevel;
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

/** Inspect managed work, including exact task IDs, output paths and process metadata. */
export interface ListTasksCommand {
  type: "list_tasks";
  reqId?: string;
  /** Omit to list all active work. */
  convId?: string;
}

/** Stop one exact managed background task, never an arbitrary operating-system PID. */
export interface StopTaskCommand {
  type: "stop_task";
  reqId?: string;
  convId: string;
  taskId: string;
}

export interface TasksListEvent {
  type: "tasks_list";
  reqId?: string;
  tasks: ActiveTaskInfo[];
}

export interface TaskStoppedEvent {
  type: "task_stopped";
  reqId?: string;
  convId: string;
  taskId: string;
  status: "stopping";
}

/** Rejection-only tombstone for old clients; no policy payload is interpreted. */
export interface RetiredToolSelectionCommand {
  type: "get_tool_policy" | "set_tool_policy" | "get_draft_tool_policy"
    | "set_draft_tool_policy" | "clear_draft_tool_policy";
  reqId?: string;
  convId?: string;
  draftId?: string;
  mutation?: unknown;
}

export interface TranscribeAudioCommand {
  type: "transcribe_audio";
  reqId?: string;
  /** Base64-encoded audio payload (typically WAV) captured by the TUI. */
  audioBase64: string;
  /** MIME type for the uploaded audio. */
  mimeType: string;
  /** Upload filename for the transcription backend (e.g. the `transcribe` CLI's input file name). */
  filename?: string;
}

/**
 * Generate a raster image with the daemon's OpenAI login. Used by the `image`
 * external tool, so provider credentials never leave the daemon.
 */
export interface GenerateImageCommand {
  type: "generate_image";
  reqId?: string;
  /** Exact UTF-8 prompt. */
  prompt: string;
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
  /**
   * Account selector: an OpenAI email/censored-email to switch to, or the
   * Claude account name for `action`. Omitted to list accounts.
   */
  target?: string;
  /**
   * Anthropic only: `add` registers Claude account `target` (a Claude Code
   * config directory to sign in to), `remove` unregisters it. Claude accounts
   * are chosen per conversation automatically, never switched globally.
   */
  action?: "add" | "remove";
  /** Anthropic `add`: the config directory (default `~/.claude-<target>`). */
  configDir?: string;
}

/**
 * The Accounts screen's data: every Claude and OpenAI account as structured
 * fields (`/account claude` keeps its text report). The reply is an
 * `accounts` event with the same `reqId`. With `watch: true` the client also
 * receives an `accounts` event (no `reqId`) whenever an account's sign-in,
 * usage, limits or running turns change, until it sends `watch: false` or
 * disconnects; only while `enabled` (several accounts). `convId` names the
 * client's current conversation, reported back as `claude.currentConversation`.
 */
export interface AccountsCommand {
  type: "accounts";
  reqId?: string;
  watch?: boolean;
  convId?: string;
}

export type ClaudeAccountState =
  /** Signed in with a Claude subscription and able to take turns. */
  | "ready"
  /** Rejected at a usage limit until `limitedUntil`. */
  | "limited"
  /** Failed authentication; out of routing until `blockedUntil`. */
  | "blocked"
  | "signed_out"
  /** Signed in, but not with a Claude subscription (`stateDetail` names the method). */
  | "not_subscription"
  /** Not checked yet. */
  | "unchecked";

export interface AccountConversationInfo {
  convId: string;
  /** When its last request on this account was made (ms). */
  lastUsedAt: number;
  /** A turn is running on this account now. */
  running: boolean;
  /** Its prompt cache on this account is still warm (`lastUsedAt` within `routing.cacheTtlMs`). */
  warm: boolean;
  /** A conversation of the /proxy remote (`ClaudeAccountsInfo.remote`), not of this daemon: it cannot be opened here. */
  remote?: boolean;
}

export interface ClaudeAccountInfo {
  /** Account name (`main`, `max2`, …). */
  id: string;
  email: string | null;
  /** Claude subscription type (`max`, `pro`, …). */
  plan: string | null;
  /** Claude Code config directory, `~`-relative when under home. */
  configDir: string;
  state: ClaudeAccountState;
  /** Block reason or sign-in method, when `state` needs one. */
  stateDetail: string | null;
  limitedUntil: number | null;
  blockedUntil: number | null;
  /** This account's own windows (no `capacity`). */
  usage: UsageData | null;
  /** When `usage` was last reported (ms), null if never by this daemon. */
  usageUpdatedAt: number | null;
  activeTurns: number;
  /** Conversations on this account now: running or with a warm cache, most recent first. */
  conversations: AccountConversationInfo[];
  /** The terminal command that signs it in, when it is not signed in with a subscription. */
  loginCommand: string | null;
  /** Its plan's Claude API credits, when the API-credit fallback has a key for it with grants configured. */
  credits?: AccountCredits | null;
}

/** Prepaid API credits: what is left of the grants that have not expired. */
export interface AccountCredits {
  /**
   * The balance: the Claude Console's at its last sync less what Exocortex
   * counted since, else the configured grants less what it counted.
   */
  balanceUsd: number;
  /** What those grants granted. */
  grantedUsd: number;
  /** When each of them expires (ms), soonest first. */
  expiresAt: number[];
  /** A turn is spending these credits now. */
  active: boolean;
  /** Only an estimate: never synced from the provider's console, or synced hours ago. */
  approximate?: boolean;
  /** The console session the balance is read through is signed out. */
  signInNeeded?: boolean;
}

export interface ClaudeRoutingInfo {
  cacheTtlMs: number;
  fiveHourFloor: number;
  weeklyFloor: number;
  fiveHourComfort: number;
  scoreTie: number;
  coldMoveRatio: number;
}

export interface ClaudeAccountsInfo {
  /**
   * Claude runs through /proxy and the remote's accounts are unknown (not
   * received yet, or its daemon predates sharing them): nothing here applies.
   * False when `remote` lists them instead.
   */
  proxied: boolean;
  /**
   * The accounts are the /proxy remote's (its pool, usage and conversations).
   * Turns from this machine run on the remote's `main` account; rows of this
   * machine's conversations are listed under it.
   */
  remote?: ClaudeAccountsRemoteInfo;
  accounts: ClaudeAccountInfo[];
  /** The usage bars' combined numbers (`capacity` 100 per usable account). */
  combined: UsageData | null;
  routing: ClaudeRoutingInfo;
  /** Where new work would go now, and why. */
  nextNewWork: { account: string; detail: string } | null;
  /** The command's `convId`, with the account it last ran on (null: none yet). */
  currentConversation?: { convId: string; account: string | null; lastUsedAt: number | null; warm: boolean };
}

export interface ClaudeAccountsRemoteInfo {
  /** The SSH alias Claude goes through. */
  alias: string;
  /** `user@hostname` of the remote, once known. */
  host: string | null;
  /** The link's state; the accounts are the last ones received while it is not `connected`. */
  state: ProviderProxyInfo["state"];
  /** Why the link is down or the remote cannot serve Claude. */
  message?: string;
}

export interface OpenAIAccountInfo {
  index: number;
  email: string | null;
  displayName: string | null;
  plan: string | null;
  current: boolean;
}

export interface AccountsSnapshot {
  generatedAt: number;
  /** Several accounts are set up: more than one Claude account (here, or on the /proxy remote), or more than one OpenAI account. */
  enabled: boolean;
  claude: ClaudeAccountsInfo;
  /** OpenAI's account pool (`/account` switches the current one); `proxied`: /proxy uses the remote's login. */
  openai: { proxied: boolean; accounts: OpenAIAccountInfo[] };
}

export interface ConsumeUsageResetCommand {
  type: "consume_usage_reset";
  reqId?: string;
  provider?: ProviderId;
}

export interface LogoutCommand {
  type: "logout";
  reqId?: string;
  provider?: ProviderId;
}

// ── App API (docs/app-api.md) ───────────────────────────────────────

/**
 * Become the owner of an app conversation: its app tool calls come here (any
 * still unanswered are sent again), and its events (it subscribes). Counts as
 * activity. `tools.app` replaces the conversation's app tool definitions.
 * Answered with app_conversation_attached.
 */
export interface AttachAppConversationCommand {
  type: "attach_app_conversation";
  reqId?: string;
  convId: string;
  tools?: Pick<AppToolsSpec, "app">;
  /** Replaces its route preferences from the next turn on. */
  route?: AppRouteSpec;
}

/**
 * The app client is done with its session: its ephemeral conversations end
 * now instead of waiting the reconnect grace. Answered with app_session_ended.
 */
export interface EndAppSessionCommand {
  type: "end_app_session";
  reqId?: string;
}

/** The owner's answer to an app_tool_call. Unanswered; a late or duplicate result is ignored. */
export interface AppToolResultCommand {
  type: "app_tool_result";
  convId: string;
  callId: string;
  output: string;
  isError?: boolean;
}

/**
 * Create an app conversation, send `prompt` and answer turn_result when the
 * turn ends; conversation_created (same reqId) announces it first. App tools
 * work during the call. An ephemeral one (the default) is deleted after the
 * turn unless `keep`.
 */
export interface AppRunCommand {
  type: "app_run";
  reqId?: string;
  /** Default: the name the connection declared. */
  app?: string;
  /** Optional client-generated conversation id (like new_conversation's). */
  convId?: string;
  /** Default "ephemeral". */
  lifetime?: AppLifetime;
  idleTtlMs?: number;
  title?: string;
  system?: AppSystemSpec;
  tools?: AppToolsSpec;
  provider?: ProviderId;
  model?: ModelId;
  effort?: EffortLevel;
  cwd?: string;
  route?: AppRouteSpec;
  prompt: string;
  images?: ImageAttachment[];
  /** The prompt's time in ms (the daemon's clock when absent); the turn_result's turnId is it as a string. */
  startedAt?: number;
  /** Keep an ephemeral conversation after the turn (it still ends with the session). */
  keep?: boolean;
}

/** List live app conversations (debugging, `exo list --apps`). Answered with app_conversations_list. */
export interface ListAppConversationsCommand {
  type: "list_app_conversations";
  reqId?: string;
  /** Only this app's. */
  app?: string;
  /** Also list saved ones (by default only hidden ones: temporary and ephemeral). */
  includeSaved?: boolean;
}

export type Command =
  | PingCommand
  | GetTokenStatsCommand
  | ProviderProxyCommand
  | ProviderProxyLinkCommand
  | SetConversationDefaultsCommand
  | ResetConversationDefaultsCommand
  | SaveUserMacroCommand
  | DeleteUserMacroCommand
  | ListPathDirectoryCommand
  | ResolveFileLinkCommand
  | ClientCapabilitiesCommand
  | ClientExecResultCommand
  | ClientExecAliveCommand
  | PrepareShutdownCommand
  | RestartDaemonCommand
  | NewConversationCommand
  | SendMessageCommand
  | ReplayConversationCommand
  | CompactConversationCommand
  | BtwQueryCommand
  | BtwFollowupCommand
  | BtwCloseCommand
  | SetModelCommand
  | SetEffortCommand
  | SetFastModeCommand
  | SetGoalCommand
  | ChronoCommand
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
  | GetHistoryRevisionsCommand
  | LoadToolOutputsCommand
  | LoadDisplayBlocksCommand
  | GetImageCommand
  | DeleteConversationCommand
  | DeleteConversationsCommand
  | MarkConversationCommand
  | PinConversationCommand
  | MuteConversationCommand
  | MoveConversationCommand
  | RenameConversationCommand
  | GenerateTitleCommand
  | CloneConversationCommand
  | CreateFolderCommand
  | RenameFolderCommand
  | PinFolderCommand
  | MuteFolderCommand
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
  | LoadInstructionsCommand
  | LoadToolInstructionsCommand
  | SaveToolInstructionsCommand
  | SetGlobalInstructionsCommand
  | LlmCompleteCommand
  | GetSystemPromptCommand
  | RetiredToolSelectionCommand
  | ListTasksCommand
  | StopTaskCommand
  | TranscribeAudioCommand
  | GenerateImageCommand
  | LoginCommand
  | AccountCommand
  | AccountsCommand
  | ConsumeUsageResetCommand
  | LogoutCommand
  | AttachAppConversationCommand
  | EndAppSessionCommand
  | AppToolResultCommand
  | AppRunCommand
  | ListAppConversationsCommand;

// ── Events (daemon → client) ────────────────────────────────────────

export interface PongEvent {
  type: "pong";
  reqId?: string;
  /** Omitted by older daemons; clients must treat that as unknown, not current. */
  updateStatus?: UpdateStatus;
}

/**
 * The daemon's update status (see docs/update-status.md), sent to connections
 * that declared the update-status-push capability: in the ping bootstrap
 * before the conversation list (once known), then on every change. The
 * daemon keeps it warm, so clients need not poll. Older daemons never send it.
 */
export interface UpdateStatusEvent {
  type: "update_status";
  status: UpdateStatus;
}

/**
 * A requested directory plus bounded one-level lookahead for likely matching
 * child directories. Each listing is independently cacheable by the TUI.
 */
export interface PathDirectoryEntriesEvent {
  type: "path_directory_entries";
  reqId: string;
  listings: PathDirectoryListing[];
}

/** Metadata only; file contents are never transferred in daemon IPC. */
export interface FileLinkResolvedEvent {
  type: "file_link_resolved";
  reqId: string;
  convId: string;
  /** Absolute canonical path on the daemon host. */
  path: string;
  kind: "file" | "directory";
  size: number;
}

/** Run a model's client_bash command on the machine of the TUI that receives it. */
export interface ClientExecRequestEvent {
  type: "client_exec_request";
  execId: string;
  command: string;
  /** Working directory on the client machine; defaults to its home directory. */
  cwd?: string;
  timeoutMs: number;
}

/** Stop a client_exec_request that is still running. */
export interface ClientExecCancelEvent {
  type: "client_exec_cancel";
  execId: string;
}

/** Sent before a graceful daemon shutdown so clients can classify the disconnect. */
export interface DaemonShutdownEvent {
  type: "daemon_shutdown";
  mode: DaemonShutdownMode;
}

/** Answer to prepare_shutdown with interruptForReplay. */
export interface ShutdownPreparedEvent {
  type: "shutdown_prepared";
  reqId?: string;
  /** Conversations recorded for replay after the restart. */
  convIds: string[];
  /** Conversations still running when the settle deadline passed. */
  stillStreaming: string[];
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
  fastMode: FastMode;
  goal?: ConversationGoal | null;
  /** App conversations: how the daemon recorded it. */
  app?: AppConversationInfo;
}

export interface BtwStartedEvent {
  type: "btw_started";
  sessionId: string;
  convId: string;
  query: string;
  provider: ProviderId;
  model: ModelId;
  startedAt: number;
}

/** A follow-up turn was durably appended to an existing BTW thread. */
export interface BtwFollowupStartedEvent {
  type: "btw_followup_started";
  sessionId: string;
  turnId: string;
  convId: string;
  query: string;
  startedAt: number;
}

/** Start a streamed text/thinking block in the isolated BTW history. */
export interface BtwBlockStartEvent {
  type: "btw_block_start";
  convId: string;
  sessionId: string;
  /** Defaults to sessionId for events from one-shot-only daemons. */
  turnId?: string;
  blockType: "text" | "thinking";
}

/** Append streamed answer text to the currently displayed BTW content. */
export interface BtwTextChunkEvent {
  type: "btw_text_chunk";
  convId: string;
  sessionId: string;
  turnId?: string;
  text: string;
}

/** Append streamed reasoning-summary text to the isolated BTW history. */
export interface BtwThinkingChunkEvent {
  type: "btw_thinking_chunk";
  convId: string;
  sessionId: string;
  turnId?: string;
  text: string;
}

/** Replace BTW history with a canonical snapshot (retry/final reconciliation). */
export interface BtwContentEvent {
  type: "btw_content";
  convId: string;
  sessionId: string;
  turnId?: string;
  text: string;
  blocks?: Block[];
}

/** Append a completed tool invocation to the isolated BTW history. */
export interface BtwToolCallEvent {
  type: "btw_tool_call";
  convId: string;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  presentation?: ToolCallPresentation;
}

/** Append a completed tool result to the isolated BTW history. */
export interface BtwToolResultEvent {
  type: "btw_tool_result";
  convId: string;
  sessionId: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

export interface BtwStatusEvent {
  type: "btw_status";
  convId: string;
  sessionId: string;
  turnId?: string;
  status: string;
}

export interface BtwFinishedEvent {
  type: "btw_finished";
  convId: string;
  sessionId: string;
  turnId?: string;
  endedAt: number;
}

export interface BtwErrorEvent {
  type: "btw_error";
  convId: string;
  sessionId: string;
  turnId?: string;
  message: string;
  endedAt: number;
}

export interface BtwClosedEvent {
  type: "btw_closed";
  convId: string;
  sessionId: string;
}

/** Durable acknowledgement for replayable BTW mutations. */
export interface BtwMutationSettledEvent {
  type: "btw_mutation_settled";
  convId: string;
  sessionId: string;
  /** Present for follow-up settlements; the panel keeps its original sessionId. */
  turnId?: string;
  mutation: "start" | "followup" | "close";
}

/** Authoritative conversation-owned BTW state for loads and subscription catch-up. */
export interface BtwSnapshotEvent {
  type: "btw_snapshot";
  convId: string;
  btw: ConversationBtw | null;
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
  /** Work-stretch timer origin, independent of the current provider turn. */
  workTimerStartedAt?: number;
  /** Accumulated blocks so far — included for late-joining clients and periodic catch-up snapshots. */
  blocks?: Block[];
  /** Canonical active-turn blocks represented by history before this live tail. */
  blockOffset?: number;
  /** Accumulated output tokens so far — included for late-joining clients and periodic catch-up snapshots. */
  tokens?: number;
  generationThroughput?: GenerationThroughput;
  /** Active context-compaction start time for late-join/catch-up status rendering. */
  compactionStartedAt?: number | null;
  /** When the turn started waiting for the network to return, for late-join rendering. */
  connectionWaitStartedAt?: number | null;
  connectionWaitLabel?: string | null;
}

export type StreamingStopReason = "daemon-restart" | "handoff" | "unwind" | "suspended";

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
  presentation?: ToolCallPresentation;
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
  images?: ImageRef[];
}

export interface TokensUpdateEvent {
  type: "tokens_update";
  convId: string;
  /** Monotonic daemon event sequence for the active stream (diagnostics). */
  streamSeq?: number;
  tokens: number;
  generationThroughput?: GenerationThroughput;
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
  generationThroughput?: GenerationThroughput;
  /** The turn ran on API credits. */
  billing?: MessageBilling;
}

export interface UsageUpdateEvent {
  type: "usage_update";
  provider: ProviderId;
  usage: UsageData | null;
}

/** Answer to `accounts`, and pushed to its watchers on change. */
export interface AccountsEvent {
  type: "accounts";
  reqId?: string;
  snapshot: AccountsSnapshot;
}

export type UsageResetOutcome = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export interface UsageResetResultEvent {
  type: "usage_reset_result";
  reqId?: string;
  provider: ProviderId;
  outcome: UsageResetOutcome;
  /** Number of active rate-limit windows reset by the provider. */
  windowsReset: number;
  /** Remaining reset count after the provider state was refreshed, when known. */
  remainingResets?: number;
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
  /**
   * Present only in answers to a sidebarDigest: `conversations` holds just
   * the rows of these buckets, every other bucket matched the client's copy,
   * and `folders` is omitted when they matched too. Clients rebuild the full
   * list before handling it.
   */
  sidebarBuckets?: number[];
  /**
   * sidebar-incremental first page: every folder, the conversations on the
   * first rows of the client's sidebarView, every conversation that shows
   * activity (streaming, unread, tasks, subagents, background work, queued
   * messages) and the ones the view named. `folderConversationCounts` are
   * the full list's per-folder counts (subfolders included). The rest
   * follows later in the same bootstrap as a list with `sidebarRest`; nothing
   * that changes the sidebar comes between them.
   */
  sidebarPartial?: { remaining: number; folderConversationCounts: Record<string, number> };
  /** The conversations the first page left out; folders omitted. Clients rebuild the full list. */
  sidebarRest?: true;
}

export interface AIMessagePayload {
  blocks: Block[];
  metadata: MessageMetadata | null;
  /** Canonical active-turn blocks represented by entries before this live tail. */
  blockOffset?: number;
}

export type DisplayEntry =
  | { type: "system_instructions"; text: string }
  | { type: "user"; text: string; images?: ImageAttachment[]; metadata?: MessageMetadata | null; unwindFingerprint?: string; contextCheckpoint?: UserMessageContextCheckpoint }
  | { type: "ai"; blocks: Block[]; metadata: MessageMetadata | null }
  | { type: "system"; text: string; color?: string; metadata?: MessageMetadata | null };

export interface ToolOutputInfo {
  toolCallId: string;
  output: string;
}

/** Present only in responses to cachedEntryHashes. Nonnegative indices select
 * entries; negative indices select request cache entries via -index - 1.
 * Clients must reconstruct entries before passing the event to UI handlers. */
export interface CachedHistoryResponse {
  entryOrder?: number[];
}

export interface ConversationLoadedEvent extends CachedHistoryResponse {
  type: "conversation_loaded";
  reqId?: string;
  convId: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: FastMode;
  /** The requested newest history window in display order, plus pinned system instructions. */
  entries: DisplayEntry[];
  /** Absolute index of the first included non-instructions history entry. */
  historyStartIndex?: number;
  /** First included block when the entry at historyStartIndex is a partial AI entry. */
  historyStartBlockIndex?: number;
  /** Absolute index of the first loaded user message. */
  historyStartUserIndex?: number;
  /** Total number of non-instructions history entries in the snapshot. */
  historyTotalEntries?: number;
  /** Whether older history can be requested before historyStartIndex. */
  hasOlderHistory?: boolean;
  /** The request's initialBackfill.reqId when that page follows this event. */
  initialBackfillReqId?: string;
  /** The conversation's history revision this page was built at (HistoryRevisionsEvent). */
  historyRev?: string;
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
  /** Durable one-shot answer retained by this conversation until closed. */
  btw?: ConversationBtw | null;
}

export interface ConversationHistoryLoadedEvent extends CachedHistoryResponse {
  type: "conversation_history_loaded";
  reqId?: string;
  convId: string;
  /** Echo of the UI action that caused this page request. */
  requestSource?: "initial-backfill" | "viewport";
  /** Older entries immediately preceding the client's current history window. */
  entries: DisplayEntry[];
  /** Absolute index of the first returned entry. */
  historyStartIndex: number;
  /** First returned block when the entry at historyStartIndex is a partial AI entry. */
  historyStartBlockIndex?: number;
  /** Absolute index of the first returned user message. */
  historyStartUserIndex: number;
  /** Absolute exclusive end cursor for this page. */
  historyEndIndex: number;
  /** Echo of beforeBlockIndex: the last returned entry holds blocks before it of entry historyEndIndex. */
  historyEndBlockIndex?: number;
  /** Total entries in the snapshot used to build this page. */
  historyTotalEntries: number;
  /** Whether more history exists before historyStartIndex. */
  hasOlderHistory: boolean;
  /** The conversation's history revision this page was built at (HistoryRevisionsEvent). */
  historyRev?: string;
}

/**
 * Opaque history revisions by conversation id. A revision changes whenever
 * anything a history page shows may have changed: messages appended, edited,
 * unwound, trimmed or compacted, a turn starting or ending, its instructions
 * or folder. Equal revisions mean equal pages for the same request; a
 * restarted daemon starts new revisions. Pinned folder instructions (not
 * drawn by the TUI) and the live pendingAI of a running turn are not
 * covered. Pushed without reqId to `history-revisions` clients (coalesced, a
 * few times a second at most) and sent with reqId to answer
 * get_history_revisions.
 */
export interface HistoryRevisionsEvent {
  type: "history_revisions";
  reqId?: string;
  revs: Record<string, string>;
}

export interface GoalUpdatedEvent {
  type: "goal_updated";
  reqId?: string;
  convId: string;
  goal: ConversationGoal | null;
  message?: string;
}

/** A Chrono schedule as shown to the user who manages it. */
export interface ChronoScheduleSummary {
  id: string;
  title: string;
  nextAt: number;
  /** A message wake starts a model turn; a command wake runs in the shell without one. */
  kind: "message" | "command";
  /** The message text or shell command. */
  payload: string;
  recurrence?: ChronoRecurrence;
  status: "scheduled" | "pending" | "running";
}

export interface ChronoResultEvent {
  type: "chrono_result";
  reqId?: string;
  convId: string;
  action: ChronoAction;
  /** The conversation's schedules after the action, soonest first. */
  schedules: ChronoScheduleSummary[];
  created?: ChronoScheduleSummary;
  cancelled?: Array<{ id: string; title: string }>;
}

export interface ConversationUpdatedEvent {
  type: "conversation_updated";
  summary: ConversationSummary;
  /** Set when this update represents a stream transitioning to stopped for a special reason. */
  streamStopReason?: StreamingStopReason;
  /**
   * Set on the streaming=false update that ends a turn chain the owner is
   * waiting on: the chain (its queued turns and goal continuations included)
   * took in a message they wrote themselves, nothing queued follows, and it
   * ended rather than being interrupted. Chains of only automated prompts
   * (notifications, wakes, subagent reports, restart notices) never set it.
   */
  ownerTurnFinished?: true;
}

/** Targeted history truncation; clients discard only the indicated suffix. */
export interface ConversationUnwoundEvent {
  type: "conversation_unwound";
  reqId?: string;
  status: "applied" | "already_applied";
  operationId: string;
  convId: string;
  /** Absolute 0-based user-message index removed by the unwind. */
  userMessageIndex: number;
  /** Total non-instructions display entries retained after the unwind. */
  historyTotalEntries: number;
  contextTokens: number | null;
  /** In-memory sidebar row patch; no conversations-list/index rewrite is needed. */
  summary: ConversationSummary;
}

export interface ConversationDeletedEvent {
  type: "conversation_deleted";
  /** Set on the answer to the delete request of an app conversation. */
  reqId?: string;
  convId: string;
  /**
   * App conversations: why it ended. `owner_disconnected`: an ephemeral
   * conversation's session did not come back within its reconnect grace, or
   * ended (end_app_session, a daemon stop).
   */
  reason?: "deleted" | "expired" | "owner_disconnected" | "run_finished";
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

/** One authoritative order mutation produced by a single sidebar move. */
export interface SidebarItemOrderUpdate {
  item: SidebarItemRef;
  sortOrder: number;
}

/** Compact replacement for a full conversation_moved snapshot on capable clients. */
export interface SidebarItemsReorderedEvent {
  type: "sidebar_items_reordered";
  updates: SidebarItemOrderUpdate[];
}

/**
 * Compact authoritative sidebar mutation. Entries are upserts; omitted entries
 * retain their current value. Removals are explicit so folder creation, moves,
 * pinning, and deletion do not require resending every conversation summary.
 */
export interface SidebarStatePatchedEvent {
  type: "sidebar_state_patched";
  conversations?: ConversationSummary[];
  folders?: FolderSummary[];
  removedConversationIds?: string[];
  removedFolderIds?: string[];
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
  /** Present when the user-shaped turn was authored by Exocortex automation. */
  automation?: UserMessageAutomation;
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

/**
 * The turn cannot reach its provider because the network is down. It keeps its
 * input and resumes by itself once the daemon's connectivity probe succeeds;
 * Stop (abort) cancels it like any turn.
 */
export interface ConnectionWaitStatusEvent {
  type: "connection_wait_status";
  convId: string;
  /** Monotonic daemon event sequence for the active stream. */
  streamSeq?: number;
  active: boolean;
  /** Usage waits share the same paused/yellow presentation. */
  label?: string;
  /** When the turn started waiting (stable across brief reconnect attempts). */
  startedAt?: number;
  /** What it waits for (active only). */
  reason?: "network" | "proxy_link" | "usage_limit";
  /** Usage waits: when the soonest limit resets (ms), when known. */
  resetAt?: number | null;
}

/** The daemon's shared connectivity monitor (one per daemon, not per conversation). */
export interface ConnectivityStatusEvent {
  type: "connectivity_status";
  online: boolean;
  /** When the daemon last found the network unreachable; null while online. */
  offlineSince: number | null;
  /** When the next probe runs while offline. */
  nextProbeAt: number | null;
}

export interface SystemMessageEvent {
  type: "system_message";
  convId: string;
  /** Monotonic daemon event sequence when emitted inside an active stream (diagnostics). */
  streamSeq?: number;
  text: string;
  color?: string;
  /** A provider notice about where the turn runs, for programs (the text says the same). */
  route?: ConversationRouteNotice;
}

/**
 * Where a conversation's Claude turns run, when it changes:
 * `account`: it moved to another subscription account; `api_credits`: it now
 * runs on API credits (`creditKey` names the key); `subscription`: it is back
 * on a subscription account.
 */
export interface ConversationRouteNotice {
  kind: "account" | "api_credits" | "subscription";
  account?: string;
  movedFrom?: string;
  creditKey?: string;
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

/** Paths and installed tools belong to the daemon host, not the TUI host. */
export interface MacroEnvironment {
  repoRoot: string;
  storageDir: string;
  externalToolsDir: string;
  externalToolsTrashDir: string;
  pathStyle: "posix" | "win32";
  installedToolDirs: string[];
}

export interface ToolsAvailableEvent {
  type: "tools_available";
  providers: ProviderInfo[];
  tools: ToolDisplayInfo[];
  authByProvider: Record<ProviderId, boolean>;
  authInfoByProvider: Record<ProviderId, ProviderAuthInfo>;
  externalToolStyles?: ExternalToolStyle[];
  /** Absent on older daemons; remote clients must not fall back to local paths. */
  macroEnvironment?: MacroEnvironment;
  /** Small connection/bootstrap snapshot; absent on older daemons. */
  conversationDefaults?: ConversationDefaultsSnapshot;
  /** The daemon's `experimental` config flags; absent means all off. */
  experimental?: ExperimentalFeatures;
  /** Providers this daemon sends through /proxy; absent on older daemons. */
  providerProxies?: ProviderProxyInfo[];
}

export interface ExperimentalFeatures {
  /**
   * @deprecated Inline images are always on; daemons still send `true` for
   * TUIs that predate that. Current TUIs ignore it.
   */
  images?: boolean;
}

export interface ConversationDefaultsSnapshot {
  defaults: ConversationDefaults;
  /** Whether these are user-saved overrides rather than product defaults. */
  configured: boolean;
}

export interface ConversationDefaultsEvent extends ConversationDefaultsSnapshot {
  type: "conversation_defaults";
  reqId?: string;
  /** Mutation confirmation, sent only to the requesting client. */
  message?: string;
}

/**
 * The daemon's whole user macro list. Sent after `ping` and broadcast on every
 * change; the requesting client also gets a confirmation carrying `change`.
 */
export interface UserMacrosEvent {
  type: "user_macros";
  macros: UserMacro[];
  reqId?: string;
  change?: { action: "created" | "updated" | "deleted"; macro: UserMacro };
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
  /** First included block when the entry at historyStartIndex is a partial AI entry. */
  historyStartBlockIndex?: number;
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
  /** Authoritative live tail when this canonical update occurs during a stream. */
  pendingAI?: AIMessagePayload | null;
}

export interface ImageDataEvent {
  type: "image_data";
  reqId: string;
  imageId: string;
  format: "png" | "rgba";
  width: number;
  height: number;
  base64: string;
}

/**
 * Blocks for a load_display_blocks request, in its order. Blocks that no
 * longer exist (the history changed) are left out. `truncated`: the response
 * reached its size limit, so later ranges (or the end of the last one) are
 * missing and should be asked for again.
 */
export interface DisplayBlocksLoadedEvent {
  type: "display_blocks_loaded";
  reqId?: string;
  convId: string;
  ranges: Array<{ entry: number; start: number; blocks: Block[] }>;
  truncated?: boolean;
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

export interface InstructionsLoadedEvent {
  type: "instructions_loaded";
  reqId?: string;
  convId: string | null;
  folderId: string | null;
  /** The conversation's own instructions; null without a conversation. */
  conversation: string | null;
  /** The folder's own instructions (not its parents'); null without a folder. */
  folder: string | null;
  /** This install's own app-wide instructions (config/system.md); what set_global_instructions writes. */
  global: string;
  /**
   * The tracked upstream base every conversation gets before `global`
   * (config/system.base.md); read-only over IPC. Absent from older daemons.
   */
  globalBase?: string;
}

/** One tool's text as the model receives it. */
export interface ToolInstructionsEntry {
  name: string;
  /** The file the text comes from: a daemon source file or the tool's manifest.json. */
  source: string;
  /** The description sent in the tool's schema (internal tools only). */
  description?: string;
  /** The text the system prompt (or, under Claude Code, the MCP server instructions) carries for it. */
  hint?: string;
  /** Where `hint` comes from when it is not `source`. */
  hintSource?: string;
  /**
   * The tool's text as separately stored pieces, in the order the view shows
   * them; save_tool_instructions writes them by id. Absent from older daemons.
   */
  blocks?: ToolInstructionsBlock[];
}

/** One stored piece of a tool's text: a text file or a manifest's systemHint. */
export interface ToolInstructionsBlock {
  /** Names it for save_tool_instructions, e.g. "internal:exo:hint" or "external:cal". */
  id: string;
  /** What it is: "Description" or "Hint". */
  label: string;
  /** The text as the model gets it; "" when there is none yet. */
  text: string;
  /** The file it is stored in. */
  source: string;
  /** False when it cannot be saved from /instructions tools. */
  editable: boolean;
}

export interface ToolInstructionsLoadedEvent {
  type: "tool_instructions_loaded";
  reqId?: string;
  convId: string | null;
  provider: ProviderId;
  model: ModelId | null;
  /** How the text reaches the model on this provider, in a sentence. */
  route: string;
  internal: ToolInstructionsEntry[];
  external: ToolInstructionsEntry[];
}

/** One repository save_tool_instructions wrote to. */
export interface ToolInstructionsCommit {
  /** The repository's top-level directory. */
  repo: string;
  /** Short hash of the commit made; null when none was made. */
  commit: string | null;
  pushed: boolean;
  /** Why committing, pulling or pushing failed; the files are written either way. */
  error?: string;
}

export interface ToolInstructionsSavedEvent {
  type: "tool_instructions_saved";
  reqId?: string;
  /** Each saved block's text as the model now gets it. */
  saved: Array<{ id: string; text: string }>;
  commits: ToolInstructionsCommit[];
}

export interface GlobalInstructionsUpdatedEvent {
  type: "global_instructions_updated";
  reqId?: string;
  /** The new text. Empty string means cleared. */
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

export interface ImageGenerationResultEvent {
  type: "image_generation_result";
  reqId?: string;
  /** Base64-encoded image bytes as returned by the provider. */
  imageBase64: string;
  revisedPrompt: string | null;
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

// ── App API events (docs/app-api.md) ────────────────────────────────

/** Answer to client_capabilities with `app`. */
export interface AppWelcomeEvent {
  type: "app_welcome";
  reqId?: string;
  /** APP_API_VERSION of this daemon; refuse one you do not support. */
  appApiVersion: number;
  app: string;
  /** The daemon instance (`main`, or a worktree's name). */
  instance: string;
  pid: number;
  /** The session token: send it as client_capabilities.app.session when reconnecting. */
  session?: string;
  /** How long the session's ephemeral conversations wait for it after its connection drops. */
  reconnectGraceMs?: number;
  /** The session was known: the conversations it owns are this connection's again (`conversations`). */
  resumed?: boolean;
  /** Conversations the session owns. */
  conversations?: string[];
}

export interface AppSessionEndedEvent {
  type: "app_session_ended";
  reqId?: string;
  /** The ephemeral conversations that ended with it. */
  ended: string[];
}

/** The model called one of the app's tools: answer with app_tool_result. Sent to the conversation's owner. */
export interface AppToolCallEvent {
  type: "app_tool_call";
  convId: string;
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/** Stop working on an app tool call: its answer is no longer wanted. */
export interface AppToolCancelEvent {
  type: "app_tool_cancel";
  convId: string;
  callId: string;
  reason: "aborted" | "timeout" | "ended";
}

/** Answer to send_message with awaitResult, and to app_run: the turn ended. */
export interface TurnResultEvent {
  type: "turn_result";
  /** Only on the connection whose send_message/app_run awaited this turn. */
  reqId?: string;
  convId: string;
  /**
   * The turn's identity: the startedAt (ms, as a decimal string) of the prompt
   * that started it. Unchanged when a turn interrupted by a daemon restart is
   * replayed. Send a unique startedAt to match it after a reconnect.
   */
  turnId: string;
  /** The final assistant message's text. */
  text: string;
  stopReason: TurnStopReason;
  error?: string;
  usage?: {
    /** Output tokens over the whole turn (every model round). */
    outputTokens: number;
    durationMs: number;
  };
  /** The turn ran on Claude API credits (some of it, at least). */
  billing?: MessageBilling;
  /**
   * The turn ended because nothing it may use could run it (`route.whenLimited: "error"`):
   * every Claude subscription account at a usage limit, and API credits not allowed or spent.
   * `resetAt`: when the soonest one resets (ms), when known.
   */
  limited?: { resetAt: number | null };
}

export interface AppConversationAttachedEvent {
  type: "app_conversation_attached";
  reqId?: string;
  convId: string;
  conversation: AppConversationInfo;
  /** The conversation's most recent turn_result (without reqId), so a turn that ended while no owner was connected still resolves. */
  lastTurnResult?: TurnResultEvent;
}

export interface AppConversationsListEvent {
  type: "app_conversations_list";
  reqId?: string;
  conversations: AppConversationInfo[];
}

export interface ErrorEvent {
  type: "error";
  reqId?: string;
  convId?: string;
  message: string;
}

export type Event =
  | PongEvent
  | UpdateStatusEvent
  | ProviderProxiesEvent
  | ProviderProxyLinkEvent
  | ConversationDefaultsEvent
  | UserMacrosEvent
  | PathDirectoryEntriesEvent
  | FileLinkResolvedEvent
  | ClientExecRequestEvent
  | ClientExecCancelEvent
  | DaemonShutdownEvent
  | ShutdownPreparedEvent
  | AckEvent
  | ConversationCreatedEvent
  | BtwStartedEvent
  | BtwFollowupStartedEvent
  | BtwBlockStartEvent
  | BtwTextChunkEvent
  | BtwThinkingChunkEvent
  | BtwContentEvent
  | BtwToolCallEvent
  | BtwToolResultEvent
  | BtwStatusEvent
  | BtwFinishedEvent
  | BtwErrorEvent
  | BtwClosedEvent
  | BtwMutationSettledEvent
  | BtwSnapshotEvent
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
  | AccountsEvent
  | UsageResetResultEvent
  | TokenStatsEvent
  | ConversationsListEvent
  | ConversationLoadedEvent
  | ConversationHistoryLoadedEvent
  | HistoryRevisionsEvent
  | GoalUpdatedEvent
  | ChronoResultEvent
  | ConversationUpdatedEvent
  | ConversationUnwoundEvent
  | ConversationDeletedEvent
  | ConversationRestoredEvent
  | ConversationMarkedEvent
  | ConversationPinnedEvent
  | ConversationMovedEvent
  | SidebarItemsReorderedEvent
  | SidebarStatePatchedEvent
  | QueueUpdatedEvent
  | QueueNoticeEvent
  | UserMessageEvent
  | StreamRetryEvent
  | ContextCompactionStatusEvent
  | ConnectionWaitStatusEvent
  | ConnectivityStatusEvent
  | SystemMessageEvent
  | ToolsAvailableEvent
  | HistoryUpdatedEvent
  | ToolOutputsLoadedEvent
  | DisplayBlocksLoadedEvent
  | ImageDataEvent
  | SystemInstructionsUpdatedEvent
  | FolderInstructionsLoadedEvent
  | FolderInstructionsUpdatedEvent
  | InstructionsLoadedEvent
  | ToolInstructionsLoadedEvent
  | ToolInstructionsSavedEvent
  | GlobalInstructionsUpdatedEvent
  | LlmCompleteResultEvent
  | SystemPromptEvent
  | TasksListEvent
  | TaskStoppedEvent
  | TranscriptionResultEvent
  | ImageGenerationResultEvent
  | ExternalToolDaemonResultEvent
  | ExternalNotificationSourceEvent
  | ExternalNotificationSourcesEvent
  | ExternalNotificationSubscriptionEvent
  | ExternalNotificationSubscriptionsEvent
  | ExternalNotificationPublishResultEvent
  | AuthStatusEvent
  | AppWelcomeEvent
  | AppSessionEndedEvent
  | AppToolCallEvent
  | AppToolCancelEvent
  | TurnResultEvent
  | AppConversationAttachedEvent
  | AppConversationsListEvent
  | ErrorEvent;
