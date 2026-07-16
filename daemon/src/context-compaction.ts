import { streamMessage } from "./api";
import { log } from "./log";
import {
  createModelVisibleSystemNotice,
  isReplayHistoryMessage,
  isModelVisibleSystemNotice,
  isValidActiveContextCached,
  type ActiveContext,
  type ApiContentBlock,
  type ApiMessage,
  type Conversation,
  type EffortLevel,
  type ModelId,
  type ProviderId,
  type TokenTrackingContext,
} from "./messages";
import { contextMessageChars } from "./context-token-attribution";
import type { ProviderTurnSession, ServiceTier, StreamCallbacks, StreamOptions, StreamRequestBudget } from "./providers/types";

export const AUTO_COMPACTION_FRACTION = 0.9;
const OPENAI_RETAINED_USER_TOKENS = 64_000;
const PLAINTEXT_RETAINED_USER_TOKENS = 20_000;
const SUMMARY_MAX_OUTPUT_TOKENS = 12_000;
// OpenAI's normal transient-error loop allows eight retries after the initial
// request. Native compaction shares one operation-wide budget with that loop.
const NATIVE_REQUEST_MAX_ATTEMPTS = 9;
// Completed but malformed checkpoint responses retain their narrower semantic
// retry policy; they are not transport errors and do not use exponential backoff.
const INVALID_NATIVE_RESPONSE_MAX_ATTEMPTS = 4;

const SUMMARY_SYSTEM_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another language model that will continue the conversation.

Include:
- the user's goals, requirements, and preferences
- important decisions and why they were made
- work already completed and its results
- exact files, commands, APIs, identifiers, and errors that still matter
- current task state and the next concrete steps
- unresolved questions, risks, and constraints

