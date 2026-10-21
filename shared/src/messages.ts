/**
 * @exocortex/shared — Message and block domain model.
 *
 * The single source of truth for the core data structures shared
 * between the daemon and all clients. Blocks are the atoms of an
 * AI message. Messages are the units of a conversation.
 *
 * Package-specific extensions (ApiMessage, Conversation, helpers)
 * live in each package's own messages.ts and re-export from here.
 */

// ── Providers / Models ──────────────────────────────────────────────

export type ProviderId = "openai" | "anthropic" | "deepseek" | "opencode" | "openrouter";

/** Provider-scoped model identifier. */
export type ModelId = string;

/** Retains existing on/off settings; ultrafast is a distinct, opt-in service tier. */
export type FastMode = boolean | "ultrafast";

export function isFastMode(value: unknown): value is FastMode {
  return typeof value === "boolean" || value === "ultrafast";
}

export function fastModeServiceTier(mode: FastMode | undefined): "fast" | "ultrafast" | undefined {
  return mode === "ultrafast" ? "ultrafast" : mode ? "fast" : undefined;
}

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** Reserved top-level folder used for autonomous subagent conversations. */
export const SUBAGENTS_FOLDER_NAME = "subagents";

export interface ReasoningEffortInfo {
  effort: EffortLevel;
  description: string;
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  maxContext: number;
  supportedEfforts: ReasoningEffortInfo[];
  defaultEffort: EffortLevel;
  /** Whether the model accepts image inputs. Omitted means "assume yes" for backwards compatibility. */
  supportsImages?: boolean;
  /** False means chat-only: do not offer executable tools. Omitted preserves legacy support. */
  supportsTools?: boolean;
  /** Whether the model supports its provider's fast service tier. Omitted means inherit the provider capability. */
  supportsFastMode?: boolean;
  /** Opt-in only: must be explicitly advertised by the account's model catalog. */
  supportsUltrafastMode?: boolean;
  /** Account-scoped Daybreak Blue support. Missing discovery never grants access. */
  supportsDaybreak?: boolean;
  /** Whether an explicit standard cyber treatment is advertised. */
  supportsStandardCyber?: boolean;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  defaultModel: ModelId;
  allowsCustomModels: boolean;
  supportsFastMode: boolean;
  models: ModelInfo[];
}

/** Preferred provider when the app needs a default selection. */
export const DEFAULT_PROVIDER_ID: ProviderId = "openai";

/** Preferred provider ordering for UI fallbacks and provider registries. */
export const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = [DEFAULT_PROVIDER_ID, "anthropic", "deepseek", "opencode", "openrouter"];

/** Preferred default model per provider when the app needs a fallback selection. */
export const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "gpt-6-astra",
  anthropic: "claude-opus-5-5",
  deepseek: "deepseek-v4-pro",
  opencode: "ox-alpha",
  openrouter: "nousresearch/hermes-4-405b",
} as const satisfies Record<ProviderId, ModelId>;

// ── Effort ─────────────────────────────────────────────────────────

export const EFFORT_LEVELS: readonly EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const DEFAULT_EFFORT: EffortLevel = "high";

/** Default effort fallback when the app only knows the provider/model ids. */
export function defaultEffortForModelId(providerId: ProviderId, model: ModelId): EffortLevel {
  if (providerId === "openrouter") return model.startsWith("nousresearch/hermes-4-") ? "high" : "none";
  if (providerId === "openai" && (model === "gpt-6-astra" || model === "gpt-6.1-sol")) return "low";
  if (providerId === "openai" && (model === "gpt-6-sol" || model === "gpt-6-sol-daybreak" || model === "gpt-6-luna")) return "medium";
  if (providerId === "openai" && (/^gpt-5\.6-/.test(model) || /^gpt-5\.5(?:-|$)/.test(model))) return "medium";
  return DEFAULT_EFFORT;
}

export function supportsEffort(model: Pick<ModelInfo, "supportedEfforts"> | null | undefined, effort: EffortLevel): boolean {
  return model?.supportedEfforts.some((candidate) => candidate.effort === effort) ?? false;
}

