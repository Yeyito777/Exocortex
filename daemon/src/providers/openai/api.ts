import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { readExocortexConfig } from "@exocortex/shared/config";
import { getVerifiedSession } from "./auth";
import { AuthError, isNonRetryableProviderError } from "../errors";
import { OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { buildOpenAIRequestHeaders, type OpenAIRequestSession } from "./cache";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "./cookies";
import { encodeOpenAIRequestBody } from "./encoding";
import { buildOpenAIInput, buildRequestBody } from "./request";
import { mergeReasoningSummaries } from "./reasoning";
import { readOpenAIEventsForTest, readOpenAIStream } from "./stream";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";

export {
  AuthError,
  mergeReasoningSummaries as mergeReasoningSummariesForTest,
  readOpenAIEventsForTest,
};

export function isRetriableOpenAIStatusForTest(status: number): boolean {
  return RETRIABLE_STATUS_CODES.has(status);
}

export function parseOpenAIUsageLimitErrorForTest(text: string, nowMs = Date.now()): OpenAIUsageLimitError | null {
  return parseOpenAIUsageLimitError(text, nowMs);
}

export function shouldRetryOpenAIUsageLimitResetForTest(): boolean {
  return shouldRetryOpenAIUsageLimitReset();
}

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;
const USAGE_LIMIT_RESET_BUFFER_MS = 2_000;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507]);

interface OpenAIUsageLimitError {
  message: string;
  planType?: string;
  resetAt?: number;
  resetDelayMs?: number;
}

function isOpenAIAuthFailure(err: unknown): boolean {
  return err instanceof AuthError || (err instanceof Error && err.name === "AuthError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  // OpenAI currently returns seconds; accept milliseconds too for robustness.
  return value > 1_000_000_000_000 ? Math.round(value) : Math.round(value * 1000);
}

function parseDelayMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1000);
}

function parseOpenAIUsageLimitError(text: string, nowMs: number): OpenAIUsageLimitError | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(data) || !isRecord(data.error)) return null;
  const err = data.error;
  if (err.type !== "usage_limit_reached") return null;

  const resetAt = parseEpochMs(err.resets_at);
  const resetDelayFromBodyMs = parseDelayMs(err.resets_in_seconds);
  const resetDelayMs = resetAt != null
    ? Math.max(0, resetAt - nowMs) + USAGE_LIMIT_RESET_BUFFER_MS
    : resetDelayFromBodyMs != null
      ? resetDelayFromBodyMs + USAGE_LIMIT_RESET_BUFFER_MS
      : undefined;

  return {
    message: typeof err.message === "string" ? err.message : "OpenAI usage limit reached",
    ...(typeof err.plan_type === "string" ? { planType: err.plan_type } : {}),
    ...(resetAt != null ? { resetAt } : {}),
    ...(resetDelayMs != null ? { resetDelayMs } : {}),
  };
}

function shouldRetryOpenAIUsageLimitReset(): boolean {
  const config = readExocortexConfig();
  return config.providers?.openai?.retryOnUsageLimitReset === true;
}

function formatResetTime(resetAt?: number): string {
  if (resetAt == null) return "the usage window resets";
  return new Date(resetAt).toLocaleString();
}

function formatUsageLimitMessage(_limit: OpenAIUsageLimitError): string {
  return "OpenAI usage limit reached";
}

function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
  onStart?: () => void,
  onEnd?: () => void,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  onStart?.();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      onEnd?.();
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      onEnd?.();
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  const delaySec = Math.round(delay / 1000);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec, { kind: "transient" });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForUsageLimitReset(
  limit: OpenAIUsageLimitError,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (limit.resetDelayMs == null) {
    throw new Error(`${limit.message}; reset time was not provided by OpenAI`);
  }

  const delaySec = Math.max(0, Math.ceil(limit.resetDelayMs / 1000));
  callbacks.onRetry?.(1, 1, formatUsageLimitMessage(limit), delaySec, {
    kind: "usage_limit_reset",
    ...(limit.resetAt != null ? { resetAt: limit.resetAt } : {}),
  });
  await abortableDelay(limit.resetDelayMs, signal, callbacks.onRetryWaitStart, callbacks.onRetryWaitEnd);
}

export function buildOpenAIInputForTest(messages: ApiMessage[]): unknown[] {
  return buildOpenAIInput(messages);
}

export function buildRequestBodyForTest(
  messages: ApiMessage[],
  model: ModelId,
  _maxTokens: number,
  options: StreamOptions,
): Record<string, unknown> {
  return buildRequestBody(messages, model, options);
}

/**
 * Core OpenAI transport loop once auth has already been resolved.
 *
 * Kept separate from streamMessage() so tests can exercise retry/abort
 * behavior without depending on auth state.
 */
export async function streamMessageWithSession(
  session: OpenAIRequestSession,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  let retryAttempt = 0;
  const requestBody = buildRequestBody(messages, model, options);
  const encodedBody = encodeOpenAIRequestBody(requestBody);

  while (true) {
    let res: Response;
    try {
      const headers = {
        ...buildOpenAIRequestHeaders(session, options),
        ...encodedBody.headers,
      };
      const cookieHeader = buildCloudflareCookieHeader(OPENAI_CODEX_RESPONSES_URL);
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }

      res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers,
        body: encodedBody.body,
        signal,
      });
      storeCloudflareCookiesFromHeaders(OPENAI_CODEX_RESPONSES_URL, res.headers);
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err) || isNonRetryableProviderError(err)) throw err;
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal);
        continue;
      }
      throw err;
    }

    if (res.status === 401) {
      throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
    }

    if (res.status === 429) {
      const text = await res.text();
      const usageLimit = parseOpenAIUsageLimitError(text, Date.now());
      if (usageLimit) {
        if (!shouldRetryOpenAIUsageLimitReset()) {
          const resetHint = usageLimit.resetAt != null ? ` Reset: ${formatResetTime(usageLimit.resetAt)}.` : "";
          throw new Error(`${usageLimit.message}.${resetHint} Enable providers.openai.retryOnUsageLimitReset in config/config.json to keep the stream open until reset.`);
        }
        await waitForUsageLimitReset(usageLimit, callbacks, signal);
        continue;
      }

      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, "HTTP 429", callbacks, signal);
        continue;
      }
      throw new Error(`OpenAI API error (429) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (RETRIABLE_STATUS_CODES.has(res.status)) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks, signal);
        continue;
      }
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readOpenAIStream(res, callbacks, STREAM_STALL_TIMEOUT);
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err) || isNonRetryableProviderError(err)) throw err;
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal);
        continue;
      }
      throw err;
    }
  }
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const session = await getVerifiedSession();
  try {
    return await streamMessageWithSession(session, messages, model, callbacks, options);
  } catch (err) {
    if (!isOpenAIAuthFailure(err)) throw err;

    const refreshed = await getVerifiedSession({ forceRefresh: true }).catch(() => null);
    if (!refreshed) throw err;
    if (refreshed.accessToken === session.accessToken && refreshed.accountId === session.accountId) {
      throw err;
    }

    return streamMessageWithSession(refreshed, messages, model, callbacks, options);
  }
}