Be concise but preserve operational detail. Do not continue the task. Output only the handoff summary.`;

const SUMMARY_PREFIX = "Another language model started this task and produced the following continuation checkpoint. Use it as working context while honoring the original user messages that follow or precede it:\n\n";

class InvalidNativeCompactionResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNativeCompactionResponseError";
  }
}

export type CompactionReason = "pre_turn" | "tool_round" | "context_error" | "provider_switch" | "manual";

export interface ContextCompactionOptions {
  provider: ProviderId;
  model: ModelId;
  system?: string;
  signal?: AbortSignal;
  tools?: unknown[];
  effort?: EffortLevel;
  serviceTier?: ServiceTier;
  promptCacheKey?: string;
  tracking?: TokenTrackingContext;
  turnSession?: ProviderTurnSession;
  contextLimit?: number | null;
  accountScope?: string;
  codexWindowId?: string;
  codexTurnId?: string;
  codexTurnStartedAtMs?: number;
  reason?: CompactionReason;
  onHeaders?: (headers: Headers) => void;
  /** Native OpenAI retry events; plaintext summary retries remain intentionally hidden. */
  onNativeRetry?: StreamCallbacks["onRetry"];
  /** Called immediately before OpenAI native compaction falls back to plaintext. */
  onPlaintextFallback?: (warning: string) => void;
  /** Test seam for provider streaming. Production always uses streamMessage. */
  streamMessageFn?: typeof streamMessage;
}

export interface ContextCompactionResult {
  messages: ApiMessage[];
  kind: ActiveContext["kind"];
  /** Verified provider account scope that produced an opaque checkpoint. */
  accountScope?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function hasProviderScopedReplayData(messages: ApiMessage[]): boolean {
  return messages.some((message) => {
    const openai = message.providerData?.openai;
    return (openai?.compactionItems?.length ?? 0) > 0
      || (openai?.reasoningItems?.length ?? 0) > 0;
  });
}

function hasProviderScopedReplayDataInMessage(message: ApiMessage | Conversation["messages"][number]): boolean {
  const openai = message.providerData?.openai;
  return (openai?.compactionItems?.length ?? 0) > 0
    || (openai?.reasoningItems?.length ?? 0) > 0;
}

function hasExactOpenAIScope(
  provider: ProviderId,
  model: ModelId,
  accountScope: string | undefined,
  scopedProvider: ProviderId,
  scopedModel: ModelId,
  scopedAccount: string | undefined,
): boolean {
  return provider === "openai"
    && scopedProvider === provider
    && scopedModel === model
    && scopedAccount === accountScope;
}

function isMessageProviderDataCompatible(
  message: ApiMessage | Conversation["messages"][number],
  provider: ProviderId,
  model: ModelId,
  accountScope: string | undefined,
  allowLegacyUnscoped: boolean,
): boolean {
  if (!hasProviderScopedReplayDataInMessage(message)) return true;
  if (provider !== "openai") return false;
  const scope = message.providerData?.openai?.replayScope;
  if (!scope) return allowLegacyUnscoped;
  return scope.model === model && scope.accountScope === accountScope;
}

function asApiMessage(
  message: Conversation["messages"][number],
  stripProviderScopedData = false,
): ApiMessage {
  // Replay projection must never alias mutable nested transcript arrays. In
  // particular, adding a safe reasoning summary during scope sanitization must
  // not mutate the canonical visible/audit transcript.
  let content = structuredClone(message.content);
  if (stripProviderScopedData && message.role === "assistant" && Array.isArray(content)) {
    let preservedThinking = false;
    content = content.map((block): ApiContentBlock => {
      if (block.type !== "thinking") return structuredClone(block);
      preservedThinking = true;
      return {
        type: "text",
        text: `[Prior assistant reasoning summary]\n${block.thinking}`,
      };
    });
    if (!preservedThinking) {
      const summaries = message.providerData?.openai?.reasoningItems
        ?.flatMap((item) => item.summaries ?? [])
        .filter(Boolean);
      if (summaries?.length) {
        content.push({
          type: "text",
          text: `[Prior assistant reasoning summary]\n${summaries.join("\n")}`,
        });
      }
    }
  }
  return {
    role: message.role as "user" | "assistant",
    content,
    metadata: structuredClone(message.metadata),
    providerData: stripProviderScopedData ? undefined : structuredClone(message.providerData),
    contextTokens: structuredClone(message.contextTokens),
    contextCheckpoint: structuredClone(message.contextCheckpoint),
  };
}

export function isActiveContextCompatible(
  active: ActiveContext,
  provider: ProviderId,
  model: ModelId,
  accountScope?: string,
): boolean {
  const exactOpenAIScope = hasExactOpenAIScope(
    provider,
    model,
    accountScope,
    active.provider,
    active.model,
    active.accountScope,
  );
  if (active.kind === "openai_native" && !exactOpenAIScope) return false;
  if (!hasProviderScopedReplayData(active.messages)) return true;
  return active.messages.every((message) => isMessageProviderDataCompatible(
    message,
    provider,
    model,
    accountScope,
    // Older checkpoints predate per-message stamps. Their persisted checkpoint
    // scope is sufficient proof, but only on an exact OpenAI match.
    exactOpenAIScope,
  ));
}

/** Build model replay while leaving the complete visible transcript untouched. */
export function buildConversationApiContext(conv: Conversation, accountScope?: string): {
  messages: ApiMessage[];
  usedActiveContext: boolean;
  tailMessages: ApiMessage[];
} {
  const active = conv.activeContext;
  const activeValid = active != null && isValidActiveContextCached(active, conv.messages);
  const activeCompatible = active != null && activeValid
    && isActiveContextCompatible(active, conv.provider, conv.model, accountScope);
  if (!active || !activeValid || !activeCompatible) {
    // Provider data is scoped independently on every assistant response. This
    // also protects ordinary, never-compacted transcripts after model/account
    // switches and conservatively sanitizes legacy unscoped encrypted data.
    const messages = conv.messages
      .filter(isReplayHistoryMessage)
      .map((message) => asApiMessage(
        message,
        !isMessageProviderDataCompatible(message, conv.provider, conv.model, accountScope, false),
      ));
    return { messages, usedActiveContext: false, tailMessages: messages };
  }

  const exactActiveScope = hasExactOpenAIScope(
    conv.provider,
    conv.model,
    accountScope,
    active.provider,
    active.model,
    active.accountScope,
  );
  const tailMessages: ApiMessage[] = [];
  let historyIndex = 0;
  for (const message of conv.messages) {
    if (!isReplayHistoryMessage(message)) continue;
    if (historyIndex++ < active.transcriptHistoryCount) continue;
    tailMessages.push(asApiMessage(
      message,
      !isMessageProviderDataCompatible(
        message,
        conv.provider,
        conv.model,
        accountScope,
        // A legacy tail appended under an exact scoped checkpoint is known to
        // have been produced in that same provider session.
        exactActiveScope,
      ),
    ));
  }
  return {
    messages: [...structuredClone(active.messages), ...tailMessages],
    usedActiveContext: true,
    tailMessages,
  };
}

export function estimateContextTokens(messages: ApiMessage[], provider: ProviderId): number {
  const chars = messages.reduce((sum, message) => sum + contextMessageChars(message as Conversation["messages"][number], provider), 0);
  return Math.max(0, Math.ceil(chars / 4));
}

export function shouldAutoCompact(projectedTokens: number, contextLimit: number | null | undefined): boolean {
  return contextLimit != null && contextLimit > 0 && projectedTokens >= Math.floor(contextLimit * AUTO_COMPACTION_FRACTION);
}

export function isContextWindowError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const value = text.toLowerCase();
  return value.includes("context_length_exceeded")
    || value.includes("maximum context length")
    || value.includes("too many tokens")
    || (value.includes("context window") && (value.includes("exceed") || value.includes("too large")))
    || (value.includes("input") && value.includes("exceed") && value.includes("context"));
}

function isToolResultMessage(message: ApiMessage): boolean {
  return Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result");
}

function isRealUserMessage(message: ApiMessage): boolean {
  return message.role === "user" && !isToolResultMessage(message)
    && !isModelVisibleSystemNotice(message as Conversation["messages"][number]);
}

function truncateUserMessage(message: ApiMessage, tokenBudget: number): ApiMessage | null {
  if (tokenBudget <= 0 || message.role !== "user") return null;
  const charBudget = Math.max(1, tokenBudget * 4);
  if (typeof message.content === "string") {
    return { ...structuredClone(message), content: message.content.slice(0, charBudget) };
  }

  let remainingChars = charBudget;
  const content: ApiContentBlock[] = [];
  for (const block of message.content) {
    if (block.type === "image") {
      if (remainingChars < 4_420) continue;
      content.push(structuredClone(block));
      remainingChars -= 4_420;
    } else if (block.type === "text" && remainingChars > 0) {
      const text = block.text.slice(0, remainingChars);
      if (text) content.push({ type: "text", text });
      remainingChars -= text.length;
    }
  }
  return content.length > 0 ? { ...structuredClone(message), content } : null;
}

function retainRecentUserMessages(messages: ApiMessage[], provider: ProviderId, tokenBudget: number): ApiMessage[] {
  const retained: ApiMessage[] = [];
  let remaining = tokenBudget;
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index--) {
    const message = messages[index];
    if (!isRealUserMessage(message)) continue;
    const tokens = Math.max(1, estimateContextTokens([message], provider));
    if (tokens <= remaining) {
      retained.push(structuredClone(message));
      remaining -= tokens;
      continue;
    }
    const partial = truncateUserMessage(message, remaining);
    if (partial) retained.push(partial);
    remaining = 0;
  }
  return retained.reverse();
}

function compactStreamOptions(options: ContextCompactionOptions, extra: Partial<StreamOptions> = {}): StreamOptions {
  return {
    system: options.system,
    signal: options.signal,
    tools: options.tools,
    effort: options.effort,
    serviceTier: options.serviceTier,
    promptCacheKey: options.promptCacheKey,
    tracking: options.tracking,
    turnSession: options.turnSession,
    codexWindowId: options.codexWindowId,
    accountScope: options.accountScope,
    codexTurnId: options.codexTurnId,
    codexTurnStartedAtMs: options.codexTurnStartedAtMs,
    ...extra,
  };
}

async function nativeOpenAICompaction(
  messages: ApiMessage[],
  options: ContextCompactionOptions,
  requestBudget: StreamRequestBudget,
): Promise<ContextCompactionResult> {
  // Production transports consume the shared budget immediately before each
  // request submission. Test seams represent one request per invocation.
  if (options.streamMessageFn) {
    if (requestBudget.attempts >= requestBudget.maxAttempts) {
      throw new Error("OpenAI native compaction request budget exhausted");
    }
    requestBudget.attempts += 1;
  }
  const result = await (options.streamMessageFn ?? streamMessage)("openai", messages, options.model, {
    onText: () => {},
    onThinking: () => {},
    onHeaders: options.onHeaders,
    onRetry: options.onNativeRetry,
  }, compactStreamOptions(options, {
    compaction: true,
    requestBudget,
    compactionMetadata: {
      reason: options.reason === "provider_switch" ? "model_downshift" : "context_limit",
      phase: options.reason === "tool_round" ? "mid_turn" : "pre_turn",
    },
  }));

  // The collector may see unrelated function-call output alongside the single
  // checkpoint. A completed Responses stream reports that as tool_use in the
  // generic parser; compaction ignores those items rather than executing them.
  if (result.stopReason !== "stop" && result.stopReason !== "tool_use") {
    throw new InvalidNativeCompactionResponseError(`OpenAI native compaction did not complete (stopReason=${result.stopReason || "unknown"})`);
  }
  if (result.responseCompleted === false) {
    throw new InvalidNativeCompactionResponseError("OpenAI native compaction ended without response.completed");
  }
  if (result.compactionDoneCount != null && result.compactionDoneCount !== 1) {
    throw new InvalidNativeCompactionResponseError(`OpenAI native compaction observed ${result.compactionDoneCount} completed checkpoint items (expected exactly 1)`);
  }
  if (result.compactionItems?.length !== 1) {
    throw new InvalidNativeCompactionResponseError(`OpenAI native compaction returned ${result.compactionItems?.length ?? 0} checkpoint items (expected exactly 1)`);
  }
  const responseReplayScope = result.assistantProviderData?.openai.replayScope;
  const checkpointReplayScope = responseReplayScope ?? {
    model: options.model,
    ...(options.accountScope ? { accountScope: options.accountScope } : {}),
  };
  const checkpoint: ApiMessage = {
    role: "assistant",
    content: [],
    providerData: {
      openai: {
        replayScope: checkpointReplayScope,
        compactionItems: result.compactionItems,
      },
    },
  };
  return {
    messages: [
      ...retainRecentUserMessages(messages, "openai", OPENAI_RETAINED_USER_TOKENS),
      checkpoint,
    ],
    kind: "openai_native",
    ...(checkpointReplayScope.accountScope ? { accountScope: checkpointReplayScope.accountScope } : {}),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}

function summaryInputBudget(contextLimit?: number | null): number {
  // Unknown custom models still need a bounded emergency path after an actual
  // context error. Reserve output plus request/system overhead instead of
  // filling the entire provider window with summary input.
  const limit = contextLimit && contextLimit > 0 ? contextLimit : 160_000;
  return Math.max(8_000, Math.min(Math.floor(limit * 0.94), limit - SUMMARY_MAX_OUTPUT_TOKENS - 4_000));
}

function hasOpaqueCompactionItem(messages: ApiMessage[]): boolean {
  return messages.some((message) => (message.providerData?.openai?.compactionItems?.length ?? 0) > 0);
}

function summarySafeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarySafeUnknown);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image") {
    const source = record.source && typeof record.source === "object"
      ? record.source as Record<string, unknown>
      : {};
    const data = typeof source.data === "string" ? source.data : "";
    return {
      type: "image",
      media_type: typeof source.media_type === "string" ? source.media_type : "unknown",
      byte_length: data ? Math.floor(data.length * 0.75) : undefined,
      note: "binary image omitted from textual checkpoint input",
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, summarySafeUnknown(item)]));
}

function serializeMessagesForHierarchicalSummary(messages: ApiMessage[]): string[] {
  return messages.map((message, index) => {
    const reasoningSummaries = message.providerData?.openai?.reasoningItems
      ?.flatMap((item) => item.summaries ?? [])
      .filter(Boolean);
    return JSON.stringify({
      sequence: index + 1,
      role: message.role,
      content: summarySafeUnknown(message.content),
      ...(reasoningSummaries?.length ? { provider_reasoning_summaries: reasoningSummaries } : {}),
      ...(message.metadata?.system ? { model_visible_system_notice: true, kind: message.metadata.kind } : {}),
    });
  });
}

function splitTextWithOverlap(text: string, maxChars: number, overlapChars = 512): string[] {
  if (!text) return [""];
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  const overlap = Math.min(overlapChars, Math.max(0, maxChars >> 2));
  const step = Math.max(1, maxChars - overlap);
  for (let offset = 0; offset < text.length; offset += step) {
    parts.push(text.slice(offset, offset + maxChars));
    if (offset + maxChars >= text.length) break;
  }
  return parts;
}

function packSummaryUnits(units: string[], maxChars: number): string[] {
  const segments: string[] = [];
  let current = "";
  for (const unit of units) {
    if (unit.length > maxChars) {
      if (current) segments.push(current);
      current = "";
      segments.push(...splitTextWithOverlap(unit, maxChars));
      continue;
    }
    const candidate = current ? `${current}\n${unit}` : unit;
    if (candidate.length > maxChars) {
      segments.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) segments.push(current);
  return segments.length > 0 ? segments : [""];
}

function containsImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsImage);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "image" || Object.values(record).some(containsImage);
}

function hasImageContent(messages: ApiMessage[]): boolean {
  return messages.some((message) => containsImage(message.content));
}

interface SummaryAccumulator {
  inputTokens: number;
  outputTokens: number;
  sawInputTokens: boolean;
  sawOutputTokens: boolean;
}

async function requestPlaintextSummary(
  summaryInput: ApiMessage[],
  options: ContextCompactionOptions,
  totals: SummaryAccumulator,
): Promise<string> {
  const summaryRequest: ApiMessage[] = [
    ...summaryInput,
    { role: "user", content: SUMMARY_SYSTEM_PROMPT },
  ];
  const result = await (options.streamMessageFn ?? streamMessage)(options.provider, summaryRequest, options.model, {
    onText: () => {},
    onThinking: () => {},
    onHeaders: options.onHeaders,
  }, compactStreamOptions(options, {
    system: "Create a faithful continuation checkpoint. Output only the checkpoint.",
    tools: undefined,
    // Reuse the outer OpenAI session so any parked conversation socket is
    // adopted and can be invalidated when the replacement window is installed.
    turnSession: options.provider === "openai" ? options.turnSession : undefined,
    maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    preferHttp: true,
    compaction: false,
    promptCacheKey: options.provider === "openai" && options.turnSession
      ? options.promptCacheKey
      : options.promptCacheKey ? `${options.promptCacheKey}-compact` : undefined,
  }));

  if (result.stopReason !== "stop") {
    throw new Error(`Plaintext compaction did not complete (stopReason=${result.stopReason || "unknown"})`);
  }
  const summary = result.text.trim();
  if (!summary) throw new Error("Plaintext compaction returned an empty checkpoint");
  if (result.inputTokens != null) {
    totals.inputTokens += result.inputTokens;
    totals.sawInputTokens = true;
  }
  if (result.outputTokens != null) {
    totals.outputTokens += result.outputTokens;
    totals.sawOutputTokens = true;
  }
  return summary;
}

async function summarizeTextAdaptively(
  text: string,
  label: string,
  options: ContextCompactionOptions,
  totals: SummaryAccumulator,
  depth = 0,
): Promise<string> {
  try {
    return await requestPlaintextSummary([{
      role: "user",
      content: `${label}\n\n${text}`,
    }], options, totals);
  } catch (error) {
    if (!isContextWindowError(error) || depth >= 12 || text.length < 2_000) throw error;
    const midpoint = Math.floor(text.length / 2);
    const overlap = Math.min(512, Math.floor(text.length / 8));
    const left = text.slice(0, midpoint + overlap);
    const right = text.slice(Math.max(0, midpoint - overlap));
    const leftSummary = await summarizeTextAdaptively(left, `${label} (left continuation)`, options, totals, depth + 1);
    const rightSummary = await summarizeTextAdaptively(right, `${label} (right continuation)`, options, totals, depth + 1);
    return summarizeTextAdaptively(
      `Left summary:\n${leftSummary}\n\nRight summary:\n${rightSummary}`,
      "Merge these overlapping continuation summaries without dropping facts from either side.",
      options,
      totals,
      depth + 1,
    );
  }
}

async function createFaithfulPlaintextSummary(
  messages: ApiMessage[],
  options: ContextCompactionOptions,
  totals: SummaryAccumulator,
): Promise<string> {
  const budget = summaryInputBudget(options.contextLimit);
  const promptTokens = Math.ceil(SUMMARY_SYSTEM_PROMPT.length / 4);
  if (estimateContextTokens(messages, options.provider) + promptTokens <= budget) {
    try {
      return await requestPlaintextSummary(messages, options, totals);
    } catch (error) {
      if (!isContextWindowError(error)) throw error;
      // Fall through to adaptive hierarchy using a provider-independent textual
      // representation. No active replacement has been committed yet.
    }
  }

  // Opaque checkpoints are meaningful only to the provider that created them;
  // converting one to JSON text would silently destroy its represented prefix.
  // A native replay should already be compact enough to fit its creating
  // provider. If it still does not, fail atomically rather than install a lossy
  // plaintext checkpoint.
  if (hasOpaqueCompactionItem(messages)) {
    throw new Error("Plaintext compaction input with an opaque checkpoint exceeds the provider context window");
  }
  if (hasImageContent(messages)) {
    throw new Error("Oversized multimodal context cannot be hierarchically compacted without losing image contents");
  }

  const maxSegmentChars = Math.max(8_000, (budget - promptTokens - 1_000) * 4);
  const segments = packSummaryUnits(serializeMessagesForHierarchicalSummary(messages), maxSegmentChars);
  const summaries: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    summaries.push(await summarizeTextAdaptively(
      segments[index],
      `Transcript checkpoint segment ${index + 1}/${segments.length}. Preserve every durable fact, identifier, decision, error, and unfinished task from this segment.`,
      options,
      totals,
    ));
  }
  const combined = summaries
    .map((summary, index) => `Segment summary ${index + 1}/${summaries.length}:\n${summary}`)
    .join("\n\n");
  return summarizeTextAdaptively(
    combined,
    "Merge these ordered segment summaries into one faithful continuation checkpoint. Do not omit information merely because it appears only in an early segment.",
    options,
    totals,
  );
}

async function plaintextCompaction(messages: ApiMessage[], options: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const totals: SummaryAccumulator = {
    inputTokens: 0,
    outputTokens: 0,
    sawInputTokens: false,
    sawOutputTokens: false,
  };
  const summary = await createFaithfulPlaintextSummary(messages, options, totals);
  const checkpoint = createModelVisibleSystemNotice(
    `${SUMMARY_PREFIX}${summary}`,
    options.model,
    "context_checkpoint",
  );
  return {
    messages: [
      ...retainRecentUserMessages(messages, options.provider, PLAINTEXT_RETAINED_USER_TOKENS),
      checkpoint,
    ],
    kind: "plaintext",
    ...(options.provider === "openai" && options.accountScope ? { accountScope: options.accountScope } : {}),
    inputTokens: totals.sawInputTokens ? totals.inputTokens : undefined,
    outputTokens: totals.sawOutputTokens ? totals.outputTokens : undefined,
  };
}

/** Compact one active replay atomically. The caller persists only on success. */
export async function compactContextMessages(
  messages: ApiMessage[],
  options: ContextCompactionOptions,
): Promise<ContextCompactionResult> {
  if (options.provider === "openai") {
    const requestBudget: StreamRequestBudget = {
      maxAttempts: NATIVE_REQUEST_MAX_ATTEMPTS,
      attempts: 0,
    };
    let nativeFailure: unknown;
    let nativeRetriesExhausted = false;
    while (requestBudget.attempts < requestBudget.maxAttempts) {
      try {
        return await nativeOpenAICompaction(messages, options, requestBudget);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        nativeFailure = error;
        if (!(error instanceof InvalidNativeCompactionResponseError)) break;
        if (requestBudget.attempts >= INVALID_NATIVE_RESPONSE_MAX_ATTEMPTS) {
          nativeRetriesExhausted = true;
          break;
        }

        const retryNumber = requestBudget.attempts;
        const maxRetries = INVALID_NATIVE_RESPONSE_MAX_ATTEMPTS - 1;

        // A completed but malformed response is not a valid incremental base.
        // Destroy it before retrying the full replay + compaction trigger.
        try {
          await options.turnSession?.resetAfterCompaction?.();
        } catch (resetError) {
          if (options.signal?.aborted) throw resetError;
          nativeFailure = resetError;
          break;
        }
        log(
          "warn",
          `context compaction: OpenAI returned an invalid native checkpoint; retrying cleanly (${retryNumber}/${maxRetries}): ${error.message}`,
        );
        options.onNativeRetry?.(
          retryNumber,
          maxRetries,
          error.message,
          0,
          { kind: "transient" },
        );
      }
    }

    const failure = nativeFailure instanceof Error ? nativeFailure.message : String(nativeFailure);
    const exhausted = nativeRetriesExhausted || requestBudget.attempts >= requestBudget.maxAttempts
      ? " after exhausting its retries"
      : "";
    const warning = `⚠ OpenAI server-side context compaction failed${exhausted}; falling back to a model-generated plaintext checkpoint. ${failure}`;
    log("warn", `context compaction: ${warning}`);
    options.onPlaintextFallback?.(warning);
  }
  return plaintextCompaction(messages, options);
}
