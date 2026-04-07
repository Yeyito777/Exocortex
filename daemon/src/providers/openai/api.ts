import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { getVerifiedSession } from "./auth";
import { AuthError } from "../errors";
import { OPENAI_CODEX_RESPONSES_URL, OPENAI_ORIGINATOR } from "./constants";
import { buildOpenAIInput, buildRequestBody } from "./request";
import { mergeReasoningSummaries } from "./reasoning";
import { readOpenAIEventsForTest, readOpenAIStream } from "./stream";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";

export { AuthError, mergeReasoningSummaries as mergeReasoningSummariesForTest, readOpenAIEventsForTest };

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;

type OpenAISession = { accessToken: string; accountId: string | null };

function buildOpenAIRequestHeaders(
  session: OpenAISession,
  options: StreamOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    originator: OPENAI_ORIGINATOR,
    "User-Agent": "exocortexd/openai",
  };

  // Match the official Codex client: when a stable prompt cache key is present,
  // also send the same conversation identity in headers. This keeps the request
  // shape aligned with the backend's expected conversation/cache routing signals.
  if (options.promptCacheKey) {
    headers.session_id = options.promptCacheKey;
    headers["x-client-request-id"] = options.promptCacheKey;
  }

  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  return headers;
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
  session: OpenAISession,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  let retryAttempt = 0;
  const requestBody = buildRequestBody(messages, model, options);

  while (true) {
    let res: Response;
    try {
      res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: buildOpenAIRequestHeaders(session, options),
        body: JSON.stringify(requestBody),
        signal,
      });
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

    if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
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
  return streamMessageWithSession(session, messages, model, callbacks, options);
}