export function normalizeEffortForModel(
  model: Pick<ModelInfo, "supportedEfforts" | "defaultEffort"> | null | undefined,
  effort: EffortLevel | null | undefined,
): EffortLevel {
  if (effort && supportsEffort(model, effort)) return effort;
  return model?.defaultEffort ?? DEFAULT_EFFORT;
}

export function supportsImageInputsForModel(
  model: Pick<ModelInfo, "supportsImages"> | null | undefined,
): boolean {
  return model?.supportsImages ?? true;
}

/** Maximum context window size in tokens, keyed by model id. */
export const MAX_CONTEXT: Record<string, number> = {
  "claude-fable-5-1": 1_000_000,
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5-5": 1_000_000,
  "claude-haiku-5-5": 1_000_000,
  "gpt-5": 400_000,
  // These OpenAI models run through the ChatGPT Codex backend. Their public
  // API and configurable maximum context windows differ and should be modeled
  // separately if Exocortex adds those modes.
  "gpt-6-astra": 272_000,
  // Conservative Codex defaults; live model metadata takes precedence.
  "gpt-6-sol": 272_000,
  "gpt-6-sol-daybreak": 272_000,
  "gpt-6-luna": 272_000,
  "gpt-5.6-sol": 372_000,
  "gpt-5.6-terra": 372_000,
  "gpt-5.6-luna": 372_000,
  "gpt-5.5": 272_000,
  "gpt-5.4": 272_000,
  "gpt-5.4-mini": 272_000,
  "gpt-5.3-codex-spark": 128_000,
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
  "ox-alpha": 1_000_000,
};

// ── Image attachments ──────────────────────────────────────────────

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ImageAttachment {
  mediaType: ImageMediaType;
  base64: string;       // base64-encoded image data
  sizeBytes: number;    // original byte size for display
  /**
   * Content hash of the decoded bytes, set by the daemon's history projection
   * so clients can fetch a display preview after the payload is compacted.
   */
  imageId?: string;
  width?: number;
  height?: number;
}

/**
 * A daemon-stored image shown to the user (for example one the model attached
 * to its message). The bytes live in daemon-managed storage; clients fetch a
 * bounded preview by `id` with the get_image command.
 */
export interface ImageRef {
  /** sha256 (hex) of the stored image bytes. */
  id: string;
  mediaType: ImageMediaType;
  width: number;
  height: number;
  sizeBytes: number;
  /** Original file name, for captions. */
  name?: string;
}

// ── Blocks ──────────────────────────────────────────────────────────

