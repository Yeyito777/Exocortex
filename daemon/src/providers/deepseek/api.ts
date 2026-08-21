import type { ApiMessage, ModelId } from "../../messages";
import { streamOpenAICompatibleWithApiKey, type OpenAICompatibleTransport } from "../openai-compatible/api";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { getVerifiedApiKey } from "./auth";
import { DEEPSEEK_CHAT_COMPLETIONS_PATH } from "./constants";
import { buildDeepSeekJsonHeaders, buildDeepSeekUrl, parseDeepSeekError } from "./http";
import { buildDeepSeekMessages, buildRequestBody } from "./request";
import { readDeepSeekEventsForTest } from "./stream";

export { readDeepSeekEventsForTest, buildDeepSeekMessages as buildDeepSeekMessagesForTest };

const DEEPSEEK_TRANSPORT: OpenAICompatibleTransport = {
  providerLabel: "DeepSeek",
  loginInstruction: "Run /login deepseek <api-key>.",
  buildUrl: () => buildDeepSeekUrl(DEEPSEEK_CHAT_COMPLETIONS_PATH),
  buildHeaders: buildDeepSeekJsonHeaders,
  buildRequestBody,
  parseError: parseDeepSeekError,
};

export function streamMessageWithApiKey(
  apiKey: string,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  return streamOpenAICompatibleWithApiKey(DEEPSEEK_TRANSPORT, apiKey, messages, model, callbacks, options);
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
