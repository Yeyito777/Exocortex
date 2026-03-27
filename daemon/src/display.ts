/**
 * Converts stored API messages to TUI-friendly display format.
 *
 * Pure data transformation — no dependencies on tools, registry,
 * or IPC. The summarizer is injected so the data layer doesn't
 * reach into the tool layer.
 */

import type { Block, MessageMetadata, ImageAttachment } from "./messages";
import type { StoredMessage, ApiContentBlock } from "./messages";
import type { ProviderId, ModelId, EffortLevel } from "./messages";
import type { DisplayEntry } from "@exocortex/shared/protocol";

export type { DisplayEntry };

/** Minimal shape for content parts inside tool_result arrays. */
interface ContentPart {
  type: string;
  text?: string;
}

// ── Types ──────────────────────────────────────────────────────────

export interface ConversationDisplayData {
  convId: string;
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  entries: DisplayEntry[];
  contextTokens: number | null;
}

/** Injected function that produces a display summary for a tool call. */
export type ToolSummarizerFn = (name: string, input: Record<string, unknown>) => { label: string; detail: string };

// ── Conversion ─────────────────────────────────────────────────────

export function buildDisplayData(
  convId: string,
  provider: ProviderId,
  model: ModelId,
  effort: EffortLevel,
  messages: StoredMessage[],
  lastContextTokens: number | null,
  summarizer: ToolSummarizerFn,
): ConversationDisplayData {
  const entries: DisplayEntry[] = [];

  let currentAI: { blocks: Block[]; metadata: MessageMetadata | null } | null = null;

  function flushAI(): void {
    if (currentAI) {
      entries.push({ type: "ai", blocks: currentAI.blocks, metadata: currentAI.metadata });
      currentAI = null;
    }
  }

  function extractBlocks(content: string | ApiContentBlock[]): Block[] {
    const blocks: Block[] = [];
    if (typeof content === "string") {
      blocks.push({ type: "text", text: content });
    } else {
      for (const c of content) {
        if (c.type === "text") {
          blocks.push({ type: "text", text: c.text });
        } else if (c.type === "thinking") {
          blocks.push({ type: "thinking", text: c.thinking });
        } else if (c.type === "tool_use") {
          const s = summarizer(c.name, c.input);
          blocks.push({
            type: "tool_call",
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
            summary: s.detail || s.label,
          });
        } else if (c.type === "tool_result") {
          const raw = c.content as string | ContentPart[];
          const output = typeof raw === "string"
            ? raw
            : Array.isArray(raw)
              ? raw.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
              : String(raw ?? "");
          blocks.push({
            type: "tool_result",
            toolCallId: c.tool_use_id,
            toolName: "",
            output,
            isError: c.is_error ?? false,
          });
        }
      }
    }
    return blocks;
  }

  for (const msg of messages) {
    if (msg.role === "system") {
      flushAI();
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const color = text.startsWith("⟳") ? "warning" : "error";
      entries.push({ type: "system", text, color });
      continue;
    }
    if (msg.role === "user") {
      if (typeof msg.content !== "string") {
        const contentArr = msg.content as ApiContentBlock[];
        const hasToolResults = contentArr.some((c) => c.type === "tool_result");
        if (hasToolResults && currentAI) {
          // Pass all blocks through — tool_result blocks render as tool
          // output, and any text blocks (context pressure hints injected
          // by agent.ts) render inline in the AI message.
          currentAI.blocks.push(...extractBlocks(contentArr));
          continue;
        }
        // User message with image blocks — extract text and images separately
        const hasImages = contentArr.some((c) => c.type === "image");
        if (hasImages) {
          flushAI();
          const textParts = contentArr.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
          const text = textParts.join("\n") || "";
          const images: ImageAttachment[] = contentArr
            .filter((c) => c.type === "image")
            .map((c) => {
              const src = (c as { source: { media_type: string; data: string } }).source;
              return {
                mediaType: src.media_type as ImageAttachment["mediaType"],
                base64: src.data,
                sizeBytes: Math.ceil(src.data.length * 3 / 4) - (src.data.match(/=+$/) || [""])[0].length,
              };
            });
          entries.push({ type: "user", text, images: images.length > 0 ? images : undefined });
          continue;
        }
      }
      flushAI();
      entries.push({ type: "user", text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    } else if (msg.role === "assistant") {
      if (currentAI) {
        currentAI.blocks.push(...extractBlocks(msg.content));
        currentAI.metadata = msg.metadata;
      } else {
        currentAI = { blocks: extractBlocks(msg.content), metadata: msg.metadata };
      }
    }
  }
  flushAI();

  return { convId, provider, model, effort, entries, contextTokens: lastContextTokens };
}
