/**
 * Message and block model for exocortexd.
 *
 * Re-exports the shared domain types and adds daemon-specific
 * types: API-level content blocks, API messages (for conversation
 * storage / replay), and the Conversation type.
 */

// ── Shared domain types (single source of truth) ────────────────────

export * from "@exocortex/shared/messages";

// ── API-level types (for stored conversations / API replay) ─────────

import { CONTEXT_COMPACTION_FINISHED_KIND, DEFAULT_EFFORT, createMessageMetadata, type ProviderId, type ModelId, type EffortLevel, type MessageMetadata, type ConversationSummary, type FolderSummary, type ImageAttachment, type ConversationGoal } from "@exocortex/shared/messages";
import type { AssistantProviderData } from "./providers/provider-data";
import { createHash } from "crypto";

export interface ContextTokenBreakdown {
  userText: number;
  userImage: number;
  assistantText: number;
  toolUse: number;
  toolResultText: number;
  toolResultImage: number;
  thinking: number;
  providerReasoning: number;
  systemHint: number;
}

export interface MessageContextTokenAttribution {
  version: 1;
  provider: ProviderId;
  model: ModelId;
  /** Signature of the message content/provider replay state this attribution describes. */
  signature: string;
  /** Provider-reported total context tokens calibrated onto this message. */
  totalTokens: number;
  /** Provider-reported context tokens calibrated onto replay-relevant message categories. */
  breakdown: ContextTokenBreakdown;
  /** How this attribution was produced. */
  source: "provider_calibrated" | "estimated";
  updatedAt: number;
}

export type ApiContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean };

export interface ApiMessage {
  role: "user" | "assistant";
  content: string | ApiContentBlock[];
  /**
   * Optional persistence/display metadata. Provider request builders ignore it;
   * the daemon uses it for model-visible checkpoint/system notices.
   */
  metadata?: MessageMetadata | null;
  providerData?: AssistantProviderData;
  contextTokens?: MessageContextTokenAttribution | null;
  /** Daemon-only rewind metadata; provider request builders intentionally ignore it. */
  contextCheckpoint?: StoredUserContextCheckpoint;
}

/** A message with optional metadata for persistence. */
export interface StoredMessage {
  role: "user" | "assistant" | "system" | "system_instructions";
  content: string | ApiContentBlock[];
  metadata: MessageMetadata | null;
  providerData?: AssistantProviderData;
  contextTokens?: MessageContextTokenAttribution | null;
  /** Context/replay state immediately before this real user message was added. */
  contextCheckpoint?: StoredUserContextCheckpoint;
}

/**
 * A small durable reference to a rewindable provider context. The opaque replay
 * itself remains single-copy in Conversation.activeContext; user messages only
 * record the cursor and token status needed to restore it safely.
 */
export interface StoredUserContextCheckpoint {
  version: 1;
  provider: ProviderId;
  model: ModelId;
  /** Active compact window at this point, or null for an uncompacted transcript. */
  windowId: string | null;
  /** Number/hash of replay-history messages before the user message. */
  transcriptHistoryCount: number;
  transcriptPrefixHash: string;
  /** Context shown in the statusline after returning to this point. */
  contextTokens: number | null;
}

/**
 * A compact provider replay kept separately from the immutable, user-visible
 * transcript. History appended after transcriptHistoryCount is replayed as a
 * canonical tail. The checkpoint stays immutable until a later compaction
 * replaces it, which makes that tail safely rewindable.
 */
export interface ActiveContext {
  version: 1;
  kind: "openai_native" | "plaintext";
  /** Provider/model that created the checkpoint (plaintext remains portable). */
  provider: ProviderId;
  model: ModelId;
  /** Native OpenAI blobs are scoped to the account that created them. */
  accountScope?: string;
  messages: ApiMessage[];
  /** Number of model-history messages represented by messages. */
  transcriptHistoryCount: number;
  /** Detect transcript edits/corruption before replaying a derived checkpoint. */
  transcriptPrefixHash: string;
  /**
   * Fixed transcript boundary represented by the latest compaction item itself.
   * Legacy checkpoints advanced transcriptHistoryCount after each turn while
   * this cursor stayed fixed. New checkpoints keep both at this boundary.
   * Optional only for persisted checkpoints created before this field existed.
   */
  compactionHistoryCount?: number;
  compactionPrefixHash?: string;
  /** Logical provider window installed by the latest compaction. */
  windowId: string;
  windowNumber: number;
  compactedAt: number;
  compactionCount: number;
}

