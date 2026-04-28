import type { ApiContentBlock, ApiMessage, EffortLevel, ModelId } from "../../messages";
import type { StreamOptions } from "../types";

export type DeepSeekChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: DeepSeekToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekRequestBody {
  model: ModelId;
  messages: DeepSeekChatMessage[];
  stream: true;
  max_tokens?: number;
  tools?: DeepSeekToolDefinition[];
  tool_choice?: "auto";
  parallel_tool_calls?: boolean;
  reasoning_effort?: "high" | "max";
  thinking?: { type: "enabled" | "disabled" };
  stream_options?: { include_usage: boolean };
}

interface DeepSeekToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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

function userTextFromBlocks(blocks: ApiContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push("[Image omitted: DeepSeek does not support image inputs in this backend.]");
  }
  return parts.join("\n");
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

function assistantToolCallsFromBlocks(blocks: ApiContentBlock[]): DeepSeekToolCall[] {
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

export function buildDeepSeekMessages(messages: ApiMessage[], system?: string): DeepSeekChatMessage[] {
  const out: DeepSeekChatMessage[] = [];
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
        }
        const plainText = userTextFromBlocks(message.content.filter((block) => block.type !== "tool_result"));
        if (plainText.trim()) out.push({ role: "user", content: plainText });
        continue;
      }

      const text = userTextFromBlocks(message.content);
      if (text.trim()) out.push({ role: "user", content: text });
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
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

function buildDeepSeekTools(tools: StreamOptions["tools"]): DeepSeekToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return (tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

function mapEffort(effort: EffortLevel | undefined): { thinking: { type: "enabled" | "disabled" }; reasoning_effort?: "high" | "max" } {
  switch (effort) {
    case "none":
      return { thinking: { type: "disabled" } };
    case "xhigh":
    case "max":
      return { thinking: { type: "enabled" }, reasoning_effort: "max" };
    case "minimal":
    case "low":
    case "medium":
    case "high":
    default:
      return { thinking: { type: "enabled" }, reasoning_effort: "high" };
  }
}

export function buildRequestBody(messages: ApiMessage[], model: ModelId, options: StreamOptions): DeepSeekRequestBody {
  const tools = buildDeepSeekTools(options.tools);
  const effort = mapEffort(options.effort);
  return {
    model,
    messages: buildDeepSeekMessages(messages, options.system),
    stream: true,
    stream_options: { include_usage: true },
    ...effort,
    ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
    ...(tools ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
  };
}