export interface ThinkingBlock {
  type: "thinking";
  text: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

/** Invocation-local display metadata resolved by the daemon for a tool call. */
export interface ToolCallPresentation {
  /** Bash command styles discovered beside explicitly invoked local executables. */
  bashStyles?: ExternalToolStyle[];
  /** Invocation-local style for a conversation-scoped internal tool. */
  toolStyle?: ToolDisplayInfo;
  /**
   * Detail that depends on state gone after the call, such as the name of the
   * Claude Code agent a message went to. Shown instead of the input's summary.
   */
  detail?: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  /** Snapshotted at invocation time so history never depends on the live filesystem. */
  presentation?: ToolCallPresentation;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  /** Images this call attached to the assistant message (the attach tool). Shown after its text. */
  images?: ImageRef[];
}

export type Block = ThinkingBlock | TextBlock | ToolCallBlock | ToolResultBlock;

// ── Message metadata ────────────────────────────────────────────────

/** Machine-readable identity and fallback text for persisted compaction dividers. */
export const CONTEXT_COMPACTION_FINISHED_KIND = "context_compaction_finished";
export const CONTEXT_COMPACTION_FINISHED_TEXT = "--- Compaction finished ---";
/**
 * Call start/end markers persisted by the retired realtime-call feature. Old
 * transcripts still contain them; they stay muted and out of message counts so
 * those transcripts render and count exactly as they were stored.
 */
export const LEGACY_CALL_STATUS_KIND = "realtime_call_status";
/** Informational provider notices in the transcript (a Claude account switch, Claude Code compacting its context). */
export const PROVIDER_NOTICE_KIND = "provider_notice";
/**
 * Notices that keep the model up to date on conversation state (the machines
 * client_bash and remote_bash reach, the conversation goal). They are for the
 * model alone: clients do not show them.
 */
export const CLIENT_HOST_NOTICE_KIND = "client_host";
export const REMOTE_HOST_NOTICE_KIND = "remote_host";
export const GOAL_NOTICE_KIND = "conversation_goal";
export const MODEL_ONLY_NOTICE_KINDS: readonly string[] = [CLIENT_HOST_NOTICE_KIND, REMOTE_HOST_NOTICE_KIND, GOAL_NOTICE_KIND];

/**
 * Machine-readable provenance for daemon/model-authored prompts that travel
 * through the same conversation path as user-authored messages.
 *
 * This tag is deliberately independent from MessageMetadata.system: automated
 * prompts remain ordinary model-visible turns unless their producer also marks
 * them as a system notice.
 */
export const USER_MESSAGE_AUTOMATION_KINDS = [
  "external_notification",
  "background_task_completion",
  "chrono_wake",
  "chrono_hard_wake",
  "exo_send",
  "subagent_completion",
  "goal_continuation",
  "daemon_restart",
] as const;

export type UserMessageAutomationKind = typeof USER_MESSAGE_AUTOMATION_KINDS[number];

export interface UserMessageAutomation {
  kind: UserMessageAutomationKind;
  /** Stable producer-specific identity when one is useful for diagnostics. */
  sourceId?: string;
}

/**
 * Automated queue entries that report something that already happened (a
 * finished subagent or task, a fired wake, a notification, a message from
 * another conversation). Nothing will produce them again, so editing history
 * must not discard them the way it discards the user's own queued follow-ups.
 */
export function isQueuedObligation(automation: UserMessageAutomation | undefined): boolean {
  return automation !== undefined
    && automation.kind !== "goal_continuation"
    && automation.kind !== "daemon_restart";
}

export function isUserMessageAutomation(value: unknown): value is UserMessageAutomation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<UserMessageAutomation>;
  return typeof candidate.kind === "string"
    && (USER_MESSAGE_AUTOMATION_KINDS as readonly string[]).includes(candidate.kind)
    && (candidate.sourceId === undefined || typeof candidate.sourceId === "string");
}

/**
 * Prompts delivered before the daemon tagged automated messages (Oct 2026)
 * carry only their text. These prefixes are what their producers wrote then; a
 * person is unlikely to type one, and newer prompts never need it because their
 * metadata says what they are.
 */
const LEGACY_AUTOMATED_PROMPT = /^\[(?:notification\]|chrono (?:hard )?wake[:\]]|external notification\b|[A-Za-z/ ]*Notification\])/;

/**
 * Whether a user-role message is a notification rather than something the
 * user typed: a subagent completion, a wake, a message from another
 * conversation... Clients fold these apart from the user's own messages.
 */
export function isAutomatedUserPrompt(text: string, metadata: Pick<MessageMetadata, "automation"> | null | undefined): boolean {
  return metadata?.automation !== undefined || LEGACY_AUTOMATED_PROMPT.test(text);
}

/**
 * The owner's own words when a notification relays a message they sent (their
 * Discord DM or mention, a WhatsApp /ai command). Publishers mark the
 * triggering line `→ Name <id> [trust] …:` (external-tools/TOOL_STANDARD.md)
 * and follow it with the message and a final `[msg:…]` line; only the first
 * `→` line is the trigger, since message content may contain one. There is no
 * structured owner flag in message metadata, so this reads that standard
 * line. Returns null for anything else, including an owner message with no
 * text (an attachment or a call).
 */
export function ownerRelayedText(text: string, metadata: Pick<MessageMetadata, "automation"> | null | undefined): string | null {
  const automation = metadata?.automation;
  if (automation ? automation.kind !== "external_notification" : !LEGACY_AUTOMATED_PROMPT.test(text)) return null;
  const trigger = /^→ [^\n]*$/m.exec(text);
  if (!trigger) return null;
  // Bracketed tags (`[owner]`, `↳ [reply-to:…]`) are skipped whole, so the
  // colon that ends the line's header is the first one outside them.
  const head = /^→ (?:[^[\n:]|\[[^\]\n]*\])*?\[owner\](?:[^[\n:]|\[[^\]\n]*\])*:(?:[ \t]+(.*))?$/.exec(trigger[0]);
  if (!head) return null;
  const lines = [head[1] ?? ""];
  const rest = text.slice(trigger.index + trigger[0].length + 1).split("\n");
  for (let index = 0; index < rest.length; index++) {
    const line = rest[index]!;
    if (/^\[msg:[^\]]*\]$/.test(line.trim())) break;
    // Without a closing message id, the agent-facing tail still ends the owner's words.
    if (line.trim() === "" && /^(?:Action|Filter output):/.test(rest[index + 1] ?? "")) break;
    lines.push(line);
  }
  return readableRelayBody(lines.join("\n"));
}

