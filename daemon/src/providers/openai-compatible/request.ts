import type { ApiContentBlock, ApiMessage, EffortLevel, ModelId } from "../../messages";
import { isValidImagePayload } from "../../image-validation";
import type { StreamOptions } from "../types";

export type OpenAICompatibleMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAICompatibleUserPart[] }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: OpenAICompatibleToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type OpenAICompatibleUserPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface OpenAICompatibleToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAICompatibleEffortFields {
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "high" | "max";
}

export interface OpenAICompatibleRequestProfile {
  providerLabel: string;
  supportsImages: boolean;
  strictTools?: boolean;
  mapEffort: (effort: EffortLevel | undefined) => OpenAICompatibleEffortFields;
}

export interface OpenAICompatibleRequestBody {
  model: ModelId;
  messages: OpenAICompatibleMessage[];
  stream: true;
  max_tokens?: number;
  tools?: OpenAICompatibleToolDefinition[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  thinking?: { type: "enabled" | "disabled" };
  reasoning_effort?: "low" | "high" | "max";
  stream_options: { include_usage: true };
}

interface OpenAICompatibleToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: true;
  };
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
    .map((part) => ({ mediaType: part.source!.media_type!, base64: part.source!.data! }))
    .filter((image) => isValidImagePayload(image.mediaType, image.base64));
}

function userPartsFromBlocks(blocks: ApiContentBlock[], profile: OpenAICompatibleRequestProfile): OpenAICompatibleUserPart[] {
  const parts: OpenAICompatibleUserPart[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type !== "image") continue;
    if (!profile.supportsImages) {
      parts.push({ type: "text", text: `[Image omitted: ${profile.providerLabel} does not support image inputs.]` });
      continue;
    }
    if (!isValidImagePayload(block.source.media_type, block.source.data)) {
      parts.push({ type: "text", text: `[Invalid ${block.source.media_type || "image"} attachment omitted before sending to ${profile.providerLabel}.]` });
      continue;
    }
    parts.push({
      type: "image_url",
      image_url: { url: encodeImage(block.source.media_type, block.source.data) },
    });
  }
  return parts;
}

function appendUserParts(
  out: OpenAICompatibleMessage[],
  parts: OpenAICompatibleUserPart[],
  profile: OpenAICompatibleRequestProfile,
): void {
  if (parts.length === 0) return;
  if (profile.supportsImages) {
    out.push({ role: "user", content: parts });
    return;
  }
  const text = parts
    .filter((part): part is Extract<OpenAICompatibleUserPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (text.trim()) out.push({ role: "user", content: text });
}

function assistantTextFromBlocks(blocks: ApiContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ApiContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function assistantReasoningFromBlocks(blocks: ApiContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ApiContentBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => block.thinking)
    .filter(Boolean)
    .join("\n");
}

function assistantToolCallsFromBlocks(blocks: ApiContentBlock[]): OpenAICompatibleToolCall[] {
  return blocks
    .filter((block): block is Extract<ApiContentBlock, { type: "tool_use" }> => block.type === "tool_use")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input),
      },
    }));
}

export function buildOpenAICompatibleMessages(
  messages: ApiMessage[],
  system: string | undefined,
  profile: OpenAICompatibleRequestProfile,
): OpenAICompatibleMessage[] {
  const out: OpenAICompatibleMessage[] = [];
  if (system?.trim()) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push({ role: "user", content: message.content });
        continue;
      }

      const toolResults = message.content.filter((block) => block.type === "tool_result");
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: extractToolResultText(result.content),
          });
          if (profile.supportsImages) {
            const images = extractToolResultImages(result.content);
            if (images.length > 0) {
              out.push({
                role: "user",
                content: [
                  { type: "text", text: `Image output for tool call ${result.tool_use_id}.` },
                  ...images.map((image): OpenAICompatibleUserPart => ({
                    type: "image_url",
                    image_url: { url: encodeImage(image.mediaType, image.base64) },
                  })),
                ],
              });
            }
          }
        }
        const plainParts = userPartsFromBlocks(message.content.filter((block) => block.type !== "tool_result"), profile);
        appendUserParts(out, plainParts, profile);
        continue;
      }

      const parts = userPartsFromBlocks(message.content, profile);
      appendUserParts(out, parts, profile);
      continue;
    }

    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content } as ApiContentBlock]
      : message.content;
    const content = assistantTextFromBlocks(blocks);
    const reasoning = assistantReasoningFromBlocks(blocks);
    const toolCalls = assistantToolCallsFromBlocks(blocks);
    out.push({
      role: "assistant",
      content,
      // Reasoning models with interleaved tool use need this field replayed.
      // Some providers require the field even when a terse tool-call round
      // emitted no reasoning, so retain an explicit empty value in that case.
      ...(reasoning || toolCalls.length > 0 ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

function buildTools(
  tools: StreamOptions["tools"],
  profile: OpenAICompatibleRequestProfile,
): OpenAICompatibleToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return (tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      ...(profile.strictTools ? { strict: true as const } : {}),
    },
  }));
}

export function buildOpenAICompatibleRequestBody(
  messages: ApiMessage[],
  model: ModelId,
  options: StreamOptions,
  profile: OpenAICompatibleRequestProfile,
): OpenAICompatibleRequestBody {
  const tools = buildTools(options.tools, profile);
  return {
    model,
    messages: buildOpenAICompatibleMessages(messages, options.system, profile),
    stream: true,
    stream_options: { include_usage: true },
    ...profile.mapEffort(options.effort),
    ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
    ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
  };
}
