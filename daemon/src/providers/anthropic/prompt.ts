/**
 * Map Exocortex conversation history onto Claude Code sessions.
 *
 * Each completed Claude Code turn records its session id and last chain entry
 * on the final assistant message, and each committed tool round on its
 * tool-result message. The next turn forks that session at the latest such
 * entry and sends only the messages added since, so a turn interrupted
 * mid-way resumes after its last committed round. History Claude Code never
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
    if (!data) continue;
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

export function isPlainUserMessage(message: ApiMessage): boolean {
  if (message.role !== "user") return false;
  return typeof message.content === "string" || message.content.every((block) => block.type === "text" || block.type === "image");
}

/** The trailing plain user messages: what a turn sends natively rather than as a transcript. */
export function trailingUserMessages(messages: ApiMessage[]): ApiMessage[] {
  let start = messages.length;
  while (start > 0 && isPlainUserMessage(messages[start - 1])) start--;
  return messages.slice(start);
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

const LIVE_CONTINUE_PROMPT = "Your previous turn was interrupted before it finished. Continue where you left off.";

/**
 * The user turn for a Claude Code process that is still running (see
 * session.ts): it has seen everything but these new user messages.
 */
export function buildLiveSessionContent(messages: ApiMessage[]): SdkContent {
  const content = messages.flatMap(message => toSdkContent(message.content));
  return content.length > 0 ? content : [{ type: "text", text: LIVE_CONTINUE_PROMPT }];
}

const INTERRUPTED_TURN_PROMPT = "Your previous turn was interrupted before it finished, and anything it still had running (tool calls, background tasks) was stopped. Continue where you left off.";

/**
 * Build the user turn to send to Claude Code. Trailing plain user messages are
 * sent natively (images included); anything earlier is a transcript preamble.
 */
export function buildClaudeUserContent(pending: ApiMessage[]): SdkContent {
  const tail = trailingUserMessages(pending);
  const history = pending.slice(0, pending.length - tail.length);

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
  // No new user input: this replays a turn that ended early (a daemon restart,
  // an interrupt, an error). Say so, or the model has nothing to answer.
  if (tail.length === 0) content.push({ type: "text", text: INTERRUPTED_TURN_PROMPT });
  return content;
}

/** Plain-text prompt for one-shot helper requests (titles, summaries, compaction). */
export function buildClaudeHelperPrompt(messages: ApiMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") {
    return renderMessageContent(messages[0].content) || "Hello.";
  }
  return renderTranscript(messages) || "Hello.";
}
