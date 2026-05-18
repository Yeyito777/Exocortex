import { createHash } from "crypto";
import type {
  ApiContentBlock,
  ApiMessage,
  ContextTokenBreakdown,
  MessageContextTokenAttribution,
  ModelId,
  ProviderId,
  StoredMessage,
} from "./messages";
import { isHistoryMessage, isModelVisibleSystemNotice } from "./messages";

export type ContextTokenCategory = keyof ContextTokenBreakdown;

const BREAKDOWN_KEYS: ContextTokenCategory[] = [
  "userText",
  "userImage",
  "assistantText",
  "toolUse",
  "toolResultText",
  "toolResultImage",
  "thinking",
  "providerReasoning",
  "systemHint",
];

export function emptyContextTokenBreakdown(): ContextTokenBreakdown {
  return {
    userText: 0,
    userImage: 0,
    assistantText: 0,
    toolUse: 0,
    toolResultText: 0,
    toolResultImage: 0,
    thinking: 0,
    providerReasoning: 0,
    systemHint: 0,
  };
}

export function addContextTokenBreakdown(target: ContextTokenBreakdown, source: ContextTokenBreakdown): void {
  for (const key of BREAKDOWN_KEYS) target[key] += source[key];
}

export function sumContextTokenBreakdown(breakdown: ContextTokenBreakdown): number {
  return BREAKDOWN_KEYS.reduce((sum, key) => sum + breakdown[key], 0);
}

