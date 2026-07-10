/**
 * Converts stored API messages to TUI-friendly display format.
 *
 * Pure data transformation — no dependencies on tools, registry,
 * or IPC. The summarizer is injected so the data layer doesn't
 * reach into the tool layer.
 */

import { CONTEXT_COMPACTION_FINISHED_KIND, combineMessageMetadata, type Block, type MessageMetadata, type ImageAttachment } from "./messages";
import { isModelVisibleSystemNotice, isReplayHistoryMessage, type StoredMessage, type ApiContentBlock } from "./messages";
import type { ProviderId, ModelId, EffortLevel } from "./messages";
import type { DisplayEntry, ToolOutputInfo } from "@exocortex/shared/protocol";

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
  fastMode: boolean;
  entries: DisplayEntry[];
  contextTokens: number | null;
  toolOutputsIncluded: boolean;
}

export interface BuildDisplayOptions {
  includeToolOutputs?: boolean;
  /** First replay-history cursor whose user message may be unwound; null locks all. */
  editableUserHistoryStart?: number | null;
}

/** Injected function that produces a display summary for a tool call. */
export type ToolSummarizerFn = (name: string, input: Record<string, unknown>) => { label: string; detail: string };

function stringifyToolResultContent(raw: string | ContentPart[]): string {
  return typeof raw === "string"
    ? raw
    : Array.isArray(raw)
      ? raw.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n")
      : String(raw ?? "");
}

export function collectToolOutputs(messages: StoredMessage[]): ToolOutputInfo[] {
  const outputs: ToolOutputInfo[] = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type !== "tool_result") continue;
      outputs.push({
        toolCallId: part.tool_use_id,
        output: stringifyToolResultContent(part.content as string | ContentPart[]),
      });
    }
  }
  return outputs;
}

// ── Conversion ─────────────────────────────────────────────────────

export function buildDisplayData(
  convId: string,
  provider: ProviderId,
  model: ModelId,
  effort: EffortLevel,
  fastMode: boolean,
  messages: StoredMessage[],
  lastContextTokens: number | null,
  summarizer: ToolSummarizerFn,
  options?: BuildDisplayOptions,
): ConversationDisplayData {
  const includeToolOutputs = options?.includeToolOutputs ?? true;
  const entries: DisplayEntry[] = [];
  let replayHistoryCount = 0;

  let currentAI: { blocks: Block[]; metadata: MessageMetadata | null; canMergeNextAssistant: boolean } | null = null;

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
          blocks.push({
            type: "tool_result",
            toolCallId: c.tool_use_id,
            toolName: "",
            output: includeToolOutputs ? stringifyToolResultContent(c.content as string | ContentPart[]) : "",
            isError: c.is_error ?? false,
          });
        }
      }
    }
    return blocks;
  }

  for (const msg of messages) {
    const historyCountBeforeMessage = replayHistoryCount;
    if (isReplayHistoryMessage(msg)) replayHistoryCount++;
    if (msg.role === "system_instructions") {
      flushAI();
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      entries.push({ type: "system_instructions", text });
      continue;
    }
    if (msg.role === "system") {
      flushAI();
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const isCompactionFinished = msg.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND;
      const color = isCompactionFinished
        ? "muted"
        : text.startsWith("⟳") || text.startsWith("OpenAI usage limit reached") ? "warning" : "error";
      entries.push({
        type: "system",
        text,
        color,
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
      });
      continue;
    }
    if (isModelVisibleSystemNotice(msg)) {
      flushAI();
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c) => c.type === "text")
            .map((c) => (c as { type: "text"; text: string }).text)
            .join("\n") || JSON.stringify(msg.content);
      entries.push({ type: "system", text });
      continue;
    }
    if (msg.role === "user") {
      if (typeof msg.content !== "string") {
        const contentArr = msg.content as ApiContentBlock[];
        const hasToolResults = contentArr.some((c) => c.type === "tool_result");
        if (hasToolResults) {
          // Tool-result messages are API-internal containers, never
          // user-authored prompts. Usually they directly follow an assistant
          // tool_use and fold into the open AI entry, but retry/system notices
          // can flush currentAI between tool_use and tool_result. In that case
          // start a new AI entry instead of rendering raw JSON as a user bubble.
          const blocks = extractBlocks(contentArr);
          if (currentAI) {
            currentAI.blocks.push(...blocks);
            currentAI.canMergeNextAssistant = true;
          } else {
            currentAI = { blocks, metadata: msg.metadata, canMergeNextAssistant: true };
          }
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
          entries.push({
            type: "user",
            text,
            images: images.length > 0 ? images : undefined,
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...userContextCheckpoint(msg, historyCountBeforeMessage, options),
          });
          continue;
        }
      }
      flushAI();
      entries.push({
        type: "user",
        text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        ...(msg.metadata ? { metadata: msg.metadata } : {}),
        ...userContextCheckpoint(msg, historyCountBeforeMessage, options),
      });
    } else if (msg.role === "assistant") {
      if (currentAI?.canMergeNextAssistant) {
        currentAI.blocks.push(...extractBlocks(msg.content));
        currentAI.metadata = combineMessageMetadata(currentAI.metadata, msg.metadata);
        currentAI.canMergeNextAssistant = false;
      } else {
        flushAI();
        currentAI = { blocks: extractBlocks(msg.content), metadata: msg.metadata, canMergeNextAssistant: false };
      }
    }
  }
  flushAI();

  return {
    convId,
    provider,
    model,
    effort,
    fastMode,
    entries,
    contextTokens: lastContextTokens,
    toolOutputsIncluded: includeToolOutputs,
  };
}

function userContextCheckpoint(
  message: StoredMessage,
  historyCountBeforeMessage: number,
  options: BuildDisplayOptions | undefined,
): Pick<Extract<DisplayEntry, { type: "user" }>, "contextCheckpoint"> | Record<string, never> {
  const editableStart = options?.editableUserHistoryStart;
  // Direct data-transform callers that do not provide conversation compaction
  // state keep the legacy wire shape unless the message has a stored snapshot.
  if (editableStart === undefined && !message.contextCheckpoint) return {};
  return {
    contextCheckpoint: {
      editable: editableStart === undefined
        ? message.contextCheckpoint?.windowId == null
        : editableStart != null && historyCountBeforeMessage >= editableStart,
      contextTokens: message.contextCheckpoint?.contextTokens ?? null,
    },
  };
}
