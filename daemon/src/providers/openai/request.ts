import { createHash } from "crypto";
import type { ApiMessage, ApiContentBlock, ModelId, EffortLevel } from "../../messages";
import type { StreamOptions } from "../types";

export interface OpenAIReasoningItem {
  id: string;
  encryptedContent: string | null;
  summaries: string[];
}

export interface OpenAIAssistantProviderData {
  openai: {
    responseId?: string;
    reasoningItems?: OpenAIReasoningItem[];
    requestShapeHash?: string;
  };
}

export type OpenAIInputItem =
  | { role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }>; id?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null; summary: Array<{ type: "summary_text"; text: string }> };

interface OpenAIRequestShape {
  model: ModelId;
  instructions: string;
  tool_choice: string;
  parallel_tool_calls: boolean;
  include: string[];
  reasoning: {
    effort: string;
    summary: string;
  };
  tools?: Array<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
  }>;
}

export interface OpenAIRequestPlan {
  body: Record<string, unknown>;
  requestShapeHash: string;
}

interface OpenAIRequestReuse {
  previousResponseId: string;
  input: OpenAIInputItem[];
}

function mapEffort(effort: EffortLevel | undefined): string {
  switch (effort) {
    case "none": return "none";
    case "minimal": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "xhigh": return "xhigh";
    case "max": return "xhigh";
    case "high":
    default:
      return "high";
  }
}

function encodeImage(mediaType: string, base64: string): string {
  return `data:${mediaType};base64,${base64}`;
}

function extractToolResultText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function extractToolResultImages(content: string | unknown[]): Array<{ mediaType: string; base64: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((part): part is { type?: string; source?: { type?: string; media_type?: string; data?: string } } => !!part && typeof part === "object")
    .filter((part) => part.type === "image" && part.source?.type === "base64" && !!part.source.media_type && !!part.source.data)
    .map((part) => ({ mediaType: part.source!.media_type!, base64: part.source!.data! }));
}

export function buildOpenAIInput(messages: ApiMessage[]): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: message.content }],
        });
        continue;
      }

      const toolResults = message.content.filter((block) => block.type === "tool_result");
      const plainText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");

      if (toolResults.length > 0) {
        for (const result of toolResults) {
          const output = extractToolResultText(result.content);
          input.push({
            type: "function_call_output",
            call_id: result.tool_use_id,
            output,
          });

          const images = extractToolResultImages(result.content);
          if (images.length > 0) {
            input.push({
              role: "user",
              content: [
                { type: "input_text", text: `Image output for tool call ${result.tool_use_id}.` },
                ...images.map((image) => ({
                  type: "input_image" as const,
                  image_url: encodeImage(image.mediaType, image.base64),
                })),
              ],
            });
          }
        }

        if (plainText) {
          input.push({
            role: "user",
            content: [{ type: "input_text", text: plainText }],
          });
        }
        continue;
      }

      const parts: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push({ type: "input_text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "input_image",
            image_url: encodeImage(block.source.media_type, block.source.data),
          });
        }
      }
      if (parts.length > 0) {
        input.push({ role: "user", content: parts });
      }
      continue;
    }

    const providerData = (message.providerData as OpenAIAssistantProviderData | undefined)?.openai;
    const reasoningItems = providerData?.reasoningItems ?? [];
    for (const reasoning of reasoningItems) {
      input.push({
        type: "reasoning",
        id: reasoning.id,
        ...(reasoning.encryptedContent !== null ? { encrypted_content: reasoning.encryptedContent } : {}),
        summary: reasoning.summaries.map((text) => ({ type: "summary_text" as const, text })),
      });
    }

    const contentBlocks = typeof message.content === "string" ? [{ type: "text", text: message.content } as ApiContentBlock] : message.content;
    const textParts = contentBlocks
      .filter((block): block is Extract<ApiContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text);

    if (textParts.length > 0) {
      input.push({
        role: "assistant",
        content: textParts.map((text) => ({ type: "output_text", text })),
      });
    }

    for (const block of contentBlocks) {
      if (block.type !== "tool_use") continue;
      input.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      });
    }
  }

  return input;
}

function buildOpenAITools(tools: StreamOptions["tools"]): OpenAIRequestShape["tools"] {
  if (!tools || tools.length === 0) return undefined;
  return (tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
}

function buildRequestShape(model: ModelId, options: StreamOptions): OpenAIRequestShape {
  const tools = buildOpenAITools(options.tools);
  return {
    model,
    instructions: options.system || "You are a helpful assistant.",
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: mapEffort(options.effort),
      summary: "concise",
    },
    ...(tools ? { tools } : {}),
  };
}

function hashRequestShape(shape: OpenAIRequestShape): string {
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export function buildRequestPlan(
  messages: ApiMessage[],
  model: ModelId,
  options: StreamOptions,
): OpenAIRequestPlan {
  const input = buildOpenAIInput(messages);
  const shape = buildRequestShape(model, options);
  const body: Record<string, unknown> = {
    ...shape,
    input,
    stream: true,
    store: false,
    ...(options.promptCacheKey ? { prompt_cache_key: options.promptCacheKey } : {}),
  };
  return {
    body,
    requestShapeHash: hashRequestShape(shape),
  };
}

function getReusableResponse(messages: ApiMessage[], requestShapeHash: string): OpenAIRequestReuse | null {
  let assistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantIndex = i;
      break;
    }
  }
  if (assistantIndex === -1) return null;

  const providerData = (messages[assistantIndex].providerData as OpenAIAssistantProviderData | undefined)?.openai;
  if (!providerData?.responseId) return null;
  if (providerData.requestShapeHash !== requestShapeHash) return null;

  const priorPrefix = buildOpenAIInput(messages.slice(0, assistantIndex + 1));
  const fullInput = buildOpenAIInput(messages);
  if (fullInput.length < priorPrefix.length) return null;

  for (let i = 0; i < priorPrefix.length; i++) {
    if (JSON.stringify(fullInput[i]) !== JSON.stringify(priorPrefix[i])) {
      return null;
    }
  }

  return {
    previousResponseId: providerData.responseId,
    input: fullInput.slice(priorPrefix.length),
  };
}

export function buildRequestBody(
  messages: ApiMessage[],
  model: ModelId,
  options: StreamOptions,
): OpenAIRequestPlan {
  const plan = buildRequestPlan(messages, model, options);
  // Reuse prior OpenAI response state only when the current request has the
  // same non-input shape and the serialized input is an append-only extension
  // of the prior assistant turn.
  const reuse = getReusableResponse(messages, plan.requestShapeHash);
  if (!reuse) return plan;
  return {
    ...plan,
    body: {
      ...plan.body,
      previous_response_id: reuse.previousResponseId,
      input: reuse.input,
    },
  };
}