// ── Conversation state ──────────────────────────────────────────────

/** Hard safety ceilings for recursively spawned native exo subagents. */
export const MAX_EXO_SUBAGENT_DEPTH = 8;
export const MAX_ACTIVE_EXO_SUBAGENTS_PER_PARENT = 8;
export const MAX_ACTIVE_EXO_SUBAGENTS_GLOBAL = 32;

export interface Conversation {
  id: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  fastMode: boolean;
  messages: StoredMessage[];
  /** Compact model replay; never used to render or count the visible chat. */
  activeContext?: ActiveContext | null;
  createdAt: number;
  updatedAt: number;
  lastContextTokens: number | null;
  marked: boolean;
  pinned: boolean;
  sortOrder: number;
  /** Folder containing this conversation. Null means the sidebar root. */
  folderId?: string | null;
  /** Conversation title. The daemon owns automatic title generation. */
  title: string;
  /** Optional persistent objective that can auto-continue while active. */
  goal?: ConversationGoal | null;
  /**
   * Remaining native exo nesting budget for autonomous continuations of this
   * conversation. Null/omitted means a root/user-started turn.
   */
  subagentMaxDepth?: number | null;
}

/**
 * True if a message contains any tool_result blocks.
 *
 * Used to distinguish "real" user messages from the tool_result
 * containers the API requires between tool_use and the next
 * assistant turn.  Uses `some()` (not `every()`) so that
 * tool_result messages with extra content — such as context
 * pressure hints injected by the agent loop — are still
 * recognised as tool-result messages.  This matches the logic
 * in display.ts, which folds any message with tool_results
 * into the AI entry.  Without this consistency, unwindTo's
 * user-message index drifts from the TUI's index and the
 * splice can land between a tool_use and its tool_result,
 * bricking the conversation.
 */
export function isToolResultMessage(msg: StoredMessage): boolean {
  if (typeof msg.content === "string") return false;
  return msg.content.length > 0 && msg.content.some(b => b.type === "tool_result");
}

/**
 * A model-visible system notice is stored with role="user" so providers see it
 * in conversation history, but is tagged metadata.system=true so app UX treats
 * it like a daemon/system notice rather than a user-authored prompt.
 */
export function isModelVisibleSystemNotice(msg: Pick<StoredMessage, "role" | "metadata">): boolean {
  return msg.role === "user" && msg.metadata?.system === true;
}

/** Create a model-visible system notice with standard metadata. */
export function createModelVisibleSystemNotice(
  text: string,
  model: ModelId,
  kind: string,
  startedAt = Date.now(),
): StoredMessage & { role: "user"; content: string; metadata: MessageMetadata } {
  return {
    role: "user",
    content: text,
    metadata: {
      ...createMessageMetadata(startedAt, model, { endedAt: startedAt }),
      system: true,
      kind,
    },
  };
}

/** True for actual user/assistant API history turns, excluding UI-only daemon entries. */
export function isHistoryMessage(msg: StoredMessage): msg is StoredMessage & { role: "user" | "assistant" } {
  return msg.role !== "system" && msg.role !== "system_instructions";
}

/** Provider replay history, excluding obsolete model-directed compaction hints. */
export function isReplayHistoryMessage(msg: StoredMessage): msg is StoredMessage & { role: "user" | "assistant" } {
  return isHistoryMessage(msg) && msg.metadata?.kind !== "context_warning";
}

export function historyPrefixHash(messages: StoredMessage[], historyCount: number): string {
  const hash = createHash("sha256");
  let seen = 0;
  for (const message of messages) {
    if (seen >= historyCount) break;
    if (!isReplayHistoryMessage(message)) continue;
    hash.update(JSON.stringify({
      role: message.role,
      content: message.content,
      providerData: message.providerData ?? null,
    }));
    hash.update("\n");
    seen += 1;
  }
  return hash.digest("hex").slice(0, 24);
}

