import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { log } from "../../log";
import { readExocortexConfig } from "@exocortex/shared/config";
import { createHash } from "crypto";
import { accountScopeForKey, getCurrentAccountKey, getVerifiedSession } from "./auth";
import { AuthError, isNonRetryableProviderError, NonRetryableProviderError } from "../errors";
import { OPENAI_CODEX_RESPONSES_URL, OPENAI_CODEX_RESPONSES_WS_URL } from "./constants";
import { buildOpenAIRequestHeaders, type OpenAIRequestSession } from "./cache";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "./cookies";
import { buildOpenAIInput, buildRequestBody } from "./request";
import { mergeReasoningSummaries } from "./reasoning";
import { OpenAIWebSocketClosedBeforeResponseStartedError, readOpenAIResponsesWebSocket } from "./responses-websocket";
import { createOpenAIEventAccumulator, readOpenAIEventsForTest } from "./stream";
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

export async function prewarmOpenAIConversation(promptCacheKey: string): Promise<void> {
  const turnSession = new OpenAITurnSession();
  const callbacks: StreamCallbacks = {
    onText: () => {},
    onThinking: () => {},
  };
  try {
    const session = await turnSession.getVerifiedRequestSession(callbacks);
    await turnSession.getSocketLease(session, callbacks, { promptCacheKey });
    turnSession.close();
  } catch (err) {
    turnSession.destroy();
    throw err;
  }
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

// Match Codex's default stream idle timeout. The app-level stale watchdog must
// stay longer than this so provider retries get a chance to fire before the
// whole Exocortex conversation is aborted.
const STREAM_STALL_TIMEOUT = 300_000;
const MAX_RETRIES = 8;
const USAGE_LIMIT_RESET_BUFFER_MS = 2_000;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507, 520, 521, 522, 523, 524]);
const WEBSOCKET_IDLE_TIMEOUT_MS = 5 * 60_000;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE = "Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.";

class OpenAIWebSocketRetriesExhaustedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "OpenAIWebSocketRetriesExhaustedError";
    this.cause = cause;
  }
}

class OpenAICompactionRequestBudgetExhaustedError extends NonRetryableProviderError {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : cause == null ? "" : String(cause);
    super(`OpenAI native compaction exhausted its shared request budget${detail ? `: ${detail}` : ""}`);
  }
}

function compactionRequestBudget(options: StreamOptions) {
  return options.compaction ? options.requestBudget : undefined;
}

function hasCompactionRequestRemaining(options: StreamOptions): boolean {
  const budget = compactionRequestBudget(options);
  return !budget || budget.attempts < budget.maxAttempts;
}

function consumeCompactionRequestAttempt(options: StreamOptions): void {
  const budget = compactionRequestBudget(options);
  if (!budget) return;
  if (!Number.isSafeInteger(budget.maxAttempts) || budget.maxAttempts < 1
      || !Number.isSafeInteger(budget.attempts) || budget.attempts < 0) {
    throw new NonRetryableProviderError("Invalid OpenAI compaction request budget");
  }
  if (budget.attempts >= budget.maxAttempts) {
    throw new OpenAICompactionRequestBudgetExhaustedError();
  }
  budget.attempts += 1;
}

function retryDisplay(
  options: StreamOptions,
  fallbackAttempt: number,
  fallbackMaxAttempts: number,
): { attempt: number; maxAttempts: number } {
  const budget = compactionRequestBudget(options);
  if (!budget) return { attempt: fallbackAttempt, maxAttempts: fallbackMaxAttempts };
  return {
    // The initial request is not a retry. After N requests have been consumed,
    // the next submission is retry N of maxAttempts-1.
    attempt: Math.max(1, budget.attempts),
    maxAttempts: Math.max(0, budget.maxAttempts - 1),
  };
}

let websocketIdleTimeoutMsForTest: number | null = null;

function stampReplayScope(result: StreamResult, model: ModelId, session: OpenAIRequestSession): void {
  // Verified production sessions always carry an accountKey. Tests and custom
  // seams may omit it; do not invent a misleading persisted scope for those.
  const accountScope = accountScopeForKey(session.accountKey);
  if (!accountScope || !result.assistantProviderData?.openai) return;
  result.assistantProviderData.openai.replayScope = { model, accountScope };
}

