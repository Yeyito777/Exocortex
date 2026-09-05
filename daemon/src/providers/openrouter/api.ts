import type { ApiMessage, ModelId } from "../../messages";
import { streamOpenAICompatibleWithApiKey, type OpenAICompatibleTransport } from "../openai-compatible/api";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { getVerifiedApiKey } from "./auth";
import { OPENROUTER_CHAT_COMPLETIONS_PATH } from "./constants";
import { buildOpenRouterJsonHeaders, buildOpenRouterUrl, parseOpenRouterError } from "./http";
import { buildRequestBody } from "./request";
import { openRouterModel } from "./models";

const OPENROUTER_TRANSPORT: OpenAICompatibleTransport = {
  providerLabel: "OpenRouter",
  loginInstruction: "Run /login openrouter <api-key>.",
  buildUrl: () => buildOpenRouterUrl(OPENROUTER_CHAT_COMPLETIONS_PATH),
  buildHeaders: buildOpenRouterJsonHeaders,
  buildRequestBody,
  parseError: parseOpenRouterError,
};

export async function streamMessageWithApiKey(
  apiKey: string,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const supportsTools = openRouterModel(model).supportsTools === true;
  const result = await streamOpenAICompatibleWithApiKey(OPENROUTER_TRANSPORT, apiKey, messages, model, callbacks, options);
  if (!supportsTools && result.toolCalls.length) throw new Error("OpenRouter chat-only endpoint returned an unsupported tool call");
  return result;
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