const AUDIO_ATTACHMENT = /(?:^voice-message|\.(?:ogg|oga|opus|m4a|mp3|wav|aac))$/i;

/**
 * The owner's relayed words as they read in a bubble: attachment lines
 * (`[attachment:ID] IMG_1181.png`, `[📎 voice-message.ogg]`) become
 * `📎 IMG_1181.png` / `🎤 voice message`, and the `[message]` placeholder
 * Discord relays for a message with no text goes when attachments say what
 * it was (alone, it reads `📎 attachment`).
 */
function readableRelayBody(raw: string): string | null {
  let attachments = 0;
  const attachment = (name: string) => {
    attachments++;
    const file = name.trim();
    return AUDIO_ATTACHMENT.test(file) ? "🎤 voice message" : `📎 ${file || "attachment"}`;
  };
  const lines = raw.split("\n").map(line => line
    .replace(/^\s*\[attachment:[^\]]*\]\s*(.*)$/, (_, name: string) => attachment(name))
    .replace(/\[📎 ([^\]]*)\]/g, (_, name: string) => attachment(name)));
  const kept = lines.filter(line => !(line.trim() === "[message]" && attachments > 0));
  const body = kept.join("\n").trim();
  if (body === "[message]") return "📎 attachment";
  return body ? body : null;
}

/** Persistent request throughput samples belonging to one assistant message. */
export interface GenerationThroughput {
  provider: ProviderId;
  model: ModelId;
  /** Output tokens / request seconds (TTFT + generation) for this message's last ten API rounds. */
  rates: number[];
}

/** Metadata attached to a message, persisted by the daemon and rendered by clients. */
export interface MessageMetadata {
  /** When the client sent this message. Client-originated. */
  startedAt: number;
  /** When the daemon finished. Null while streaming. */
  endedAt: number | null;
  /**
   * Virtual start of the work-stretch timer (idle gaps already subtracted).
   * Separate from startedAt, which remains the identity of this provider turn.
   */
  workTimerStartedAt?: number;
  /** Model used. Client-originated (set on creation). */
  model: ModelId;
  /** Accumulated output tokens. Starts at 0, daemon sends periodic updates. */
  tokens: number;
  /** Independent of message/work elapsed time; never derived from accumulated tokens. */
  generationThroughput?: GenerationThroughput;
  /**
   * True for daemon-authored messages that should be visible to the model but
   * treated like system/UI notices instead of real user messages in clients.
   */
  system?: boolean;
  /** Machine-readable subtype for daemon-authored metadata/system notices. */
  kind?: string;
  /** Durable id used to deduplicate an accepted subagent completion notification. */
  subagentNotificationId?: string;
  /** Durable id used to deduplicate a user message accepted from the persistent queue. */
  queueEntryId?: string;
  /** Provenance for a non-human prompt intentionally represented as a user turn. */
  automation?: UserMessageAutomation;
  /**
   * A queued prompt delivered while work was underway: injected at a tool
   * boundary, or started as the next turn when the running one ended. It
   * continues the work timer instead of restarting it.
   */
  arrivedWhileWorking?: true;
}

/** Build standard message metadata with sensible defaults. */
export function createMessageMetadata(
  startedAt: number,
  model: ModelId,
  options?: { endedAt?: number | null; tokens?: number },
): MessageMetadata {
  return {
    startedAt,
    endedAt: options?.endedAt ?? null,
    model,
    tokens: options?.tokens ?? 0,
  };
}

/**
 * Combine metadata from adjacent assistant fragments that render as one AI
 * message. This preserves the visible span across goal-continuation turns:
 * the rendered entry starts when the first fragment started, ends when the
 * last finished. Token counts are summed across distinct continuation turns;
 * fragments from the same turn keep the cumulative token count instead.
 */
