import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { AuthError } from "../errors";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import type { OpenAICompatibleRequestBody } from "./request";
import { readOpenAICompatibleStream } from "./stream";

const STREAM_STALL_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 6;
const MAX_AUTOMATIC_RETRY_AFTER_MS = 30_000;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507]);

export interface OpenAICompatibleTransport {
  providerLabel: string;
  loginInstruction: string;
  buildUrl: () => string;
  buildHeaders: (apiKey: string) => Record<string, string>;
  buildRequestBody: (messages: ApiMessage[], model: ModelId, options: StreamOptions) => OpenAICompatibleRequestBody;
  parseError?: (text: string) => string | null;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

async function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  headers?: Headers,
): Promise<boolean> {
  const requestedDelay = headers ? retryAfterMs(headers) : null;
  if (requestedDelay != null && requestedDelay > MAX_AUTOMATIC_RETRY_AFTER_MS) return false;
  const exponentialDelay = Math.min(1000 * Math.pow(2, attempt), MAX_AUTOMATIC_RETRY_AFTER_MS) + Math.random() * 1000;
  const delay = Math.max(exponentialDelay, requestedDelay ?? 0);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, Math.round(delay / 1000), { kind: "transient" });
  await abortableDelay(delay, signal);
  return true;
}

function formatHttpError(transport: OpenAICompatibleTransport, status: number, text: string, headers?: Headers): Error {
  const parsed = transport.parseError?.(text) ?? text.slice(0, 500);
  if (status === 401 || status === 403) {
    return new AuthError(`${transport.providerLabel} authentication failed (${status}): ${parsed}. ${transport.loginInstruction}`);
  }
  const retry = headers ? retryAfterMs(headers) : null;
  const retryHint = retry != null && retry > 0 ? `; retry after ${Math.ceil(retry / 1000)} seconds` : "";
  return new Error(`${transport.providerLabel} API error (${status}): ${parsed}${retryHint}`);
}

export async function streamOpenAICompatibleWithApiKey(
  transport: OpenAICompatibleTransport,
  apiKey: string,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  let retryAttempt = 0;
  const requestBody = transport.buildRequestBody(messages, model, options);

  while (true) {
    let res: Response;
    try {
      res = await fetch(transport.buildUrl(), {
        method: "POST",
        headers: transport.buildHeaders(apiKey),
        body: JSON.stringify(requestBody),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      if (retryAttempt < MAX_RETRIES
        && await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal)) continue;
      throw err;
    }

    if (RETRIABLE_STATUS_CODES.has(res.status)) {
      const text = await res.text();
      const detail = (transport.parseError?.(text) ?? text).slice(0, 160);
      if (retryAttempt < MAX_RETRIES
        && await retryBackoff(retryAttempt++, `HTTP ${res.status}: ${detail}`, callbacks, signal, res.headers)) continue;
      throw formatHttpError(transport, res.status, text, res.headers);
    }

    if (!res.ok) {
      const text = await res.text();
      throw formatHttpError(transport, res.status, text, res.headers);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readOpenAICompatibleStream(res, callbacks, STREAM_STALL_TIMEOUT_MS, transport.providerLabel);
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      if (retryAttempt < MAX_RETRIES
        && await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal)) continue;
      throw err;
    }
  }
}
