/**
 * Handing a conversation to an agent session that has not seen all of it
 * (docs/model-switching.md).
 *
 * Providers without a session of their own (OpenAI, OpenRouter, DeepSeek,
 * ...) get the whole canonical history translated into their wire format on
 * every request. Agent CLIs that keep their own session (Claude Code, the
 * Antigravity CLI) resume their latest point and receive what they missed,
 * usually another model's turns, as a transcript ahead of the new message.
 * This module renders that transcript, images included, and says which
 * messages a session saw.
 */

import type { ApiContentBlock, ApiMessage, ProviderId } from "../messages";
import { isValidImagePayload } from "../image-validation";

/** A transcript piece: text, or an image where it appeared in the conversation. */
export type HandoffPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string };

/**
 * Images a transcript carries natively, newest first; older ones become a
 * placeholder. Requests stay well under every provider's per-request image
 * limit, and the new message's own images are on top of these.
 */
export const MAX_HANDOFF_IMAGES = 8;

export const HANDOFF_HEADER = "<conversation_history>\nEarlier messages in this conversation that you have not seen in this session:\n\n";
export const HANDOFF_FOOTER = "\n</conversation_history>";

/**
 * The provider whose model wrote an assistant message, or null when the
 * message does not say. Replay data names it; otherwise the turn metadata does.
 */
export function assistantProvider(message: ApiMessage): ProviderId | null {
  if (message.role !== "assistant") return null;
  const data = message.providerData;
  if (data?.anthropic) return "anthropic";
  if (data?.gemini) return "gemini";
  if (data?.openai) return "openai";
  const metadata = message.metadata;
  const fromRate = metadata?.generationThroughput?.provider;
  if (fromRate) return fromRate;
  const model = metadata?.model;
  if (typeof model === "string") {
    if (/^claude-/i.test(model)) return "anthropic";
    if (/^gemini-/i.test(model)) return "gemini";
  }
  return null;
}

/** Whether any assistant message here was written by a model other than `provider`'s. */
export function hasOtherProviderTurns(messages: ApiMessage[], provider: ProviderId): boolean {
  return messages.some(message => message.role === "assistant" && assistantProvider(message) !== provider);
}

function imageOf(block: unknown): { mediaType: string; data: string } | null {
  const record = block as { type?: string; source?: { type?: string; media_type?: string; data?: string } } | null;
  if (record?.type !== "image" || record.source?.type !== "base64") return null;
  const mediaType = record.source.media_type ?? "";
  const data = record.source.data ?? "";
  return mediaType && data && isValidImagePayload(mediaType, data) ? { mediaType, data } : null;
}

function countImages(messages: ApiMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (imageOf(block)) count++;
      else if (block.type === "tool_result" && Array.isArray(block.content)) count += block.content.filter(part => imageOf(part)).length;
    }
  }
  return count;
}

class PartWriter {
  readonly parts: HandoffPart[] = [];
  private skip: number;
  omittedImages = 0;

  constructor(totalImages: number, maxImages: number) {
    this.skip = Math.max(0, totalImages - maxImages);
  }

  text(text: string): void {
    if (!text) return;
    const last = this.parts.at(-1);
    if (last?.type === "text") last.text += text;
    else this.parts.push({ type: "text", text });
  }

  image(image: { mediaType: string; data: string }, placeholder: string): void {
    if (this.skip > 0) {
      this.skip--;
      this.omittedImages++;
      this.text(placeholder);
      return;
    }
    this.parts.push({ type: "image", mediaType: image.mediaType, data: image.data });
  }
}

function writeToolResult(writer: PartWriter, block: Extract<ApiContentBlock, { type: "tool_result" }>): void {
  writer.text(`[tool result ${block.tool_use_id}${block.is_error ? " (error)" : ""}]\n`);
  if (typeof block.content === "string") {
    writer.text(block.content);
    return;
  }
  let first = true;
  for (const part of block.content) {
    if (!first) writer.text("\n");
    first = false;
    const image = imageOf(part);
    if (image) {
      writer.image(image, "[image omitted]");
      continue;
    }
    const record = part as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") writer.text(record.text);
    else if (record.type === "image") writer.text("[image]");
    else writer.text(JSON.stringify(part));
  }
}