function assertReplayScopeForSession(
  messages: ApiMessage[],
  model: ModelId,
  session: OpenAIRequestSession,
  expectedAccountScope?: string,
): void {
  const actualAccountScope = accountScopeForKey(session.accountKey) ?? undefined;
  const hasLegacyUnscopedReplay = messages.some((message) => {
    const openai = message.providerData?.openai;
    const hasEncryptedReplay = (openai?.compactionItems?.length ?? 0) > 0
      || (openai?.reasoningItems?.length ?? 0) > 0;
    return hasEncryptedReplay && !openai?.replayScope;
  });
  if (hasLegacyUnscopedReplay
      && expectedAccountScope !== undefined
      && actualAccountScope !== expectedAccountScope) {
    throw new NonRetryableProviderError(
      "OpenAI account changed while preparing this turn; retry the turn with the newly selected account.",
    );
  }
  for (const message of messages) {
    const openai = message.providerData?.openai;
    const hasEncryptedReplay = (openai?.compactionItems?.length ?? 0) > 0
      || (openai?.reasoningItems?.length ?? 0) > 0;
    if (!hasEncryptedReplay || !openai?.replayScope) continue;
    if (openai.replayScope.model !== model || openai.replayScope.accountScope !== actualAccountScope) {
      throw new NonRetryableProviderError(
        "Refusing to replay OpenAI encrypted state under a different model or account scope.",
      );
    }
  }
}

interface OpenAITurnSessionState {
  key: string | null;
  socket: OpenAIWebSocketConnection | null;
  turnState: string | null;
  requestSession: OpenAIRequestSession | null;
  lastFullRequestBody: Record<string, unknown> | null;
  lastResponseId: string | null;
  lastResponseOutputItems: unknown[] | null;
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
    lastResponseOutputItems: null,
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
  state.lastResponseOutputItems = null;
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

function shapeForIncrementalComparison(body: Record<string, unknown>): Record<string, unknown> {
  const shape = cloneWithoutInput(body);
  if (!isRecord(shape.client_metadata)) return shape;
  // Turn identity intentionally changes between logical assistant turns while a
  // parked conversation websocket/previous-response baseline remains reusable.
  const {
    "x-codex-turn-metadata": _turnMetadata,
    turn_id: _turnId,
    ...stableMetadata
  } = shape.client_metadata;
  return { ...shape, client_metadata: stableMetadata };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
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
  if (item.type === "reasoning" || item.type === "function_call" || item.type === "compaction") return true;
  return item.type === "message" && item.role === "assistant";
}

interface ServerSentEvent {
  event?: string;
  data: string;
}

function parseServerSentEvents(buffer: string): { events: ServerSentEvent[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? "";
  const events: ServerSentEvent[] = [];

  for (const part of parts) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }

  return { events, rest };
}

async function readOpenAIResponsesHttpSse(
  res: Response,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const body = res.body;
  if (!body) throw new Error("OpenAI HTTP response had no body");

  const accumulator = createOpenAIEventAccumulator(callbacks);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) throw createAbortError();
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseServerSentEvents(buffer);
    buffer = parsed.rest;

    for (const event of parsed.events) {
      if (event.data === "[DONE]") return accumulator.finalize();
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      accumulator.handle(payload);
      if (payload.type === "response.completed" || payload.type === "response.incomplete") {
        return accumulator.finalize();
      }
    }
  }

  throw new Error("OpenAI HTTP stream ended before response.completed");
}

async function streamMessageHttpWithSession(
  session: OpenAIRequestSession,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  assertReplayScopeForSession(messages, model, session, options.accountScope);
  const requestCallbacks = callbacksForSession(callbacks, session);
  const requestBody = buildRequestBody(messages, model, options);
  const headers: Record<string, string> = {
    ...buildOpenAIRequestHeaders(session, options),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  // The Codex HTTP endpoint streams Server-Sent Events. The websocket beta
  // header switches the backend into websocket mode and can make HTTP fail.
  delete headers["OpenAI-Beta"];
  const cookieHeader = buildCloudflareCookieHeader(OPENAI_CODEX_RESPONSES_URL);
  if (cookieHeader) headers.Cookie = cookieHeader;

  consumeCompactionRequestAttempt(options);
  const res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: options.signal,
  });

  storeCloudflareCookiesFromHeaders(OPENAI_CODEX_RESPONSES_URL, res.headers);
  requestCallbacks.onHeaders?.(res.headers);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
    throw new OpenAIWebSocketHttpError(res.status, res.headers, body);
  }

  const result = await readOpenAIResponsesHttpSse(res, requestCallbacks, options.signal);
  stampReplayScope(result, model, session);
  const input = Array.isArray(requestBody.input) ? requestBody.input : [];
  result.requestDiagnostics = {
    usedIncremental: false,
    previousResponseIdUsed: false,
    incrementalInputItems: input.length,
    fullInputItems: input.length,
    connectionReused: false,
    fallbackReason: "http_sse",
    requestShapeHash: hashValue(cloneWithoutInput(requestBody)),
    inputPrefixHash: hashValue(input.slice(0, Math.min(input.length, 8))),
  };
  return result;
}