export function combineMessageMetadata(
  current: MessageMetadata | null | undefined,
  next: MessageMetadata | null | undefined,
): MessageMetadata | null {
  if (!current && !next) return null;
  if (!current) return next ? { ...next } : null;
  if (!next) return { ...current };

  const sameAssistantTurn = current.startedAt === next.startedAt;

  return {
    ...next,
    startedAt: Math.min(current.startedAt, next.startedAt),
    endedAt: current.endedAt == null || next.endedAt == null
      ? null
      : Math.max(current.endedAt, next.endedAt),
    model: next.model,
    // Fragments with the same startedAt are pieces of one assistant turn (for
    // example tool-round salvage on abort), so their token counts are already
    // cumulative. Distinct starts are separate continuation turns and should add.
    tokens: sameAssistantTurn ? Math.max(current.tokens, next.tokens) : current.tokens + next.tokens,
  };
}

// ── Messages ────────────────────────────────────────────────────────

export interface UserMessage {
  role: "user";
  text: string;
  images?: ImageAttachment[];
  metadata: MessageMetadata | null;
  /** Daemon-authored identity of this exact transcript boundary for safe unwinds. */
  unwindFingerprint?: string;
  /** Daemon-owned rewind point for Ctrl-W history editing. */
  contextCheckpoint?: UserMessageContextCheckpoint;
}

/** Safe client projection of the context immediately before a user message. */
export interface UserMessageContextCheckpoint {
  /** Last provider-reported (or daemon-estimated) context at this rewind point. */
  contextTokens: number | null;
  /** False when the message is represented by the latest irreversible compaction. */
  editable: boolean;
}

export interface AIMessage {
  role: "assistant";
  blocks: Block[];
  metadata: MessageMetadata | null;
}

/**
 * System messages are daemon-generated notices (errors, status changes).
 * Shown to the user, persisted in the conversation, never sent to the AI.
 */
export interface SystemMessage {
  role: "system";
  text: string;
  color?: string;
  metadata: MessageMetadata | null;
  /** Client-only notice the daemon never stored: not a canonical history entry. */
  localOnly?: true;
}

/**
 * Per-conversation system instructions. Stored as messages[0], appended
 * to the global system prompt before each API call. Never sent as an
 * API message — only used to augment the system prompt string.
 */
export interface SystemInstructionsMessage {
  role: "system_instructions";
  text: string;
  metadata: null;
}

export type Message = UserMessage | AIMessage | SystemMessage | SystemInstructionsMessage;

// ── Conversation BTW panel ─────────────────────────────────────────

/** One question/answer turn inside a durable BTW session. */
export interface ConversationBtwTurn {
  /** Stable mutation identity used to deduplicate follow-up delivery. */
  id: string;
  query: string;
  startedAt: number;
  endedAt: number | null;
  phase: "running" | "complete" | "error";
  /** Assistant display history for this turn. */
  blocks?: Block[];
  /** Plain answer projection retained for compatibility and non-visual consumers. */
  text: string;
  status: string;
}

/** Durable BTW thread owned by a conversation until explicitly closed. */
export interface ConversationBtw {
  /** Stable identity of the retained panel/thread. */
  sessionId: string;
  /** Latest turn projection retained for compatibility with one-shot clients. */
  query: string;
  provider: ProviderId;
  model: ModelId;
  startedAt: number;
  endedAt: number | null;
  phase: "running" | "complete" | "error";
  /**
   * Assistant display history for the isolated turn. New sessions always include
   * this; it remains optional on the wire so panels persisted by older versions
   * can be upgraded from `text` when they are loaded.
   */
  blocks?: Block[];
  /** Plain answer projection retained for compatibility and non-visual consumers. */
  text: string;
  status: string;
  /** Complete BTW question/answer history. Missing on sessions created by older versions. */
  turns?: ConversationBtwTurn[];
}

// ── Conversation goals ───────────────────────────────────────────────

export type ConversationGoalStatus = "active" | "paused" | "blocked" | "complete";

