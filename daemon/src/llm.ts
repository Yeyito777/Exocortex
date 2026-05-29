/**
 * Lightweight inner LLM completions.
 *
 * Wraps streamMessage() for simple prompt-in / text-out use cases
 * where tools and streaming callbacks aren't needed — e.g. a tool
 * that wants to post-process its output through a model before
 * returning the result to the agent loop.
 *
 * This is NOT the main conversation path. For the outer agent loop
 * see agent.ts; for the full orchestration see orchestrator.ts.
 */

import { streamMessage } from "./api";
import { log } from "./log";
import type { ProviderId, ModelId, EffortLevel, TokenTrackingContext } from "./messages";
import type { ServiceTier } from "./providers/types";
import { getDefaultModel, getDefaultProvider } from "./providers/registry";

// ── Types ──────────────────────────────────────────────────────────

export interface CompleteOptions {
  /** Provider to use. Defaults to the app's default provider. */
  provider?: ProviderId;
  /** Model to use. Defaults to the provider's default model. */
  model?: ModelId;
  /** Max output tokens. Defaults to 4096. */
  maxTokens?: number;
  /** Optional reasoning effort override for utility completions. */
  effort?: EffortLevel;
  /** Optional provider latency/capacity tier for utility completions. */
  serviceTier?: ServiceTier;
  /** Prefer a simple HTTP/SSE provider request for one-shot completions. */
  preferHttp?: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional token-accounting metadata for this helper request. */
  tracking?: TokenTrackingContext;
  /** OpenAI/Codex request correlation key for inner completions. */
  promptCacheKey?: string;
}

export interface CompleteResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ── No-op callbacks ────────────────────────────────────────────────

const noop = () => {};

let innerCompletionCounter = 0;

function defaultPromptCacheKey(provider: ProviderId, tracking?: TokenTrackingContext): string | undefined {
  if (provider !== "openai") return undefined;

  const source = tracking?.source?.replace(/[^a-zA-Z0-9_-]/g, "-") || "inner";
  const conversationId = tracking?.conversationId?.replace(/[^a-zA-Z0-9_-]/g, "-");
  const sequence = ++innerCompletionCounter;
  return conversationId
    ? `${conversationId}-${source}-${sequence}`
    : `${source}-${Date.now()}-${sequence}`;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Run a single LLM completion. No tools, no streaming callbacks,
 * no conversation state — just system + user text in, text out.
 *
 * ```ts
 * const { text } = await complete("Summarize this page.", markdown);
 * ```
 */
export async function complete(
  system: string,
  userText: string,
  options: CompleteOptions = {},
): Promise<CompleteResult> {
  const {
    provider = getDefaultProvider().id,
    maxTokens = 4096,
    effort,
    serviceTier,
    preferHttp,
    signal,
    tracking,
    promptCacheKey,
  } = options;
  const model = options.model ?? getDefaultModel(provider);
  const effectivePromptCacheKey = promptCacheKey ?? defaultPromptCacheKey(provider, tracking);

  const messages = [{ role: "user" as const, content: userText }];

  log("info", `llm: inner completion (provider=${provider}, model=${model}, effort=${effort ?? "default"}, serviceTier=${serviceTier ?? "default"}, maxTokens=${maxTokens}, input=${userText.length} chars)`);

  const result = await streamMessage(provider, messages, model, {
    onText: noop,
    onThinking: noop,
  }, {
    system,
    maxTokens,
    effort,
    serviceTier,
    preferHttp,
    signal,
    tracking,
    promptCacheKey: effectivePromptCacheKey,
  });

  log("info", `llm: inner completion done (provider=${provider}, in=${result.inputTokens ?? "?"}, out=${result.outputTokens ?? "?"}, text=${result.text.length} chars)`);

  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
}