/**
 * Hash several replay-history prefixes in one transcript pass.
 *
 * Active contexts normally keep transcriptHistoryCount and
 * compactionHistoryCount at the same immutable boundary. Older contexts can
 * have two different cursors. Validating them independently used to stringify
 * every (potentially very large) retained tool result and image once per cursor.
 */
function historyPrefixHashes(messages: StoredMessage[], historyCounts: number[]): Map<number, string> {
  const targets = [...new Set(historyCounts)].sort((a, b) => a - b);
  const hashes = new Map<number, string>();
  if (targets.length === 0) return hashes;

  const hash = createHash("sha256");
  let seen = 0;
  let targetIndex = 0;
  const finishTargetsAtCurrentCount = () => {
    while (targets[targetIndex] === seen) {
      hashes.set(seen, hash.copy().digest("hex").slice(0, 24));
      targetIndex += 1;
    }
  };
  finishTargetsAtCurrentCount();

  for (const message of messages) {
    if (targetIndex >= targets.length) break;
    if (!isReplayHistoryMessage(message)) continue;
    hash.update(JSON.stringify({
      role: message.role,
      content: message.content,
      providerData: message.providerData ?? null,
    }));
    hash.update("\n");
    seen += 1;
    finishTargetsAtCurrentCount();
  }
  return hashes;
}

// A successfully validated active context represents an immutable transcript
// prefix. Canonical history may only append after that prefix; rewind/compaction
// installs a new ActiveContext object. Cache that expensive integrity check by
// active-context + transcript identity so opening a chat, immediately preloading
// its next TUI page, and then starting a model turn do not repeatedly hash tens
// of megabytes of retained audit history. Disk loads use new object identities,
// so persisted corruption is still checked once on every daemon load.
interface ActiveContextValidationFingerprint {
  activeMessages: Array<{
    message: ApiMessage;
    role: ApiMessage["role"];
    content: ApiMessage["content"];
    metadata: ApiMessage["metadata"];
    providerData: ApiMessage["providerData"];
  }>;
  activeMessagesArray: ApiMessage[];
  compactionHistoryCount: number | undefined;
  compactionPrefixHash: string | undefined;
  transcriptHistoryCount: number;
  transcriptPrefixHash: string;
  transcriptPrefix: Array<{
    message: StoredMessage;
    role: StoredMessage["role"];
    content: StoredMessage["content"];
    providerData: StoredMessage["providerData"];
  }>;
}

const validatedActiveContexts = new WeakMap<ActiveContext, WeakMap<StoredMessage[], ActiveContextValidationFingerprint>>();

function activeContextValidationFingerprint(
  active: ActiveContext,
  transcript: StoredMessage[],
): ActiveContextValidationFingerprint {
  const transcriptPrefix: ActiveContextValidationFingerprint["transcriptPrefix"] = [];
  for (const message of transcript) {
    if (!isReplayHistoryMessage(message)) continue;
    if (transcriptPrefix.length >= active.transcriptHistoryCount) break;
    transcriptPrefix.push({
      message,
      role: message.role,
      content: message.content,
      providerData: message.providerData,
    });
  }
  return {
    activeMessages: active.messages.map((message) => ({
      message,
      role: message.role,
      content: message.content,
      metadata: message.metadata,
      providerData: message.providerData,
    })),
    activeMessagesArray: active.messages,
    compactionHistoryCount: active.compactionHistoryCount,
    compactionPrefixHash: active.compactionPrefixHash,
    transcriptHistoryCount: active.transcriptHistoryCount,
    transcriptPrefixHash: active.transcriptPrefixHash,
    transcriptPrefix,
  };
}