export interface ConversationGoal {
  objective: string;
  status: ConversationGoalStatus;
  /** Legacy data, ignored. New goals never write these permission flags. */
  pausable?: boolean;
  completable?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Number of automatic continuation turns started since the goal was set. */
  turns: number;
  /** Who most recently paused the goal. Older saved goals omit this. */
  pausedBy?: "user" | "controller";
  /** Concise input/completion context retained across client reloads. */
  pauseReason?: string;
  /** Explanation/evidence for the most recent stopped state. */
  reason?: string;
  /** Legacy turn budget, ignored and stripped on load. */
  maxTurns?: number;
  /** Optional limit on active time, across resumes. Work stops when it runs out. */
  maxTimeMs?: number;
  /** Active time from finished active periods; paused/blocked/complete time is excluded. */
  activeMs?: number;
  /** Start of the current active period; set only while active. */
  activeSince?: number;
  /** Consecutive empty successful turns; guards against provider empty-output loops. */
  emptyTurns?: number;
}

// ── Conversation summary ────────────────────────────────────────────

/** Ephemeral work currently owned by a conversation. */
export interface ActiveTaskInfo extends ConversationTaskSummary {
  ownerConversationId: string;
  status: "running" | "stopping";
  toolName?: string;
  pid?: number;
  backgroundedAt?: number;
  outputPath?: string;
  cwd?: string;
}

export interface ConversationTaskSummary {
  /** Child conversation id for subagents, or the tool-owned task id for background work. */
  id: string;
  kind: "subagent" | "background" | "chrono";
  /** Short subagent conversation title or a compact background-command description. */
  title: string;
  /** Unix epoch milliseconds when this work started. */
  startedAt: number;
  /** Next due time for sleeping/scheduled Chrono work. */
  dueAt?: number;
  /** Chrono lifecycle shown by the focused-conversation Tasks UI. */
  chronoMode?: "wait" | "sleep" | "wake";
  /**
   * A Chrono schedule whose occurrence is executing now: `startedAt` is when
   * the run began and `dueAt` is the occurrence it is running.
   */
  chronoRunning?: true;
  /** Tool running background work, e.g. `Agent` for a Claude Code background subagent. */
  toolName?: string;
}

/** How an external notification subscription handles events for its conversation. */
export type ExternalNotificationDelivery = "wake" | "inbox" | "soft";

/** Health of an external notification subscription's source. */
export type ExternalIntegrationStatus = "active" | "offline" | "disabled";

/** Durable external notification route projected into conversation UI. */
export interface ExternalIntegrationSummary {
  /** Stable daemon-owned subscription id. */
  id: string;
  /** External tool manifest name, for example `discord` or `whatsapp`. */
  toolName: string;
  /** Tool-owned opaque source id. */
  sourceId: string;
  /** Display label: the user-set subscription name, else the tool's source label. */
  label: string;
  /** Tool-supplied source label, present only when a user-set name replaces it in `label`. */
  sourceLabel?: string;
  /** Optional longer explanation of which external events this source emits. */
  description?: string;
  delivery: ExternalNotificationDelivery;
  status: ExternalIntegrationStatus;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: FastMode;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** Conversation title. The daemon owns automatic title generation. */
  title: string;
  /** Optional persistent objective that can auto-continue while active. */
  goal?: ConversationGoal | null;
  marked: boolean;
  pinned: boolean;
  /** Whether this conversation is explicitly muted. */
  muted?: boolean;
  streaming: boolean;
  /** Active provider turn is waiting for connectivity or capacity. */
  providerWaiting?: boolean;
  /** False for maintenance jobs that must be aborted, but not replayed, across daemon restarts. */
  restartRecoverable?: boolean;
  unread: boolean;
  /**
   * Daemon-owned attention policy. Muted conversations still report live
   * streaming state, but clients should not emit completion notifications.
   * Omitted means notifications are allowed.
   */
  notificationsMuted?: boolean;
  sortOrder: number;
  /** Folder containing this conversation. Null means the sidebar root. */
  folderId?: string | null;
  /** Ephemeral number of child subagent turns currently running for this conversation. */
  subagentCount?: number;
  /** Ephemeral number of detached background tool processes currently running for this conversation. */
  backgroundTaskCount?: number;
  /** Ephemeral task details used by focused-conversation activity UI. */
  tasks?: ConversationTaskSummary[];
  /** Durable external notification subscriptions targeting this conversation. */
  integrations?: ExternalIntegrationSummary[];
}

