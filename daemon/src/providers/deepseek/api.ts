import type { ApiMessage, ModelId } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { AuthError } from "../errors";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { getVerifiedApiKey } from "./auth";
import { DEEPSEEK_CHAT_COMPLETIONS_PATH } from "./constants";
import { buildDeepSeekJsonHeaders, buildDeepSeekUrl, parseDeepSeekError } from "./http";
import { buildDeepSeekMessages, buildRequestBody } from "./request";
import { readDeepSeekEventsForTest, readDeepSeekStream } from "./stream";

export { readDeepSeekEventsForTest, buildDeepSeekMessages as buildDeepSeekMessagesForTest };

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 6;
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 507]);

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

async function retryBackoff(attempt: number, errMsg: string, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void> {
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, Math.round(delay / 1000), { kind: "transient" });
  await abortableDelay(delay, signal);
}

function formatDeepSeekHttpError(status: number, text: string): Error {
  const parsed = parseDeepSeekError(text) ?? text.slice(0, 500);
  if (status === 401 || status === 403) {
    return new AuthError(`DeepSeek authentication failed (${status}): ${parsed}. Run /login deepseek <api-key>.`);
  }
  return new Error(`DeepSeek API error (${status}): ${parsed}`);
}

export async function streamMessageWithApiKey(
  apiKey: string,
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
      res = await fetch(buildDeepSeekUrl(DEEPSEEK_CHAT_COMPLETIONS_PATH), {
        method: "POST",
        headers: buildDeepSeekJsonHeaders(apiKey),
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

    if (RETRIABLE_STATUS_CODES.has(res.status)) {
      const text = await res.text();
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}: ${(parseDeepSeekError(text) ?? text).slice(0, 160)}`, callbacks, signal);
        continue;
      }
      throw formatDeepSeekHttpError(res.status, text);
    }

    if (!res.ok) {
      const text = await res.text();
      throw formatDeepSeekHttpError(res.status, text);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readDeepSeekStream(res, callbacks, STREAM_STALL_TIMEOUT);
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
  const apiKey = await getVerifiedApiKey();
  return streamMessageWithApiKey(apiKey, messages, model, callbacks, options);
}