function activeContextValidationFingerprintMatches(
  active: ActiveContext,
  transcript: StoredMessage[],
  fingerprint: ActiveContextValidationFingerprint,
): boolean {
  if (active.messages !== fingerprint.activeMessagesArray
      || active.compactionHistoryCount !== fingerprint.compactionHistoryCount
      || active.compactionPrefixHash !== fingerprint.compactionPrefixHash
      || active.transcriptHistoryCount !== fingerprint.transcriptHistoryCount
      || active.transcriptPrefixHash !== fingerprint.transcriptPrefixHash
      || active.messages.length !== fingerprint.activeMessages.length) return false;
  for (let index = 0; index < active.messages.length; index++) {
    const message = active.messages[index];
    const saved = fingerprint.activeMessages[index];
    if (message !== saved.message || message.role !== saved.role
        || message.content !== saved.content || message.metadata !== saved.metadata
        || message.providerData !== saved.providerData) return false;
  }

  let prefixIndex = 0;
  for (const message of transcript) {
    if (!isReplayHistoryMessage(message)) continue;
    if (prefixIndex >= fingerprint.transcriptPrefix.length) break;
    const saved = fingerprint.transcriptPrefix[prefixIndex++];
    if (message !== saved.message || message.role !== saved.role
        || message.content !== saved.content || message.providerData !== saved.providerData) return false;
  }
  return prefixIndex === fingerprint.transcriptPrefix.length;
}

/**
 * Validate an immutable active context, reusing a successful check for the same
 * in-memory transcript. Invalid state is deliberately not cached.
 */
export function isValidActiveContextCached(
  active: ActiveContext,
  transcript: StoredMessage[],
): boolean {
  const cached = validatedActiveContexts.get(active)?.get(transcript);
  if (cached && activeContextValidationFingerprintMatches(active, transcript, cached)) return true;
  if (!isValidActiveContext(active, transcript)) return false;
  let byTranscript = validatedActiveContexts.get(active);
  if (!byTranscript) {
    byTranscript = new WeakMap();
    validatedActiveContexts.set(active, byTranscript);
  }
  byTranscript.set(transcript, activeContextValidationFingerprint(active, transcript));
  return true;
}

/** Validate an active context and return its fixed compaction boundary. */
export function validatedActiveContextCompactionHistoryCount(
  active: ActiveContext,
  transcript: StoredMessage[],
): number | null {
  if (!isValidActiveContextCached(active, transcript)) return null;
  return active.compactionHistoryCount !== undefined
    ? active.compactionHistoryCount
    : activeContextCompactionHistoryCount(active, transcript);
}

/**
 * Resolve the immutable transcript cursor represented by the latest compaction.
 * Legacy checkpoints derive it from the persisted compaction divider.
 */
export function activeContextCompactionHistoryCount(
  active: ActiveContext,
  transcript: StoredMessage[],
): number | null {
  if (active.compactionHistoryCount !== undefined || active.compactionPrefixHash !== undefined) {
    if (!Number.isSafeInteger(active.compactionHistoryCount)
        || active.compactionHistoryCount! < 0
        || active.compactionHistoryCount! > active.transcriptHistoryCount
        || typeof active.compactionPrefixHash !== "string"
        || !/^[0-9a-f]{24}$/.test(active.compactionPrefixHash)
        || historyPrefixHash(transcript, active.compactionHistoryCount!) !== active.compactionPrefixHash) {
      return null;
    }
    return active.compactionHistoryCount!;
  }

  let historyCount = 0;
  for (const message of transcript) {
    if (message.role === "system"
        && message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND
        && message.metadata.startedAt === active.compactedAt) {
      const tailCount = active.transcriptHistoryCount - historyCount;
      return tailCount >= 0 && tailCount <= active.messages.length ? historyCount : null;
    }
    if (isReplayHistoryMessage(message)) historyCount += 1;
  }
  return null;
}

function validOpenAICompactionItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as { id?: unknown; encryptedContent?: unknown };
  return (item.id === undefined || (typeof item.id === "string" && item.id.length > 0))
    && typeof item.encryptedContent === "string"
    && item.encryptedContent.length > 0;
}

function validToolResultContentPart(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type !== "image" || !part.source || typeof part.source !== "object" || Array.isArray(part.source)) {
    return false;
  }
  const source = part.source as Record<string, unknown>;
  return source.type === "base64"
    && typeof source.media_type === "string"
    && typeof source.data === "string";
}