export async function streamMessageHttpWithSessionForTest(
  session: OpenAIRequestSession,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  return streamMessageHttpWithSession(session, messages, model, callbacks, options);
}

/**
 * OpenAI websocket state for one Exocortex assistant turn, optionally backed by
 * a cached physical websocket for the surrounding conversation.
 *
 * IMPORTANT: do not close this websocket after an individual OpenAI
 * `response.completed` event when the model asked for tools.  A single
 * Exocortex assistant message can require multiple OpenAI response rounds:
 *
 *   model -> tool calls -> tool results -> model -> ... -> final text
 *
 * Those rounds are one logical Codex turn. The server-issued
 * `x-codex-turn-state` is scoped to that turn, while the physical websocket and
 * `previous_response_id` compression can survive into the next user turn.  Keep
 * the turn-state for tool follow-ups/retries inside this assistant message, but
 * clear it before parking the websocket for the next logical turn. Replaying a
 * previous turn's sticky-routing token into a new turn violates the Codex
 * client/server contract and can route future requests onto a wedged backend.
 *
 * Lifecycle:
 * - `getSocketLease()` opens once and then reuses the socket across tool rounds;
 *   after `close()` the socket may be parked and reused by a later user turn
 *   without carrying over the previous turn-state.
 * - `recordSuccessfulRequest()` records incremental replay state only; it must
 *   not close the socket.
 * - `close()` is called by the orchestrator after the full assistant message
 *   completes successfully. With a conversation prompt-cache key it parks the
 *   websocket in an idle cache for a short grace window instead of closing it
 *   immediately, so a new user message can reuse the connection/response-id
 *   compression while starting with fresh turn-state.
 * - `destroy()`/`resetConnection()` are for errors, aborts, or retries.
 */