function writeBlock(writer: PartWriter, block: ApiContentBlock): boolean {
  switch (block.type) {
    case "text":
      if (!block.text) return false;
      writer.text(block.text);
      return true;
    case "thinking":
      // Another model's reasoning is not carried (docs/model-switching.md).
      return false;
    case "tool_use":
      writer.text(`[tool call ${block.name} ${block.id}]\n${JSON.stringify(block.input)}`);
      return true;
    case "tool_result":
      writeToolResult(writer, block);
      return true;
    case "image": {
      const image = imageOf(block);
      if (image) writer.image(image, "[image omitted]");
      else writer.text("[image attached]");
      return true;
    }
  }
}

/**
 * History rendered as a transcript ("User:" / "Assistant:" sections), with
 * the newest `maxImages` images as image parts where they were sent or
 * returned by a tool.
 */
export function renderHandoffParts(messages: ApiMessage[], maxImages = MAX_HANDOFF_IMAGES): { parts: HandoffPart[]; omittedImages: number } {
  const writer = new PartWriter(countImages(messages), maxImages);
  let firstMessage = true;
  for (const message of messages) {
    const blocks: ApiContentBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    if (!blocks.some(block => block.type !== "thinking" && (block.type !== "text" || block.text.trim()))) continue;
    writer.text(`${firstMessage ? "" : "\n\n"}${message.role === "assistant" ? "Assistant" : "User"}:\n`);
    firstMessage = false;
    let firstBlock = true;
    for (const block of blocks) {
      if (block.type === "thinking" || (block.type === "text" && !block.text)) continue;
      if (!firstBlock) writer.text("\n\n");
      firstBlock = !writeBlock(writer, block) && firstBlock;
    }
  }
  return { parts: writer.parts, omittedImages: writer.omittedImages };
}

/** The transcript of `history` wrapped for a session that has not seen it; empty when there is none. */
export function handoffTranscript(history: ApiMessage[], maxImages = MAX_HANDOFF_IMAGES): HandoffPart[] {
  const { parts } = renderHandoffParts(history, maxImages);
  if (parts.length === 0) return [];
  const out: HandoffPart[] = [{ type: "text", text: HANDOFF_HEADER }, ...parts, { type: "text", text: HANDOFF_FOOTER }];
  // Merge the header/footer into neighbouring text.
  const merged: HandoffPart[] = [];
  for (const part of out) {
    const last = merged.at(-1);
    if (part.type === "text" && last?.type === "text") last.text += part.text;
    else merged.push(part.type === "text" ? { ...part } : part);
  }
  return merged;
}

export const MISSING_TOOL_RESULT = "No result was recorded for this tool call.";

function placeholders(ids: string[]): ApiContentBlock[] {
  return ids.map(id => ({ type: "tool_result", tool_use_id: id, content: MISSING_TOOL_RESULT, is_error: true }));
}

/**
 * History with every tool call answered by the message after it and every
 * tool result answering a call just before it, as the OpenAI and
 * chat-completions APIs require. Histories from agent CLIs (another model's
 * turn, an interrupted round) need not pair up: an unanswered call gets a
 * placeholder result, a result without its call is dropped (unless
 * `keepStrayResults`: an OpenAI compaction item can hold the call). Returns
 * `messages` itself when nothing changes.
 */
export function pairToolCalls(messages: ApiMessage[], keepStrayResults = false): ApiMessage[] {
  let out: ApiMessage[] | null = null;
  const copy = (): ApiMessage[] => (out ??= messages.slice());
  let inserted = 0;
  let open: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") {
      if (open.length > 0) {
        copy().splice(i + inserted, 0, { role: "user", content: placeholders(open) });
        inserted++;
      }
      open = typeof message.content === "string" ? [] : message.content.flatMap(block => block.type === "tool_use" ? [block.id] : []);
      continue;
    }
    const blocks: ApiContentBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const calls = new Set(open);
    if (keepStrayResults) for (const block of blocks) if (block.type === "tool_result") calls.add(block.tool_use_id);
    const answered = new Set(blocks.flatMap(block => block.type === "tool_result" && calls.has(block.tool_use_id) ? [block.tool_use_id] : []));
    const missing = open.filter(id => !answered.has(id));
    const stray = blocks.some(block => block.type === "tool_result" && !calls.has(block.tool_use_id));
    if (missing.length > 0 || stray) {
      const kept = blocks.filter(block => block.type !== "tool_result" || calls.has(block.tool_use_id));
      copy()[i + inserted] = {
        ...message,
        content: [...kept.filter(block => block.type === "tool_result"), ...placeholders(missing), ...kept.filter(block => block.type !== "tool_result")],
      };
    }
    open = [];
  }
  if (open.length > 0) copy().push({ role: "user", content: placeholders(open) });
  return out ?? messages;
}