function validApiContentBlock(value: unknown, role: ApiMessage["role"]): value is ApiContentBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return typeof block.text === "string";
    case "image": {
      if (role !== "user" || !block.source || typeof block.source !== "object" || Array.isArray(block.source)) return false;
      const source = block.source as Record<string, unknown>;
      return source.type === "base64"
        && typeof source.media_type === "string"
        && typeof source.data === "string";
    }
    case "thinking":
      return role === "assistant"
        && typeof block.thinking === "string"
        && typeof block.signature === "string";
    case "tool_use":
      return role === "assistant"
        && typeof block.id === "string"
        && block.id.length > 0
        && typeof block.name === "string"
        && block.name.length > 0
        && !!block.input
        && typeof block.input === "object"
        && !Array.isArray(block.input);
    case "tool_result":
      return role === "user"
        && typeof block.tool_use_id === "string"
        && block.tool_use_id.length > 0
        && (typeof block.content === "string"
          || (Array.isArray(block.content) && block.content.every(validToolResultContentPart)))
        && (block.is_error === undefined || typeof block.is_error === "boolean");
    default:
      return false;
  }
}

function validAssistantProviderData(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const openai = (value as Record<string, unknown>).openai;
  if (!openai || typeof openai !== "object" || Array.isArray(openai)) return false;
  const data = openai as Record<string, unknown>;
  if (data.replayScope !== undefined) {
    if (!data.replayScope || typeof data.replayScope !== "object" || Array.isArray(data.replayScope)) return false;
    const scope = data.replayScope as Record<string, unknown>;
    if (typeof scope.model !== "string" || scope.model.length === 0) return false;
    if (scope.accountScope !== undefined && typeof scope.accountScope !== "string") return false;
  }
  if (data.responseId !== undefined && typeof data.responseId !== "string") return false;
  if (data.compactionItems !== undefined
      && (!Array.isArray(data.compactionItems) || !data.compactionItems.every(validOpenAICompactionItem))) return false;
  if (data.reasoningItems !== undefined) {
    if (!Array.isArray(data.reasoningItems)) return false;
    for (const raw of data.reasoningItems) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== "string" || item.id.length === 0) return false;
      if (item.encryptedContent !== null && typeof item.encryptedContent !== "string") return false;
      if (!Array.isArray(item.summaries) || !item.summaries.every((entry) => typeof entry === "string")) return false;
      if (item.rawContent !== undefined
          && (!Array.isArray(item.rawContent) || !item.rawContent.every((entry) => typeof entry === "string"))) return false;
    }
  }
  return true;
}

function validActiveReplayMessages(value: unknown[]): value is ApiMessage[] {
  const outstandingToolUses = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const message = raw as Partial<ApiMessage>;
    if (message.role !== "user" && message.role !== "assistant") return false;
    if (typeof message.content !== "string") {
      if (!Array.isArray(message.content)
          || !message.content.every((block) => validApiContentBlock(block, message.role!))) return false;

      // Responses replay requires a tool-result container immediately after the
      // assistant tool calls it resolves. Do not accept a derived checkpoint
      // that merely resolves orphaned calls at some later point in history.
      if (outstandingToolUses.size > 0) {
        if (message.role !== "user" || message.content.length === 0
            || message.content.some((block) => block.type !== "tool_result")) return false;
      }
      for (const block of message.content) {
        if (block.type === "tool_use") {
          if (outstandingToolUses.has(block.id)) return false;
          outstandingToolUses.add(block.id);
        } else if (block.type === "tool_result") {
          if (!outstandingToolUses.delete(block.tool_use_id)) return false;
        }
      }
      if (message.role === "user" && outstandingToolUses.size > 0) return false;
    } else if (outstandingToolUses.size > 0) {
      return false;
    }
    if (!validAssistantProviderData(message.providerData)) return false;
  }
  return outstandingToolUses.size === 0;
}

function countValidNativeCompactionItems(messages: ApiMessage[]): number | null {
  let count = 0;
  for (const message of messages) {
    const openai = message.providerData?.openai;
    const items = openai?.compactionItems;
    if (items === undefined) continue;
    if (message.role !== "assistant" || !Array.isArray(items) || !items.every(validOpenAICompactionItem)) {
      return null;
    }
    count += items.length;
  }
  return count;
}