function addChars(target: ContextTokenBreakdown, key: ContextTokenCategory, value: number): void {
  if (Number.isFinite(value) && value > 0) target[key] += value;
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function hashString(hash: ReturnType<typeof createHash>, value: string | null | undefined): void {
  const text = value ?? "";
  hash.update(String(text.length));
  hash.update(":");
  hash.update(text);
  hash.update(";");
}

function hashUnknown(hash: ReturnType<typeof createHash>, value: unknown): void {
  try {
    hashString(hash, JSON.stringify(value));
  } catch {
    hashString(hash, String(value));
  }
}

function providerReasoningChars(providerData: ApiMessage["providerData"] | StoredMessage["providerData"]): number {
  const items = providerData?.openai?.reasoningItems ?? [];
  let chars = 0;
  for (const item of items) {
    chars += item.id.length;
    chars += item.encryptedContent?.length ?? 0;
    for (const summary of item.summaries ?? []) chars += summary.length;
  }
  return chars;
}

function hashProviderReasoning(hash: ReturnType<typeof createHash>, providerData: ApiMessage["providerData"] | StoredMessage["providerData"]): void {
  const items = providerData?.openai?.reasoningItems ?? [];
  hash.update(`reasoning:${items.length};`);
  for (const item of items) {
    hashString(hash, item.id);
    hashString(hash, item.encryptedContent ?? "");
    hash.update(`summaries:${item.summaries?.length ?? 0};`);
    for (const summary of item.summaries ?? []) hashString(hash, summary);
  }
}

function imageDimensions(mediaType: string, base64: string): { width: number; height: number } | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    if (mediaType === "image/png" && bytes.length >= 24
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (mediaType === "image/gif" && bytes.length >= 10 && bytes.subarray(0, 3).toString("ascii") === "GIF") {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (mediaType === "image/webp" && bytes.length >= 30 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
      const chunk = bytes.subarray(12, 16).toString("ascii");
      if (chunk === "VP8X" && bytes.length >= 30) {
        const width = 1 + bytes.readUIntLE(24, 3);
        const height = 1 + bytes.readUIntLE(27, 3);
        return { width, height };
      }
    }
    if (mediaType === "image/jpeg" && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) break;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        if (length < 2) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function openAIImageTokenEstimate(mediaType: string, base64: string): number {
  const dims = imageDimensions(mediaType, base64);
  if (!dims || dims.width <= 0 || dims.height <= 0) return 1105;
  let width = dims.width;
  let height = dims.height;
  const maxSide = Math.max(width, height);
  if (maxSide > 2048) {
    const scale = 2048 / maxSide;
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  const minSide = Math.min(width, height);
  if (minSide > 768) {
    const scale = 768 / minSide;
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
  return 85 + 170 * tiles;
}

function imageReplayChars(mediaType: string, base64: string, provider?: ProviderId): number {
  if (provider === "openai") return openAIImageTokenEstimate(mediaType, base64) * 4;
  return base64.length;
}

function toolResultContentChars(content: string | unknown[], provider?: ProviderId): { text: number; image: number } {
  if (typeof content === "string") return { text: content.length, image: 0 };
  let text = 0;
  let image = 0;
  for (const part of content) {
    if (part && typeof part === "object") {
      const record = part as Record<string, unknown>;
      if (record.type === "image" && record.source && typeof record.source === "object") {
        const source = record.source as Record<string, unknown>;
        const mediaType = typeof source.media_type === "string" ? source.media_type : "image";
        image += typeof source.data === "string" ? imageReplayChars(mediaType, source.data, provider) : jsonLength(record);
        continue;
      }
      if (record.type === "text" && typeof record.text === "string") {
        text += record.text.length;
        continue;
      }
    }
    text += jsonLength(part);
  }
  return { text, image };
}

export function contextMessageCharBreakdown(
  msg: Pick<StoredMessage, "role" | "content" | "metadata" | "providerData">,
  provider?: ProviderId,
): ContextTokenBreakdown {
  const out = emptyContextTokenBreakdown();
  const systemHint = isModelVisibleSystemNotice(msg);

  if (typeof msg.content === "string") {
    if (systemHint) addChars(out, "systemHint", msg.content.length);
    else if (msg.role === "assistant") addChars(out, "assistantText", msg.content.length);
    else if (msg.role === "user") addChars(out, "userText", msg.content.length);
    addChars(out, "providerReasoning", providerReasoningChars(msg.providerData));
    return out;
  }

  for (const block of msg.content as ApiContentBlock[]) {
    switch (block.type) {
      case "text":
        if (systemHint) addChars(out, "systemHint", block.text.length);
        else if (msg.role === "assistant") addChars(out, "assistantText", block.text.length);
        else addChars(out, "userText", block.text.length);
        break;
      case "image":
        addChars(out, "userImage", imageReplayChars(block.source.media_type, block.source.data, provider));
        break;
      case "thinking":
        // OpenAI replay uses providerData.openai.reasoningItems instead of the
        // rendered thinking-summary blocks. DeepSeek replays thinking blocks as
        // reasoning_content, so they remain context-relevant there.
        if (provider !== "openai") addChars(out, "thinking", block.thinking.length + block.signature.length);
        break;
      case "tool_use":
        addChars(out, "toolUse", block.id.length + block.name.length + jsonLength(block.input));
        break;
      case "tool_result": {
        const chars = toolResultContentChars(block.content, provider);
        addChars(out, "toolResultText", chars.text);
        addChars(out, "toolResultImage", chars.image);
        break;
      }
    }
  }

  addChars(out, "providerReasoning", providerReasoningChars(msg.providerData));
  return out;
}

export function contextMessageChars(
  msg: Pick<StoredMessage, "role" | "content" | "metadata" | "providerData">,
  provider?: ProviderId,
): number {
  return sumContextTokenBreakdown(contextMessageCharBreakdown(msg, provider));
}

export function contextMessageSignature(msg: Pick<StoredMessage, "role" | "content" | "metadata" | "providerData">): string {
  const hash = createHash("sha256");
  hash.update(msg.role);
  hash.update("|");
  hash.update(isModelVisibleSystemNotice(msg) ? "system-hint" : "normal");
  hash.update("|");

  if (typeof msg.content === "string") {
    hash.update("string|");
    hashString(hash, msg.content);
  } else {
    hash.update(`blocks:${msg.content.length}|`);
    for (const block of msg.content as ApiContentBlock[]) {
      hash.update(block.type);
      hash.update("|");
      if (block.type === "text") hashString(hash, block.text);
      else if (block.type === "image") {
        hashString(hash, block.source.media_type);
        hashString(hash, block.source.data);
      } else if (block.type === "thinking") {
        hashString(hash, block.thinking);
        hashString(hash, block.signature);
      } else if (block.type === "tool_use") {
        hashString(hash, block.id);
        hashString(hash, block.name);
        hashUnknown(hash, block.input);
      } else if (block.type === "tool_result") {
        hashString(hash, block.tool_use_id);
        hashUnknown(hash, block.content);
        hashString(hash, String(block.is_error ?? false));
      }
    }
  }

  hashProviderReasoning(hash, msg.providerData);
  return hash.digest("hex").slice(0, 24);
}

export function validContextTokenAttribution(
  msg: Pick<StoredMessage, "role" | "content" | "metadata" | "providerData" | "contextTokens">,
  provider: ProviderId,
  model: ModelId,
): MessageContextTokenAttribution | null {
  const attr = msg.contextTokens;
  if (!attr || attr.version !== 1) return null;
  if (attr.provider !== provider || attr.model !== model) return null;
  if (attr.signature !== contextMessageSignature(msg)) return null;
  return attr;
}

function scaleBreakdown(chars: ContextTokenBreakdown, totalChars: number, totalTokens: number): ContextTokenBreakdown {
  const out = emptyContextTokenBreakdown();
  if (totalChars <= 0 || totalTokens <= 0) return out;
  for (const key of BREAKDOWN_KEYS) out[key] = Math.max(0, Math.round((chars[key] / totalChars) * totalTokens));
  return out;
}

export function annotateApiMessagesContextTokens(
  messages: ApiMessage[],
  totalInputTokens: number,
  provider: ProviderId,
  model: ModelId,
  now = Date.now(),
): void {
  if (!Number.isFinite(totalInputTokens) || totalInputTokens <= 0) return;
  const breakdowns = messages.map((msg) => contextMessageCharBreakdown(msg as StoredMessage, provider));
  const totalChars = breakdowns.reduce((sum, breakdown) => sum + sumContextTokenBreakdown(breakdown), 0);
  if (totalChars <= 0) return;

  for (let i = 0; i < messages.length; i++) {
    const charBreakdown = breakdowns[i];
    const chars = sumContextTokenBreakdown(charBreakdown);
    const tokenBreakdown = scaleBreakdown(charBreakdown, totalChars, totalInputTokens);
    messages[i].contextTokens = {
      version: 1,
      provider,
      model,
      signature: contextMessageSignature(messages[i] as StoredMessage),
      totalTokens: Math.max(0, Math.round((chars / totalChars) * totalInputTokens)),
      breakdown: tokenBreakdown,
      source: "provider_calibrated",
      updatedAt: now,
    };
  }
}

export function copyContextTokenAttributionsToStoredHistory(storedMessages: StoredMessage[], apiMessages: ApiMessage[]): number {
  let apiIndex = 0;
  let copied = 0;
  for (const stored of storedMessages) {
    if (!isHistoryMessage(stored)) continue;
    const api = apiMessages[apiIndex++];
    if (!api?.contextTokens) continue;
    if (api.role !== stored.role) continue;
    stored.contextTokens = api.contextTokens;
    copied++;
  }
  return copied;
}

export function clearMessageContextTokenAttribution(msg: StoredMessage | ApiMessage): void {
  msg.contextTokens = null;
}