export class OpenAITurnSession implements ProviderTurnSession {
  private state = createTurnSessionState();
  private lastPrepareDiagnostics: StreamResult["requestDiagnostics"] | null = null;

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
    if (reusable?.inUse) {
      // A prewarm can still be connecting when the user submits. Do not let a
      // real turn and an in-flight prewarm share mutable websocket/request state.
      // Detach the prewarm from the idle cache so its eventual close cannot
      // overwrite the real turn's parked session.
      reusable.key = null;
      reusable = createTurnSessionState(key);
      reusableTurnSessions.set(key, reusable);
    }
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
    this.state.lastResponseOutputItems = null;
  }

  private requestBodyWithTurnState(body: Record<string, unknown>): Record<string, unknown> {
    const turnState = this.state.turnState;
    if (!turnState) return body;
    const existingMetadata = isRecord(body.client_metadata) ? body.client_metadata : {};
    return {
      ...body,
      client_metadata: {
        ...existingMetadata,
        "x-codex-turn-state": turnState,
      },
    };
  }

  recordTurnState(turnState: string): void {
    // Match Codex's OnceLock behavior: the first value in a logical turn wins,
    // and later metadata events cannot silently reroute the same turn.
    if (!this.state.turnState) this.state.turnState = turnState;
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
    const fullInput = Array.isArray(fullRequestBody.input) ? fullRequestBody.input : [];
    const fullInputItems = fullInput.length;
    const baseDiagnostics = {
      fullInputItems,
      requestShapeHash: hashValue(cloneWithoutInput(fullRequestBody)),
      inputPrefixHash: hashValue(fullInput.slice(0, Math.min(fullInput.length, 8))),
    };

    const fullReplay = (fallbackReason: string | null): Record<string, unknown> => {
      this.lastPrepareDiagnostics = {
        ...baseDiagnostics,
        usedIncremental: false,
        previousResponseIdUsed: false,
        incrementalInputItems: fullInputItems,
        fallbackReason,
      };
      return this.requestBodyWithTurnState(fullRequestBody);
    };

    if (!this.state.lastFullRequestBody || !this.state.lastResponseId) return fullReplay("no_previous_response");
    if (!valuesEqual(
      shapeForIncrementalComparison(this.state.lastFullRequestBody),
      shapeForIncrementalComparison(fullRequestBody),
    )) {
      return fullReplay("non_input_mismatch");
    }

    const previousInput = this.state.lastFullRequestBody.input;
    const currentInput = fullRequestBody.input;
    if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) return fullReplay("input_not_array");
    const previousResponseOutputItems = this.state.lastResponseOutputItems;
    let deltaStart: number;
    if (previousResponseOutputItems) {
      const baseline = [...previousInput, ...previousResponseOutputItems];
      if (!inputStartsWith(currentInput, baseline)) return fullReplay("previous_output_baseline_mismatch");
      deltaStart = baseline.length;
    } else {
      if (!inputStartsWith(currentInput, previousInput)) return fullReplay("previous_input_mismatch");
      deltaStart = previousInput.length;
      while (deltaStart < currentInput.length && isKnownPreviousResponseOutputItem(currentInput[deltaStart])) {
        deltaStart += 1;
      }
    }
    const incrementalInput = currentInput.slice(deltaStart);
    if (incrementalInput.length === 0) return fullReplay("empty_incremental_input");

    this.lastPrepareDiagnostics = {
      ...baseDiagnostics,
      usedIncremental: true,
      previousResponseIdUsed: true,
      incrementalInputItems: incrementalInput.length,
      fallbackReason: null,
    };

    return {
      ...this.requestBodyWithTurnState(fullRequestBody),
      previous_response_id: this.state.lastResponseId,
      input: incrementalInput,
    };
  }

  recordSuccessfulRequest(fullRequestBody: Record<string, unknown>, result: StreamResult): void {
    const responseId = result.assistantProviderData?.openai?.responseId;
    this.state.lastFullRequestBody = fullRequestBody;
    this.state.lastResponseId = responseId || null;
    this.state.lastResponseOutputItems = result.responseOutputItems ?? null;
    if (this.lastPrepareDiagnostics) result.requestDiagnostics = this.lastPrepareDiagnostics;
    // Deliberately DO NOT close the socket here. `response.completed` marks
    // the end of one provider round, not necessarily the end of the user's
    // assistant message: if tools were requested, the next round must reuse this
    // websocket and send the tool-result delta on the same Codex turn session.
  }

  resetIncrementalState(): void {
    this.resetIncrementalStateFields();
    this.lastPrepareDiagnostics = null;
  }

  resetConnection(): void {
    clearReusableTurnSessionTimer(this.state);
    this.state.socket?.destroy();
    this.state.socket = null;
    this.resetIncrementalState();
  }

  resetAfterCompaction(): void {
    // Replacement history can never extend the previous response baseline.
    // Reconnect so request headers and body metadata agree on the new window.
    this.resetConnection();
  }

  close(): void {
    clearReusableTurnSessionTimer(this.state);
    this.state.inUse = false;
    // The Codex sticky-routing token is per logical turn. Preserve the parked
    // websocket and previous-response compression state, but never leak this
    // turn's routing token into the next user turn.
    this.state.turnState = null;

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

function parseOpenAIWebSocketConnectionLimitError(text: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(data) || !isRecord(data.error)) return null;
  const err = data.error;
  if (err.code !== WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE) return null;
  return typeof err.message === "string" && err.message.length > 0
    ? err.message
    : WEBSOCKET_CONNECTION_LIMIT_REACHED_MESSAGE;
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
  opts: { notify?: boolean; delayMs?: number; maxAttempts?: number; displayAttempt?: number } = {},
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const delay = opts.delayMs ?? (Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000);
  const delaySec = Math.round(delay / 1000);
  if (opts.notify !== false) {
    callbacks.onRetry?.(
      opts.displayAttempt ?? attempt + 1,
      opts.maxAttempts ?? MAX_RETRIES,
      errMsg,
      delaySec,
      { kind: "transient" },
    );
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
  retry?: { attempt: number; maxAttempts: number },
): Promise<void> {
  if (limit.resetDelayMs == null) {
    throw new Error(`${limit.message}; reset time was not provided by OpenAI`);
  }

  const delaySec = Math.max(0, Math.ceil(limit.resetDelayMs / 1000));
  callbacks.onRetry?.(retry?.attempt ?? 1, retry?.maxAttempts ?? 1, formatUsageLimitMessage(limit), delaySec, {
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
  assertReplayScopeForSession(messages, model, session, options.accountScope);
  const turnSession = isOpenAITurnSession(options.turnSession) ? options.turnSession : null;
  const requestCallbacks = callbacksForSession(callbacks, session);
  let retryAttempt = 0;
  let silentStaleReconnects = 0;
  let retriedWithoutIncremental = false;
  const maxRetries = options.compaction ? Math.min(MAX_RETRIES, 2) : MAX_RETRIES;
  // Native compaction uses at most two WebSocket retries before switching to
  // HTTPS, but every transport draws from the operation-wide shared budget.
  const retryDisplayMaxAttempts = options.compaction ? maxRetries + 1 : maxRetries;
  const fullRequestBody = buildRequestBody(messages, model, options);
  const canRetryTransport = () => retryAttempt < maxRetries
    && hasCompactionRequestRemaining(options);
  const retryTransport = async (
    message: string,
    retryOptions: { notify?: boolean; delayMs?: number } = {},
  ): Promise<void> => {
    const display = retryDisplay(options, retryAttempt + 1, retryDisplayMaxAttempts);
    await retryBackoff(retryAttempt++, message, requestCallbacks, signal, {
      ...retryOptions,
      displayAttempt: display.attempt,
      maxAttempts: display.maxAttempts,
    });
  };

  while (true) {
    let socket: OpenAIWebSocketConnection | null = null;
    let connectionReused = false;
    let attemptedIncremental = false;
    try {
      consumeCompactionRequestAttempt(options);
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
        onTurnState: turnSession ? (turnState) => turnSession.recordTurnState(turnState) : undefined,
      });
      stampReplayScope(result, model, session);
      if (turnSession) {
        turnSession.recordSuccessfulRequest(fullRequestBody, result);
      } else {
        const input = Array.isArray(requestBody.input) ? requestBody.input : [];
        result.requestDiagnostics = {
          usedIncremental: false,
          previousResponseIdUsed: false,
          incrementalInputItems: input.length,
          fullInputItems: input.length,
          connectionReused,
          fallbackReason: null,
          requestShapeHash: hashValue(cloneWithoutInput(requestBody)),
          inputPrefixHash: hashValue(input.slice(0, Math.min(input.length, 8))),
        };
      }
      if (result.requestDiagnostics) result.requestDiagnostics.connectionReused = connectionReused;
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
        if (canRetryTransport()) {
          const close = err.code != null ? `code=${err.code}` : "raw close";
          const reason = err.reason ? `, reason=${err.reason}` : "";
          const message = `stale reused OpenAI websocket closed before response started (${close}${reason})`;
          const notify = options.compaction || silentStaleReconnects > 0;
          log(notify ? "warn" : "info", `openai api: ${message}; reconnecting${notify ? ` (attempt ${retryAttempt + 1}/${maxRetries})` : " silently"}`);
          silentStaleReconnects += 1;
          // A stale close before response.created means this provider round did
          // not start. Reconnect quickly and full-replay on the new socket; only
          // surface UI retry markers if the supposedly one-off stale reconnect
          // repeats.
          await retryTransport(message, {
            notify,
            delayMs: notify ? undefined : 250 + Math.random() * 250,
          });
          continue;
        }
        throw options.compaction ? new OpenAIWebSocketRetriesExhaustedError(err) : err;
      }
      if (err instanceof OpenAIWebSocketHttpError) {
        const connectionLimitMessage = parseOpenAIWebSocketConnectionLimitError(err.body);
        if (connectionLimitMessage) {
          if (canRetryTransport()) {
            log("warn", `openai api: websocket connection limit reached; reconnecting (attempt ${retryAttempt + 1}/${maxRetries})`);
            await retryTransport(connectionLimitMessage);
            continue;
          }
          const exhausted = new Error(`${connectionLimitMessage} after ${maxRetries} retries`);
          throw options.compaction ? new OpenAIWebSocketRetriesExhaustedError(exhausted) : exhausted;
        }

        if (turnSession && attemptedIncremental && !retriedWithoutIncremental && (err.status === 400 || err.status === 404)) {
          if (!hasCompactionRequestRemaining(options)) {
            throw new OpenAICompactionRequestBudgetExhaustedError(err);
          }
          log("warn", `openai api: incremental websocket request failed with HTTP ${err.status}; retrying once with full replay`);
          if (options.compaction) {
            const display = retryDisplay(options, 1, 1);
            requestCallbacks.onRetry?.(
              display.attempt,
              display.maxAttempts,
              `OpenAI compaction incremental request failed with HTTP ${err.status}; switching to full replay`,
              0,
              { kind: "transient" },
            );
          }
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
            if (!hasCompactionRequestRemaining(options)) {
              throw new OpenAICompactionRequestBudgetExhaustedError(err);
            }
            const display = retryDisplay(options, 1, 1);
            await waitForUsageLimitReset(usageLimit, requestCallbacks, signal, display);
            continue;
          }

          if (canRetryTransport()) {
            await retryTransport("HTTP 429");
            continue;
          }
          const exhausted = new Error(`OpenAI API error (429) after ${maxRetries} retries: ${err.body.slice(0, 200)}`);
          throw options.compaction ? new OpenAIWebSocketRetriesExhaustedError(exhausted) : exhausted;
        }

        if (isRetriableOpenAIHttpError(err)) {
          if (canRetryTransport()) {
            await retryTransport(`HTTP ${err.status}`);
            continue;
          }
          const exhausted = new Error(`OpenAI API error (${err.status}) after ${maxRetries} retries: ${formatOpenAIErrorBody(err.body).slice(0, 200)}`);
          throw options.compaction ? new OpenAIWebSocketRetriesExhaustedError(exhausted) : exhausted;
        }

        throw new Error(`OpenAI API error (${err.status}): ${formatOpenAIErrorBody(err.body)}`);
      }

      if (canRetryTransport()) {
        const message = err instanceof Error ? err.message : String(err);
        log("warn", `openai api: retrying websocket request after ${message} (attempt ${retryAttempt + 1}/${maxRetries})`);
        await retryTransport(message);
        continue;
      }
      throw options.compaction ? new OpenAIWebSocketRetriesExhaustedError(err) : err;
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
  let useHttpFallback = options.preferHttp && !turnSession && (!options.tools || options.tools.length === 0);
  const sendWithSession = async (requestSession: OpenAIRequestSession): Promise<StreamResult> => {
    if (useHttpFallback) {
      return streamMessageHttpWithSession(requestSession, messages, model, callbacks, {
        ...options,
        turnSession: undefined,
        preferHttp: true,
      });
    }
    try {
      return await streamMessageWithSession(requestSession, messages, model, callbacks, options);
    } catch (error) {
      if (!options.compaction || !(error instanceof OpenAIWebSocketRetriesExhaustedError)) throw error;
      if (!hasCompactionRequestRemaining(options)) {
        throw new OpenAICompactionRequestBudgetExhaustedError(error);
      }
      useHttpFallback = true;
      await turnSession?.resetAfterCompaction?.();
      log("warn", "openai api: websocket retries exhausted for remote compaction; retrying over HTTPS");
      const display = retryDisplay(options, 3, 3);
      callbacks.onRetry?.(
        display.attempt,
        display.maxAttempts,
        "OpenAI compaction WebSocket retries exhausted; switching to HTTPS",
        0,
        { kind: "transient" },
      );
      return streamMessageHttpWithSession(requestSession, messages, model, callbacks, {
        ...options,
        turnSession: undefined,
        preferHttp: true,
      });
    }
  };
  try {
    return await sendWithSession(session);
  } catch (err) {
    if (!isOpenAIAuthFailure(err)) throw err;
    if (!hasCompactionRequestRemaining(options)) {
      throw new OpenAICompactionRequestBudgetExhaustedError(err);
    }

    const refreshed = await (turnSession
      ? turnSession.getVerifiedRequestSession(callbacks, signal, { forceRefresh: true })
      : getVerifiedSessionWithRetries(callbacks, signal, { forceRefresh: true })).catch(() => null);
    if (!refreshed) throw err;
    if (refreshed.accessToken === session.accessToken && refreshed.accountId === session.accountId) {
      throw err;
    }

    if (options.compaction) {
      const display = retryDisplay(options, 1, 1);
      callbacks.onRetry?.(
        display.attempt,
        display.maxAttempts,
        "OpenAI authentication was refreshed during server-side compaction",
        0,
        { kind: "transient" },
      );
    }

    return sendWithSession(refreshed);
  }
}