/** Derived replay is disposable: reject malformed/stale state and use transcript. */
export function isValidActiveContext(active: unknown, transcript: StoredMessage[]): active is ActiveContext {
  if (!active || typeof active !== "object") return false;
  const value = active as Partial<ActiveContext>;
  if (value.version !== 1) return false;
  if (value.kind !== "openai_native" && value.kind !== "plaintext") return false;
  if (typeof value.provider !== "string" || value.provider.length === 0
      || typeof value.model !== "string" || value.model.length === 0) return false;
  if (value.accountScope !== undefined
      && (typeof value.accountScope !== "string" || value.accountScope.length === 0)) return false;
  if (value.kind === "openai_native" && value.provider !== "openai") return false;
  if (!Array.isArray(value.messages) || !validActiveReplayMessages(value.messages)) return false;
  if (value.kind === "openai_native" && countValidNativeCompactionItems(value.messages as ApiMessage[]) !== 1) return false;
  if (value.kind === "plaintext") {
    const checkpointCount = (value.messages as ApiMessage[]).filter((message) =>
      message.role === "user"
      && message.metadata?.system === true
      && message.metadata?.kind === "context_checkpoint"
      && typeof message.content === "string"
      && message.content.length > 0
    ).length;
    if (checkpointCount !== 1) return false;
  }
  if (!Number.isSafeInteger(value.transcriptHistoryCount) || value.transcriptHistoryCount! < 0) return false;
  const historyCount = transcript.filter(isReplayHistoryMessage).length;
  if (value.transcriptHistoryCount! > historyCount) return false;
  if (typeof value.transcriptPrefixHash !== "string" || !/^[0-9a-f]{24}$/.test(value.transcriptPrefixHash)) return false;
  const hasCompactionCount = value.compactionHistoryCount !== undefined;
  const hasCompactionHash = value.compactionPrefixHash !== undefined;
  if (hasCompactionCount !== hasCompactionHash) return false;
  if (hasCompactionCount) {
    if (!Number.isSafeInteger(value.compactionHistoryCount)
        || value.compactionHistoryCount! < 0
        || value.compactionHistoryCount! > value.transcriptHistoryCount!
        || typeof value.compactionPrefixHash !== "string"
        || !/^[0-9a-f]{24}$/.test(value.compactionPrefixHash)) return false;
    // Every replay message after the fixed compaction boundary is a suffix of
    // active.messages. Without this invariant a rewind could cut into the opaque
    // checkpoint itself.
    if (value.transcriptHistoryCount! - value.compactionHistoryCount! > value.messages.length) return false;
  }
  const prefixHashes = historyPrefixHashes(transcript, [
    value.transcriptHistoryCount!,
    ...(hasCompactionCount ? [value.compactionHistoryCount!] : []),
  ]);
  if (prefixHashes.get(value.transcriptHistoryCount!) !== value.transcriptPrefixHash) return false;
  if (hasCompactionCount
      && prefixHashes.get(value.compactionHistoryCount!) !== value.compactionPrefixHash) return false;
  if (typeof value.windowId !== "string" || value.windowId.length === 0) return false;
  if (!Number.isSafeInteger(value.windowNumber) || value.windowNumber! < 1) return false;
  if (!Number.isSafeInteger(value.compactedAt) || value.compactedAt! < 0
      || !Number.isSafeInteger(value.compactionCount) || value.compactionCount! < 1) return false;
  return true;
}

/**
 * Rewind an active compact replay to a canonical transcript prefix. Only the
 * one-to-one post-compaction tail is removed; the opaque checkpoint is retained.
 */
export function rewindActiveContextToHistoryCount(
  active: ActiveContext,
  transcript: StoredMessage[],
  targetHistoryCount: number,
): ActiveContext | null {
  if (!Number.isSafeInteger(targetHistoryCount) || targetHistoryCount < 0) return null;
  const transcriptHistoryCount = transcript.filter(isReplayHistoryMessage).length;
  if (targetHistoryCount > transcriptHistoryCount) return null;
  const compactionHistoryCount = activeContextCompactionHistoryCount(active, transcript);
  if (compactionHistoryCount == null || targetHistoryCount < compactionHistoryCount) return null;

  const rewound = structuredClone(active);
  const removeCount = rewound.transcriptHistoryCount - targetHistoryCount;
  if (removeCount > 0) {
    if (removeCount > rewound.messages.length) return null;
    rewound.messages.splice(rewound.messages.length - removeCount, removeCount);
    rewound.transcriptHistoryCount = targetHistoryCount;
    rewound.transcriptPrefixHash = historyPrefixHash(transcript, targetHistoryCount);
  }
  return isValidActiveContext(rewound, transcript) ? rewound : null;
}

