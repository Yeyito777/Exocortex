import type { ApiMessage, ModelId } from "../../messages";
import { buildOpenAICompatibleRequestBody, type OpenAICompatibleRequestBody } from "../openai-compatible/request";
import type { StreamOptions } from "../types";
import { openRouterModel } from "./models";

interface OpenRouterRequestBody extends OpenAICompatibleRequestBody {
  reasoning?: { enabled: boolean };
  provider: { require_parameters: true };
}

export function buildRequestBody(messages: ApiMessage[], model: ModelId, options: StreamOptions): OpenRouterRequestBody {
  const info = openRouterModel(model);
  const body = buildOpenAICompatibleRequestBody(messages, model, {
    ...options,
    maxTokens: options.maxTokens == null ? undefined : Math.min(options.maxTokens, info.maxCompletionTokens),
    tools: info.supportsTools ? options.tools : [],
    system: info.supportsTools ? options.system : `${options.system ?? ""}\n\nThis is a chat-only model endpoint. No tools are available. Do not claim to execute commands, browse, or perform actions.`,
  }, { providerLabel: "OpenRouter", supportsImages: info.supportsImages === true, mapEffort: () => ({}) });
  // OpenRouter uses `reasoning`, not DeepSeek's `reasoning_content` replay.
  // Reasoning is not needed for these chat-only models' conversation history.
  for (const message of body.messages) {
    if (message.role === "assistant") delete message.reasoning_content;
  }
  if (!info.supportsTools) {
    // Preserve cross-model tool history as inert text; unsupported endpoints
    // must never receive native tool roles or tool_calls.
    body.messages = body.messages.map((message) => {
      if (message.role === "tool") return { role: "user" as const, content: `[Historical tool result ${message.tool_call_id}]\n${message.content}` };
      if (message.role === "assistant" && message.tool_calls) {
        return { role: "assistant" as const, content: `${message.content}\n[Historical tool calls]\n${JSON.stringify(message.tool_calls)}` };
      }
      return message;
    });
  }
  delete body.parallel_tool_calls;
  return { ...body, provider: { require_parameters: true },
    ...(info.supportedEfforts.length ? { reasoning: { enabled: (options.effort ?? info.defaultEffort) !== "none" } } : {}),
  };
}