export interface FolderSummary {
  id: string;
  name: string;
  /** Parent folder. Null means the sidebar root. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Whether this folder explicitly mutes itself and all of its descendants. */
  muted?: boolean;
  sortOrder: number;
  /** Effective parent→child AGENTS.md context for draft chats in this folder. */
  effectiveInstructions?: string;
}

export type SidebarItemRef =
  | { type: "conversation"; id: string }
  | { type: "folder"; id: string };

// ── Conversation sorting ────────────────────────────────────────────

/** Canonical sort: pinned first (by sortOrder), then unpinned (by sortOrder). */
export function sortConversations<T extends Pick<ConversationSummary, "pinned" | "sortOrder">>(list: T[]): T[] {
  return list.sort(compareConversations);
}

/** Comparator for conversation sorting. Usable standalone with Array.sort(). */
export function compareConversations(
  a: Pick<ConversationSummary, "pinned" | "sortOrder">,
  b: Pick<ConversationSummary, "pinned" | "sortOrder">,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.sortOrder - b.sortOrder;
}

// ── Sort-order placement helpers ────────────────────────────────────
// Used by both daemon (authoritative) and TUI (optimistic) to compute
// where a conversation lands when pinned/unpinned/created.

type SortOrderEntry = Pick<ConversationSummary, "id" | "pinned" | "sortOrder">;

/** sortOrder that places an item at the bottom of the pinned section. */
export function bottomPinnedOrder(items: Iterable<SortOrderEntry>, excludeId: string): number {
  let maxOrder = -Infinity;
  for (const c of items) {
    if (c.pinned && c.id !== excludeId && c.sortOrder > maxOrder) maxOrder = c.sortOrder;
  }
  return maxOrder === -Infinity ? 0 : maxOrder + 1;
}

/** sortOrder that places an item at the top of the unpinned section. */
export function topUnpinnedOrder(items: Iterable<SortOrderEntry>, excludeId?: string): number {
  let minOrder = 0;
  for (const c of items) {
    if (!c.pinned && c.id !== excludeId && c.sortOrder < minOrder) minOrder = c.sortOrder;
  }
  return minOrder - 1;
}

// ── Tool display info (daemon → TUI on connect) ────────────────────

export interface ToolDisplayInfo {
  name: string;     // "bash", "read", etc.
  label: string;    // "$", "Read", etc.
  color: string;    // hex color "#d19a66"
}

/**
 * An MCP tool Claude Code calls as `mcp__<server>__<tool>`. Its label is the
 * server, readable, the way a bash call to an external tool shows that tool's
 * name; the tool itself leads the call's detail. Null for other names.
 */
export function parseMcpToolName(name: string): { label: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!match) return null;
  const label = match[1].replace(/^claude_ai_/, "").replace(/_/g, " ").trim() || match[1];
  return { label, tool: match[2] };
}

/** Free text of an `exo` call up to this long, on one line, stays on its header line. */
export const EXO_INLINE_TEXT_MAX = 100;

/**
 * Detail of an `exo` call. Its header names the action and its target
 * (`message: <conversation>`, `subagent (opus)`); free text (a prompt, a
 * message, a restart reason) follows it after `: ` when short, and otherwise
 * on the lines after the header, in full with its line breaks kept, for
 * clients to show as the call's body.
 */
export function exoCallDetail(input: Record<string, unknown>): string {
  const action = (["subagent", "message", "status", "restart"] as const).find(key => input[key] !== undefined) ?? "abort";
  const str = (value: unknown) => typeof value === "string" ? value : "";
  let header: string = action;
  let text = str(input[action]);
  if (action === "message") {
    const message = input.message as { conversation?: unknown; text?: unknown } | undefined;
    header = `message: ${str(message?.conversation)}`;
    text = str(message?.text);
  } else if (action === "subagent") {
    const args = input.args as { model?: unknown; effort?: unknown } | undefined;
    const options = [str(args?.model), str(args?.effort)].filter(Boolean);
    if (options.length) header = `subagent (${options.join(", ")})`;
  }
  text = text.trim();
  if (!text) return header;
  return !text.includes("\n") && text.length <= EXO_INLINE_TEXT_MAX ? `${header}: ${text}` : `${header}\n${text}`;
}

