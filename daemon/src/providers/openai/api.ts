import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { log } from "../../log";
import { readExocortexConfig } from "@exocortex/shared/config";
import { getVerifiedSession } from "./auth";
import { AuthError, isNonRetryableProviderError } from "../errors";
import { OPENAI_CODEX_RESPONSES_WS_URL } from "./constants";
import { buildOpenAIRequestHeaders, type OpenAIRequestSession } from "./cache";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "./cookies";
import { buildOpenAIInput, buildRequestBody } from "./request";
import { mergeReasoningSummaries } from "./reasoning";
import { readOpenAIResponsesWebSocket } from "./responses-websocket";
import { readOpenAIEventsForTest } from "./stream";
import { connectOpenAIWebSocket, OpenAIWebSocketHttpError, type OpenAIWebSocketConnection } from "./websocket";
import type { ProviderTurnSession, StreamCallbacks, StreamOptions, StreamResult } from "../types";

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

export function createOpenAITurnSession(): OpenAITurnSession {
  return new OpenAITurnSession();
}

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;
const USAGE_LIMIT_RESET_BUFFER_MS = 2_000;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524]);

interface OpenAIUsageLimitError {
  message: string;
  planType?: string;
  resetAt?: number;
  resetDelayMs?: number;
}

function isOpenAITurnSession(value: ProviderTurnSession | undefined): value is OpenAITurnSession {
  return value instanceof OpenAITurnSession;
}

function cloneWithoutInput(body: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, ...rest } = body;
  return rest;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function inputStartsWith(input: unknown[], prefix: unknown[]): boolean {
  if (input.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!valuesEqual(input[i], prefix[i])) return false;
  }
  return true;
}

function isKnownPreviousResponseOutputItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type === "reasoning" || item.type === "function_call") return true;
  return item.type === "message" && item.role === "assistant";
}

export class OpenAITurnSession implements ProviderTurnSession {
  private socket: OpenAIWebSocketConnection | null = null;
  private turnState: string | null = null;
  private requestSession: OpenAIRequestSession | null = null;
  private lastFullRequestBody: Record<string, unknown> | null = null;
  private lastResponseId: string | null = null;

  async getVerifiedRequestSession(
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<OpenAIRequestSession> {
    if (this.requestSession && !opts.forceRefresh) return this.requestSession;
    this.requestSession = await getVerifiedSessionWithRetries(callbacks, signal, opts);
    return this.requestSession;
  }

  async getSocket(
    session: OpenAIRequestSession,
    callbacks: StreamCallbacks,
    options: StreamOptions,
  ): Promise<OpenAIWebSocketConnection> {
    if (this.socket && !this.socket.isClosed()) return this.socket;

    const headers = {
      ...buildOpenAIRequestHeaders(session, options),
    };
    if (this.turnState) {
      headers["x-codex-turn-state"] = this.turnState;
    }
    const cookieHeader = buildCloudflareCookieHeader(OPENAI_CODEX_RESPONSES_WS_URL);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const connection = await connectOpenAIWebSocket(OPENAI_CODEX_RESPONSES_WS_URL, headers, options.signal);
    this.socket = connection.socket;
    storeCloudflareCookiesFromHeaders(OPENAI_CODEX_RESPONSES_WS_URL, connection.headers);
    callbacks.onHeaders?.(connection.headers);
    const nextTurnState = connection.headers.get("x-codex-turn-state");
    if (nextTurnState && !this.turnState) {
      this.turnState = nextTurnState;
    }
    return this.socket;
  }

  prepareRequestBody(fullRequestBody: Record<string, unknown>): Record<string, unknown> {
    if (!this.lastFullRequestBody || !this.lastResponseId) return fullRequestBody;
    if (!valuesEqual(cloneWithoutInput(this.lastFullRequestBody), cloneWithoutInput(fullRequestBody))) {
      return fullRequestBody;
    }

    const previousInput = this.lastFullRequestBody.input;
    const currentInput = fullRequestBody.input;
    if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) return fullRequestBody;
    if (!inputStartsWith(currentInput, previousInput)) return fullRequestBody;

    let deltaStart = previousInput.length;
    while (deltaStart < currentInput.length && isKnownPreviousResponseOutputItem(currentInput[deltaStart])) {
      deltaStart += 1;
    }
    const incrementalInput = currentInput.slice(deltaStart);
    if (incrementalInput.length === 0) return fullRequestBody;

    return {
      ...fullRequestBody,
      previous_response_id: this.lastResponseId,
      input: incrementalInput,
    };
  }

  recordSuccessfulRequest(fullRequestBody: Record<string, unknown>, result: StreamResult): void {
    const responseId = result.assistantProviderData?.openai?.responseId;
    this.lastFullRequestBody = fullRequestBody;
    this.lastResponseId = responseId || null;
  }

  resetIncrementalState(): void {
    this.lastFullRequestBody = null;
    this.lastResponseId = null;
  }

