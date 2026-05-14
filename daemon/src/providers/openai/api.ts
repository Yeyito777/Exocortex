import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { log } from "../../log";
import { readExocortexConfig } from "@exocortex/shared/config";
import { getCurrentAccountKey, getVerifiedSession } from "./auth";
import { AuthError, isNonRetryableProviderError } from "../errors";
import { OPENAI_CODEX_RESPONSES_WS_URL } from "./constants";
import { buildOpenAIRequestHeaders, type OpenAIRequestSession } from "./cache";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "./cookies";
import { buildOpenAIInput, buildRequestBody } from "./request";
import { mergeReasoningSummaries } from "./reasoning";
import { OpenAIWebSocketClosedBeforeResponseStartedError, readOpenAIResponsesWebSocket } from "./responses-websocket";
import { readOpenAIEventsForTest } from "./stream";
import { connectOpenAIWebSocket, OpenAIWebSocketHttpError, type OpenAIWebSocketConnection } from "./websocket";
import { OPENAI_USAGE_ACCOUNT_KEY_HEADER } from "./usage";
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

export function clearOpenAIWebSocketSessionCacheForTest(): void {
  for (const state of reusableTurnSessions.values()) {
    closeReusableTurnSession(state);
  }
  reusableTurnSessions.clear();
}

export function setOpenAIWebSocketIdleTimeoutMsForTest(timeoutMs: number | null): void {
  websocketIdleTimeoutMsForTest = timeoutMs;
}

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;
const USAGE_LIMIT_RESET_BUFFER_MS = 2_000;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524]);
const WEBSOCKET_IDLE_TIMEOUT_MS = 5 * 60_000;

let websocketIdleTimeoutMsForTest: number | null = null;

interface OpenAITurnSessionState {
  key: string | null;
  socket: OpenAIWebSocketConnection | null;
  turnState: string | null;
  requestSession: OpenAIRequestSession | null;
  lastFullRequestBody: Record<string, unknown> | null;
  lastResponseId: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  inUse: boolean;
}

const reusableTurnSessions = new Map<string, OpenAITurnSessionState>();

function createTurnSessionState(key: string | null = null): OpenAITurnSessionState {
  return {
    key,
    socket: null,
    turnState: null,
    requestSession: null,
    lastFullRequestBody: null,
    lastResponseId: null,
    idleTimer: null,
    inUse: false,
  };
}

function currentWebSocketIdleTimeoutMs(): number {
  return websocketIdleTimeoutMsForTest ?? WEBSOCKET_IDLE_TIMEOUT_MS;
}

function clearReusableTurnSessionTimer(state: OpenAITurnSessionState): void {
  if (!state.idleTimer) return;
  clearTimeout(state.idleTimer);
  state.idleTimer = null;
}

function resetReusableTurnSessionState(state: OpenAITurnSessionState): void {
  state.socket = null;
  state.turnState = null;
  state.requestSession = null;
  state.lastFullRequestBody = null;
  state.lastResponseId = null;
  state.inUse = false;
}

function closeReusableTurnSession(state: OpenAITurnSessionState): void {
  clearReusableTurnSessionTimer(state);
  state.socket?.close();
  resetReusableTurnSessionState(state);
}

function destroyReusableTurnSession(state: OpenAITurnSessionState): void {
  clearReusableTurnSessionTimer(state);
  state.socket?.destroy();
  resetReusableTurnSessionState(state);
}

function sessionsHaveDifferentAccounts(left: OpenAIRequestSession | null, right: OpenAIRequestSession): boolean {
  return left != null && left.accountId !== right.accountId;
}

interface OpenAIUsageLimitError {
  message: string;
  planType?: string;
  resetAt?: number;
  resetDelayMs?: number;
}

interface OpenAIWebSocketLease {
  socket: OpenAIWebSocketConnection;
  reused: boolean;
}

function isOpenAITurnSession(value: ProviderTurnSession | undefined): value is OpenAITurnSession {
  return value instanceof OpenAITurnSession;
}

