import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApiContentBlock, ApiMessage, ModelId } from "../../messages";

const MODEL_IDS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-opus-4-6": "claude-opus-4-6",
};

export function resolveClaudeModel(model: ModelId): string {
  return MODEL_IDS[model] ?? model;
}

function renderBlock(block: ApiContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return `[thinking]\n${block.thinking}`;
    case "tool_use":
      return `[tool_use ${block.name}]\n${JSON.stringify(block.input, null, 2)}`;
    case "tool_result":
      return `[tool_result ${block.tool_use_id}${block.is_error ? " error" : ""}]\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2)}`;
    case "image":
      return `[image ${block.source.media_type}, ${block.source.data.length} base64 chars omitted]`;
  }
}

export function renderMessageContent(content: ApiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map(renderBlock).filter(Boolean).join("\n\n").trim();
}

export function extractResumeSessionId(messages: ApiMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sessionId = messages[i].providerData?.anthropic?.sessionId;
    if (sessionId) return sessionId;
  }
  return null;
}

export function buildClaudePrompt(messages: ApiMessage[], resumeSessionId: string | null): string {
  if (resumeSessionId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const rendered = renderMessageContent(messages[i].content);
      if (rendered) return rendered;
    }
  }

  const transcript = messages
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}:\n${renderMessageContent(message.content)}`.trim())
    .filter(Boolean)
    .join("\n\n");

  return transcript || "Hello.";
}

function buildSdkContentBlock(block: ApiContentBlock): Record<string, unknown> {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.source.media_type,
          data: block.source.data,
        },
      };
    default:
      return { type: "text", text: renderBlock(block) };
  }
}

export function buildClaudeSdkUserMessage(messages: ApiMessage[], resumeSessionId: string | null): SDKUserMessage {
  let sourceMessage: ApiMessage | null = null;

  if (resumeSessionId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        sourceMessage = messages[i];
        break;
      }
    }
  }

  if (!sourceMessage) {
    sourceMessage = messages.length === 1 && messages[0]?.role === "user"
      ? messages[0]
      : { role: "user", content: buildClaudePrompt(messages, null) };
  }

  return {
    type: "user",
    message: {
      role: "user",
      content: typeof sourceMessage.content === "string"
        ? sourceMessage.content
        : sourceMessage.content.map(buildSdkContentBlock),
    } as SDKUserMessage["message"],
    parent_tool_use_id: null,
  };
}

export function supportsClaudeEffort(model: ModelId): boolean {
  return model === "sonnet" || model === "opus" || model === "claude-sonnet-4-6" || model === "claude-opus-4-6";
}