  resetConnection(): void {
    this.socket?.destroy();
    this.socket = null;
    this.resetIncrementalState();
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  destroy(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

function isOpenAIAuthFailure(err: unknown): boolean {
  return err instanceof AuthError || (err instanceof Error && err.name === "AuthError");
}

function isRetriableOpenAIHttpError(err: OpenAIWebSocketHttpError): boolean {
  // OpenAI/Cloudflare occasionally rejects the Codex websocket handshake with a
  // bare 403 and no response body. That has behaved like a transient edge
  // refusal rather than an authorization error, while descriptive 403 bodies
  // should still fail fast so the user sees the actual policy/auth message.
  return RETRIABLE_STATUS_CODES.has(err.status) || (err.status === 403 && err.body.trim() === "");
}

function formatOpenAIErrorBody(body: string): string {
  return body.trim() === "" ? "<empty body>" : body;
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
  const turnSession = isOpenAITurnSession(options.turnSession) ? options.turnSession : null;
  let retryAttempt = 0;
  let retriedWithoutIncremental = false;
  const fullRequestBody = buildRequestBody(messages, model, options);

  while (true) {
    let socket: OpenAIWebSocketConnection | null = null;
    let attemptedIncremental = false;
    try {
      if (turnSession) {
        socket = await turnSession.getSocket(session, callbacks, options);
      } else {
        const headers = {
          ...buildOpenAIRequestHeaders(session, options),
        };
        const cookieHeader = buildCloudflareCookieHeader(OPENAI_CODEX_RESPONSES_WS_URL);
        if (cookieHeader) {
          headers.Cookie = cookieHeader;
        }

        const connection = await connectOpenAIWebSocket(OPENAI_CODEX_RESPONSES_WS_URL, headers, signal);
        socket = connection.socket;
        storeCloudflareCookiesFromHeaders(OPENAI_CODEX_RESPONSES_WS_URL, connection.headers);
        callbacks.onHeaders?.(connection.headers);
      }

      const requestBody = turnSession?.prepareRequestBody(fullRequestBody) ?? fullRequestBody;
      attemptedIncremental = typeof requestBody.previous_response_id === "string";
      const result = await readOpenAIResponsesWebSocket(socket, requestBody, callbacks, {
        stallTimeoutMs: STREAM_STALL_TIMEOUT,
        signal,
      });
      turnSession?.recordSuccessfulRequest(fullRequestBody, result);
      if (!turnSession) socket.close();
      return result;
    } catch (err) {
      if (turnSession) turnSession.resetConnection();
      else socket?.destroy();
      if (signal?.aborted || isAbortLikeError(err) || isNonRetryableProviderError(err)) throw err;
      if (err instanceof OpenAIWebSocketHttpError) {
        if (turnSession && attemptedIncremental && !retriedWithoutIncremental && (err.status === 400 || err.status === 404)) {
          log("warn", `openai api: incremental websocket request failed with HTTP ${err.status}; retrying once with full replay`);
          retriedWithoutIncremental = true;
          turnSession.resetIncrementalState();
          continue;
        }

        if (err.status === 401) {
          throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
        }

        if (err.status === 429) {
          const usageLimit = parseOpenAIUsageLimitError(err.body, Date.now());
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
          throw new Error(`OpenAI API error (429) after ${MAX_RETRIES} retries: ${err.body.slice(0, 200)}`);
        }

        if (isRetriableOpenAIHttpError(err)) {
          if (retryAttempt < MAX_RETRIES) {
            await retryBackoff(retryAttempt++, `HTTP ${err.status}`, callbacks, signal);
            continue;
          }
          throw new Error(`OpenAI API error (${err.status}) after ${MAX_RETRIES} retries: ${formatOpenAIErrorBody(err.body).slice(0, 200)}`);
        }

        throw new Error(`OpenAI API error (${err.status}): ${formatOpenAIErrorBody(err.body)}`);
      }

      if (retryAttempt < MAX_RETRIES) {
        const message = err instanceof Error ? err.message : String(err);
        log("warn", `openai api: retrying websocket request after ${message} (attempt ${retryAttempt + 1}/${MAX_RETRIES})`);
        await retryBackoff(retryAttempt++, message, callbacks, signal);
        continue;
      }
      throw err;
    }
  }
}

async function getVerifiedSessionWithRetries(
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  opts: { forceRefresh?: boolean } = {},
): Promise<OpenAIRequestSession> {
  let retryAttempt = 0;

  while (true) {
    try {
      return await getVerifiedSession(opts);
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err) || isNonRetryableProviderError(err) || isOpenAIAuthFailure(err)) throw err;
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
  const { signal } = options;
  const turnSession = isOpenAITurnSession(options.turnSession) ? options.turnSession : null;
  const session = turnSession
    ? await turnSession.getVerifiedRequestSession(callbacks, signal)
    : await getVerifiedSessionWithRetries(callbacks, signal);
  try {
    return await streamMessageWithSession(session, messages, model, callbacks, options);
  } catch (err) {
    if (!isOpenAIAuthFailure(err)) throw err;

    const refreshed = await (turnSession
      ? turnSession.getVerifiedRequestSession(callbacks, signal, { forceRefresh: true })
      : getVerifiedSessionWithRetries(callbacks, signal, { forceRefresh: true })).catch(() => null);
    if (!refreshed) throw err;
    if (refreshed.accessToken === session.accessToken && refreshed.accountId === session.accountId) {
      throw err;
    }

    return streamMessageWithSession(refreshed, messages, model, callbacks, options);
  }
}
