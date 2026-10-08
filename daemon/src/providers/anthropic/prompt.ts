/**
 * Map Exocortex conversation history onto Claude Code sessions.
 *
 * Each completed Claude Code turn records its session id and last chain entry
 * on the final assistant message. The next turn forks that session at that
 * entry and sends only the messages added since. History Claude Code never
 * saw (another provider's turns, an aborted partial, a compaction checkpoint)
 * is rendered into the prompt as a transcript.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ApiContentBlock, ApiMessage } from "../../messages";
import type { AnthropicAssistantProviderData } from "./types";

type ResumeData = AnthropicAssistantProviderData["anthropic"];
type SdkContent = Exclude<SDKUserMessage["message"]["content"], string>;

export interface ClaudePromptPlan {
  resume: ResumeData | null;
  /** Messages Claude Code has not seen yet. */
  pending: ApiMessage[];
}

export function planClaudePrompt(messages: ApiMessage[], cwd: string): ClaudePromptPlan {
  for (let i = messages.length - 1; i >= 0; i--) {
    const data = messages[i].providerData?.anthropic;
    if (messages[i].role !== "assistant" || !data) continue;
    if (data.cwd !== cwd) break;
    return { resume: data, pending: messages.slice(i + 1) };
  }
  return { resume: null, pending: messages };
}

function stringifyToolResultContent(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      const record = part as { type?: string; text?: string };
      if (record.type === "text" && typeof record.text === "string") return record.text;
      if (record.type === "image") return "[image]";
      return JSON.stringify(part);
    })
    .join("\n");
}

function renderBlock(block: ApiContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return "";
    case "tool_use":
      return `[tool call ${block.name} ${block.id}]\n${JSON.stringify(block.input)}`;
    case "tool_result":
      return `[tool result ${block.tool_use_id}${block.is_error ? " (error)" : ""}]\n${stringifyToolResultContent(block.content)}`;
    case "image":
      return "[image attached]";
  }
}

export function renderMessageContent(content: ApiMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map(renderBlock).filter(Boolean).join("\n\n").trim();
}

function isPlainUserMessage(message: ApiMessage): boolean {
  if (message.role !== "user") return false;
  return typeof message.content === "string" || message.content.every((block) => block.type === "text" || block.type === "image");
}

function toSdkContent(content: ApiMessage["content"]): SdkContent {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const out: SdkContent = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text) out.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      out.push({
        type: "image",
        source: { type: "base64", media_type: block.source.media_type as "image/png", data: block.source.data },
      });
    }
  }
  return out;
}

/** Render prior history as a plain-text transcript. */
export function renderTranscript(messages: ApiMessage[]): string {
  return messages
    .map((message) => {
      const body = renderMessageContent(message.content);
      return body ? `${message.role === "assistant" ? "Assistant" : "User"}:\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the user turn to send to Claude Code. Trailing plain user messages are
 * sent natively (images included); anything earlier is a transcript preamble.
 */
export function buildClaudeUserContent(pending: ApiMessage[]): SdkContent {
  let tailStart = pending.length;
  while (tailStart > 0 && isPlainUserMessage(pending[tailStart - 1])) tailStart--;
  const history = pending.slice(0, tailStart);
  const tail = pending.slice(tailStart);

  const content: SdkContent = [];
  const transcript = renderTranscript(history);
  if (transcript) {
    content.push({
      type: "text",
      text: "<conversation_history>\nEarlier messages in this conversation that you have not seen in this session:\n\n"
        + `${transcript}\n</conversation_history>`,
    });
  }
  for (const message of tail) content.push(...toSdkContent(message.content));
  if (content.length === 0) content.push({ type: "text", text: "Continue." });
  return content;
}

/** Plain-text prompt for one-shot helper requests (titles, summaries, compaction). */
export function buildClaudeHelperPrompt(messages: ApiMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") {
    return renderMessageContent(messages[0].content) || "Hello.";
  }
  return renderTranscript(messages) || "Hello.";
}
