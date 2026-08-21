import type { ApiMessage, ModelId } from "../../messages";
import { streamOpenAICompatibleWithApiKey, type OpenAICompatibleTransport } from "../openai-compatible/api";
import { readOpenAICompatibleEventsForTest } from "../openai-compatible/stream";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { getApiKey } from "./auth";
import { OPENCODE_CHAT_COMPLETIONS_PATH } from "./constants";
import { buildOpenCodeJsonHeaders, buildOpenCodeUrl, parseOpenCodeError } from "./http";
import { buildOpenCodeMessages, buildRequestBody } from "./request";

export { buildOpenCodeMessages as buildOpenCodeMessagesForTest };

export function readOpenCodeEventsForTest(
  events: Record<string, unknown>[],
  callbacks: Partial<StreamCallbacks> = {},
): StreamResult {
  return readOpenAICompatibleEventsForTest(events, callbacks, "OpenCode Zen");
}

const OPENCODE_TRANSPORT: OpenAICompatibleTransport = {
  providerLabel: "OpenCode Zen",
  loginInstruction: "Ox Alpha is a limited-time public preview; check whether OpenCode still advertises the model.",
  buildUrl: () => buildOpenCodeUrl(OPENCODE_CHAT_COMPLETIONS_PATH),
  buildHeaders: buildOpenCodeJsonHeaders,
  buildRequestBody,
  parseError: parseOpenCodeError,
};

export function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  return streamOpenAICompatibleWithApiKey(OPENCODE_TRANSPORT, getApiKey(), messages, model, callbacks, options);
}