function callbacksForSession(callbacks: StreamCallbacks, session: OpenAIRequestSession): StreamCallbacks {
  if (!session.accountKey) return callbacks;
  return {
    ...callbacks,
    onHeaders: (headers) => {
      const scopedHeaders = new Headers(headers);
      scopedHeaders.set(OPENAI_USAGE_ACCOUNT_KEY_HEADER, session.accountKey ?? "");
      callbacks.onHeaders?.(scopedHeaders);
    },
  };
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

/**
 * OpenAI websocket state for one Exocortex conversation/session.
 *
 * IMPORTANT: do not close this websocket after an individual OpenAI
 * `response.completed` event when the model asked for tools.  A single
 * Exocortex assistant message can require multiple OpenAI response rounds:
 *
 *   model -> tool calls -> tool results -> model -> ... -> final text
 *
 * Those rounds are one logical Codex websocket conversation. The server-issued
 * `x-codex-turn-state` and incremental `previous_response_id` flow are tied to
 * that conversation, so the same websocket must remain alive until the entire
 * assistant message/response is finished (or the stream errors/aborts). Closing
 * it at per-round `response.completed` breaks that contract and can cause the
 * follow-up tool-result request to be sent on the wrong transport/session.
 *
 * Lifecycle:
 * - `getSocketLease()` opens once and then reuses the socket across tool rounds
 *   and follow-up user messages in the same conversation.
 * - `recordSuccessfulRequest()` records incremental replay state only; it must
 *   not close the socket.
 * - `close()` is called by the orchestrator after the full assistant message
 *   completes successfully. With a conversation prompt-cache key it parks the
 *   websocket in an idle cache for a short grace window instead of closing it
 *   immediately, so a new user message can land on the same Codex session.
 * - `destroy()`/`resetConnection()` are for errors, aborts, or retries.
 */
export class OpenAITurnSession implements ProviderTurnSession {
  private state = createTurnSessionState();

  private adoptReusableState(options: StreamOptions): OpenAIRequestSession | null {
    const key = typeof options.promptCacheKey === "string" && options.promptCacheKey.length > 0
      ? options.promptCacheKey
      : null;
    if (!key) return this.state.requestSession;

    if (this.state.key === key) {
      clearReusableTurnSessionTimer(this.state);
      if (!reusableTurnSessions.has(key)) reusableTurnSessions.set(key, this.state);
      this.state.inUse = true;
      return this.state.requestSession;
    }

    let reusable = reusableTurnSessions.get(key);
    if (!reusable) {
      reusable = createTurnSessionState(key);
      reusableTurnSessions.set(key, reusable);
    }

    const previousReusableRequestSession = reusable.requestSession;
    clearReusableTurnSessionTimer(reusable);
    reusable.inUse = true;
    this.state = reusable;
    return previousReusableRequestSession;
  }

  private resetIncrementalStateFields(): void {
    this.state.lastFullRequestBody = null;
    this.state.lastResponseId = null;
  }

  private removeReusableStateFromCache(): void {
    if (this.state.key && reusableTurnSessions.get(this.state.key) === this.state) {
      reusableTurnSessions.delete(this.state.key);
    }
  }

  async getVerifiedRequestSession(
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<OpenAIRequestSession> {
    const currentAccountKey = getCurrentAccountKey();
    if (this.state.requestSession && !opts.forceRefresh) {
      if (!currentAccountKey || this.state.requestSession.accountKey === currentAccountKey) {
        return this.state.requestSession;
      }

      log("info", "openai api: selected account changed; resetting cached OpenAI turn session");
      this.state.socket?.destroy();
      resetReusableTurnSessionState(this.state);
      this.state.inUse = true;
      this.resetIncrementalStateFields();
    }
    this.state.requestSession = await getVerifiedSessionWithRetries(callbacks, signal, opts);
    return this.state.requestSession;
  }

  async getSocketLease(
    session: OpenAIRequestSession,
    callbacks: StreamCallbacks,
    options: StreamOptions,
  ): Promise<OpenAIWebSocketLease> {
    const previousRequestSession = this.adoptReusableState(options);
    if (sessionsHaveDifferentAccounts(previousRequestSession, session)) {
      this.state.socket?.destroy();
      resetReusableTurnSessionState(this.state);
      this.state.inUse = true;
      this.resetIncrementalStateFields();
    }
    this.state.requestSession = session;

    if (this.state.socket && !this.state.socket.isClosed()) {
      return { socket: this.state.socket, reused: true };
    }
    if (this.state.socket?.isClosed()) {
      // Match Codex's turn-session behavior: if the physical websocket died
      // between provider rounds, reconnect with the same turn-state header but
      // do not keep using `previous_response_id` on the fresh connection. The
      // safe fallback is a full replay on the new socket.
      this.state.socket.destroy();
      this.state.socket = null;
      this.resetIncrementalState();
    }

    const headers = {
      ...buildOpenAIRequestHeaders(session, options),
    };
    if (this.state.turnState) {
      headers["x-codex-turn-state"] = this.state.turnState;
    }
    const cookieHeader = buildCloudflareCookieHeader(OPENAI_CODEX_RESPONSES_WS_URL);
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const connection = await connectOpenAIWebSocket(OPENAI_CODEX_RESPONSES_WS_URL, headers, options.signal);
    this.state.socket = connection.socket;
    storeCloudflareCookiesFromHeaders(OPENAI_CODEX_RESPONSES_WS_URL, connection.headers);
    callbacks.onHeaders?.(connection.headers);
    const nextTurnState = connection.headers.get("x-codex-turn-state");
    if (nextTurnState && !this.state.turnState) {
      this.state.turnState = nextTurnState;
    }
    return { socket: this.state.socket, reused: false };
  }

  prepareRequestBody(fullRequestBody: Record<string, unknown>): Record<string, unknown> {
    if (!this.state.lastFullRequestBody || !this.state.lastResponseId) return fullRequestBody;
    if (!valuesEqual(cloneWithoutInput(this.state.lastFullRequestBody), cloneWithoutInput(fullRequestBody))) {
      return fullRequestBody;
    }

    const previousInput = this.state.lastFullRequestBody.input;
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
      previous_response_id: this.state.lastResponseId,
      input: incrementalInput,
    };
  }

  recordSuccessfulRequest(fullRequestBody: Record<string, unknown>, result: StreamResult): void {
    const responseId = result.assistantProviderData?.openai?.responseId;
    this.state.lastFullRequestBody = fullRequestBody;
    this.state.lastResponseId = responseId || null;
    // Deliberately DO NOT close the socket here. `response.completed` marks
    // the end of one provider round, not necessarily the end of the user's
    // assistant message: if tools were requested, the next round must reuse this
    // websocket and send the tool-result delta on the same Codex turn session.
  }

  resetIncrementalState(): void {
    this.resetIncrementalStateFields();
  }

  resetConnection(): void {
    clearReusableTurnSessionTimer(this.state);
    this.state.socket?.destroy();
    this.state.socket = null;
    this.resetIncrementalState();
  }

  close(): void {
    clearReusableTurnSessionTimer(this.state);
    this.state.inUse = false;

    if (!this.state.key) {
      this.state.socket?.close();
      this.state.socket = null;
      return;
    }

    if (!this.state.socket || this.state.socket.isClosed()) {
      this.removeReusableStateFromCache();
      resetReusableTurnSessionState(this.state);
      return;
    }

    reusableTurnSessions.set(this.state.key, this.state);
    const timeoutMs = currentWebSocketIdleTimeoutMs();
    if (timeoutMs <= 0) {
      this.removeReusableStateFromCache();
      closeReusableTurnSession(this.state);
      return;
    }

    const state = this.state;
    const timer = setTimeout(() => {
      state.idleTimer = null;
      if (state.inUse) return;
      if (state.key && reusableTurnSessions.get(state.key) === state) {
        reusableTurnSessions.delete(state.key);
      }
      state.socket?.close();
      resetReusableTurnSessionState(state);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    state.idleTimer = timer;
  }

  destroy(): void {
    this.removeReusableStateFromCache();
    destroyReusableTurnSession(this.state);
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
  opts: { notify?: boolean; delayMs?: number } = {},
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const delay = opts.delayMs ?? (Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000);
  const delaySec = Math.round(delay / 1000);
  if (opts.notify !== false) {
    callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec, { kind: "transient" });
  }

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
  const requestCallbacks = callbacksForSession(callbacks, session);
  let retryAttempt = 0;
  let silentStaleReconnects = 0;
  let retriedWithoutIncremental = false;
  const fullRequestBody = buildRequestBody(messages, model, options);

  while (true) {
    let socket: OpenAIWebSocketConnection | null = null;
    let connectionReused = false;
    let attemptedIncremental = false;
    try {
      if (turnSession) {
        const lease = await turnSession.getSocketLease(session, requestCallbacks, options);
        socket = lease.socket;
        connectionReused = lease.reused;
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
        requestCallbacks.onHeaders?.(connection.headers);
      }

      const requestBody = turnSession?.prepareRequestBody(fullRequestBody) ?? fullRequestBody;
      attemptedIncremental = typeof requestBody.previous_response_id === "string";
      const result = await readOpenAIResponsesWebSocket(socket, requestBody, requestCallbacks, {
        stallTimeoutMs: STREAM_STALL_TIMEOUT,
        connectionReused,
        signal,
      });
      turnSession?.recordSuccessfulRequest(fullRequestBody, result);
      // Non-turn-session calls own exactly one websocket/request and can close
      // immediately. Turn-session calls are different: the websocket is owned by
      // OpenAITurnSession and must survive across tool-result follow-up rounds
      // until the orchestrator closes the full assistant message session.
      if (!turnSession) socket.close();
      return result;
    } catch (err) {
      if (turnSession) turnSession.resetConnection();
      else socket?.destroy();
      if (signal?.aborted || isAbortLikeError(err) || isNonRetryableProviderError(err)) throw err;
      if (turnSession && connectionReused && err instanceof OpenAIWebSocketClosedBeforeResponseStartedError) {
        if (retryAttempt < MAX_RETRIES) {
          const close = err.code != null ? `code=${err.code}` : "raw close";
          const reason = err.reason ? `, reason=${err.reason}` : "";
          const message = `stale reused OpenAI websocket closed before response started (${close}${reason})`;
          const notify = silentStaleReconnects > 0;
          log(notify ? "warn" : "info", `openai api: ${message}; reconnecting${notify ? ` (attempt ${retryAttempt + 1}/${MAX_RETRIES})` : " silently"}`);
          silentStaleReconnects += 1;
          // A stale close before response.created means this provider round did
          // not start. Reconnect quickly and full-replay on the new socket; only
          // surface UI retry markers if the supposedly one-off stale reconnect
          // repeats.
            await retryBackoff(retryAttempt++, message, requestCallbacks, signal, {
            notify,
            delayMs: notify ? undefined : 250 + Math.random() * 250,
          });
          continue;
        }
        throw err;
      }
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
            await waitForUsageLimitReset(usageLimit, requestCallbacks, signal);
            continue;
          }

          if (retryAttempt < MAX_RETRIES) {
            await retryBackoff(retryAttempt++, "HTTP 429", requestCallbacks, signal);
            continue;
          }
          throw new Error(`OpenAI API error (429) after ${MAX_RETRIES} retries: ${err.body.slice(0, 200)}`);
        }

        if (isRetriableOpenAIHttpError(err)) {
          if (retryAttempt < MAX_RETRIES) {
            await retryBackoff(retryAttempt++, `HTTP ${err.status}`, requestCallbacks, signal);
            continue;
          }
          throw new Error(`OpenAI API error (${err.status}) after ${MAX_RETRIES} retries: ${formatOpenAIErrorBody(err.body).slice(0, 200)}`);
        }

        throw new Error(`OpenAI API error (${err.status}): ${formatOpenAIErrorBody(err.body)}`);
      }

      if (retryAttempt < MAX_RETRIES) {
        const message = err instanceof Error ? err.message : String(err);
        log("warn", `openai api: retrying websocket request after ${message} (attempt ${retryAttempt + 1}/${MAX_RETRIES})`);
        await retryBackoff(retryAttempt++, message, requestCallbacks, signal);
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