/**
 * Bash command style — maps a command prefix to TUI display properties.
 * Global external-tool styles are sent alongside ToolDisplayInfo; local styles
 * may instead be snapshotted on an individual tool call.
 */
export interface ExternalToolStyle {
  cmd: string;      // command prefix to match (e.g. "gmail")
  label: string;    // TUI label (e.g. "Gmail")
  color: string;    // hex color "#4ddbb7"
}

// ── Usage data ──────────────────────────────────────────────────────

export interface UsageWindow {
  /** Utilization percentage, 0–100. */
  utilization: number;
  /** Unix timestamp (ms) when this window resets. Null if unknown. */
  resetsAt: number | null;
  /**
   * Combined over several accounts: each account's reset time, soonest
   * first (`resetsAt` is the first). Omitted for a single account.
   */
  resets?: number[];
}

export interface UsageResetCredits {
  /** Number of earned rate-limit resets currently available. */
  availableCount: number;
  /** Unix timestamp (ms) of the next available reset credit to expire. */
  nextExpiresAt: number | null;
}

export interface UsageData {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /**
   * Percent that means "full": 100 per account combined into this usage
   * (two Claude accounts: 0–200%). Omitted for a single account (100).
   */
  capacity?: number;
  /** OpenAI reset-credit metadata. Omitted for older caches and unsupported providers. */
  resetCredits?: UsageResetCredits | null;
}

// ── Token stats ─────────────────────────────────────────────────────

export const TOKEN_USAGE_SOURCES = [
  "conversation",
  // Historical accounting only; new goal turns use "conversation".
  "goal_controller",
  "btw",
  "llm_complete",
  "title_generation",
  "browse_summary",
  "context_summary",
  "context_compaction",
  // Historical accounting only; next-message suggestions were removed.
  "next_message_suggestion",
] as const;

export type TokenUsageSource = typeof TOKEN_USAGE_SOURCES[number];

export interface TokenTrackingContext {
  source: TokenUsageSource;
  conversationId?: string;
}

export interface TokenUsageTotals {
  inputTokens: number;
  /** Provider-reported cache hits/reads. */
  cachedInputTokens: number;
  /** Provider-reported cache misses/writes (OpenAI `cache_write_tokens`). */
  cacheMissInputTokens: number;
  /** Input explicitly known to be neither a cache hit nor a cache miss/write. */
  uncachedInputTokens: number;
  /** Residual input whose cache category was not fully reported. */
  unmeasuredInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  /** API-price estimate captured with the exact request rate class; excludes unpriceable input. */
  estimatedInputCostUsd: number;
  /** API-price estimate captured with the exact request rate class. */
  estimatedOutputCostUsd: number;
  /** Input tokens covered by estimatedInputCostUsd. */
  pricedInputTokens: number;
  /** Output tokens covered by estimatedOutputCostUsd. */
  pricedOutputTokens: number;
}

export interface TokenStatsBucket extends TokenUsageTotals {
  byProvider: Partial<Record<ProviderId, TokenUsageTotals>>;
  byModel: Record<ModelId, TokenUsageTotals>;
  bySource: Partial<Record<TokenUsageSource, TokenUsageTotals>>;
}

export interface TokenStatsDay extends TokenStatsBucket {
  /** Local calendar day in YYYY-MM-DD form. */
  day: string;
}

export interface TokenStatsSnapshot {
  /** Last time the backing stats store changed, or null if empty. */
  updatedAt: number | null;
  /** Today bucket in local time. Always present, zeroed when unused. */
  today: TokenStatsDay;
  /** Lifetime totals across all recorded days. */
  lifetime: TokenStatsBucket;
  /** Active days only, newest first. */
  days: TokenStatsDay[];
}

export function createTokenUsageTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMissInputTokens: 0,
    uncachedInputTokens: 0,
    unmeasuredInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
    estimatedInputCostUsd: 0,
    estimatedOutputCostUsd: 0,
    pricedInputTokens: 0,
    pricedOutputTokens: 0,
  };
}

export function createTokenStatsBucket(): TokenStatsBucket {
  return {
    ...createTokenUsageTotals(),
    byProvider: {},
    byModel: {},
    bySource: {},
  };
}

export function createTokenStatsDay(day: string): TokenStatsDay {
  return {
    day,
    ...createTokenStatsBucket(),
  };
}
