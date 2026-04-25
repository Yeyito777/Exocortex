import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { getVerifiedSession } from "./auth";
import { AuthError } from "../errors";
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

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507]);

function isOpenAIAuthFailure(err: unknown): boolean {
  return err instanceof AuthError || (err instanceof Error && err.name === "AuthError");
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
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec);

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
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal);
        continue;
      }
      throw err;
    }

    if (res.status === 401) {
      throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
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
      if (signal?.aborted || isAbortLikeError(err)) throw err;
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