/** True for user-authored prompts, excluding tool_result containers and model-visible system notices. */
export function isRealUserMessage(msg: StoredMessage): boolean {
  return msg.role === "user" && !isToolResultMessage(msg) && !isModelVisibleSystemNotice(msg);
}

/** Build API-ready user content — structured array when images are present, plain string otherwise. */
export function buildUserContent(text: string, images?: ImageAttachment[]): string | ApiContentBlock[] {
  if (!images?.length) return text;
  return [
    ...images.map((img): ApiContentBlock => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

/** Build a stored user message from text + optional images. */
export function createStoredUserMessage(
  text: string,
  model: ModelId,
  startedAt: number,
  images?: ImageAttachment[],
  options: {
    subagentNotificationId?: string;
    queueEntryId?: string;
    contextCheckpoint?: StoredUserContextCheckpoint;
  } = {},
): StoredMessage {
  const metadata = createMessageMetadata(startedAt, model, { endedAt: startedAt });
  if (options.subagentNotificationId) metadata.subagentNotificationId = options.subagentNotificationId;
  if (options.queueEntryId) metadata.queueEntryId = options.queueEntryId;
  return {
    role: "user",
    content: buildUserContent(text, images),
    metadata,
    ...(options.contextCheckpoint ? { contextCheckpoint: options.contextCheckpoint } : {}),
  };
}

/** Capture the provider replay cursor immediately before adding a user message. */
export function createStoredUserContextCheckpoint(
  conv: Conversation,
  transcript: StoredMessage[] = conv.messages,
  contextTokens: number | null = conv.lastContextTokens,
): StoredUserContextCheckpoint {
  const transcriptHistoryCount = transcript.filter(isReplayHistoryMessage).length;
  const active = conv.activeContext && isValidActiveContextCached(conv.activeContext, transcript)
    ? conv.activeContext
    : null;
  return {
    version: 1,
    provider: conv.provider,
    model: conv.model,
    windowId: active?.windowId ?? null,
    transcriptHistoryCount,
    transcriptPrefixHash: historyPrefixHash(transcript, transcriptHistoryCount),
    contextTokens: contextTokens ?? (transcriptHistoryCount === 0 ? 0 : null),
  };
}

/** Build turn index → messages index mapping for model-visible user/assistant history. */
export function buildHistoryTurnMap(messages: StoredMessage[]): number[] {
  const map: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isHistoryMessage(messages[i])) map.push(i);
  }
  return map;
}

/** Count user-visible turns for summaries/UI, excluding non-turn status entries. */
export function countConversationMessages(messages: StoredMessage[]): number {
  return messages.filter((msg) =>
    msg.role !== "system_instructions"
    && !isModelVisibleSystemNotice(msg)
    && msg.metadata?.kind !== CONTEXT_COMPACTION_FINISHED_KIND
  ).length;
}

export type PersistedConversationSummary = Omit<
  ConversationSummary,
  "streaming" | "unread" | "subagentCount" | "backgroundTaskCount" | "tasks" | "integrations"
>;
export type PersistedFolderSummary = Omit<FolderSummary, "effectiveInstructions">;

export function summarizeConversation(conv: Conversation): PersistedConversationSummary {
  return {
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort ?? DEFAULT_EFFORT,
    fastMode: conv.fastMode ?? false,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: countConversationMessages(conv.messages),
    title: conv.title,
    goal: conv.goal?.status === "complete" ? null : conv.goal ?? null,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
    folderId: conv.folderId ?? null,
  };
}

export function createConversation(
  id: string,
  provider: ProviderId,
  model: ModelId,
  sortOrder?: number,
  title?: string,
  effort?: EffortLevel,
  fastMode = false,
  folderId: string | null = null,
): Conversation {
  const now = Date.now();
  return {
    id,
    provider,
    model,
    effort: effort ?? DEFAULT_EFFORT,
    fastMode,
    messages: [],
    createdAt: now,
    updatedAt: now,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: sortOrder ?? -now,
    folderId,
    title: title ?? "",
  };
}
