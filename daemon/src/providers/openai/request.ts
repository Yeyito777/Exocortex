import type { ApiMessage, ApiContentBlock, ModelId, EffortLevel } from "../../messages";
import type { StreamOptions } from "../types";
import { buildPromptCacheBodyFields } from "./cache";
import { supportsOpenAIReasoningSummary } from "./capabilities";
import { buildCodexClientMetadata } from "./identity";
import type { OpenAIReasoningItem } from "./types";
import { isValidImagePayload } from "../../image-validation";

export type OpenAIInputItem =
  | { type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { type: "message"; role: "assistant"; content: Array<{ type: "output_text"; text: string }>; id?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null; summary: Array<{ type: "summary_text"; text: string }> };

const OPENAI_REASONING_SUMMARY = "detailed" as const;
const MAX_OPENAI_INPUT_IMAGES = 5;
const OMITTED_OLDER_IMAGE_TEXT = `[Older image omitted from replay; only the latest ${MAX_OPENAI_INPUT_IMAGES} images are sent to OpenAI.]`;

interface OpenAIRequestShape {
  model: ModelId;
  instructions: string;
  tool_choice: string;
  parallel_tool_calls: boolean;
  include: string[];
  reasoning: {
    effort: string;
    summary?: string;
  };
  service_tier?: string;
  tools?: Array<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
  }>;
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

function buildImageInputPart(
  mediaType: string,
  base64: string,
  imageLimiter?: ImageReplayLimiter,
): { type: "input_image"; image_url: string } | { type: "input_text"; text: string } {
  if (isValidImagePayload(mediaType, base64)) {
    if (imageLimiter && !shouldSendNextValidImage(imageLimiter)) {
      return { type: "input_text", text: OMITTED_OLDER_IMAGE_TEXT };
    }
    return { type: "input_image", image_url: encodeImage(mediaType, base64) };
  }
  return { type: "input_text", text: `[Invalid ${mediaType || "image"} attachment omitted before sending to OpenAI.]` };
}

interface ImageReplayLimiter {
  firstIncludedImageIndex: number;
  seenValidImages: number;
}

function countValidReplayImages(messages: ApiMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image") {
        if (isValidImagePayload(block.source.media_type, block.source.data)) count += 1;
      } else if (block.type === "tool_result") {
        count += extractToolResultImages(block.content).length;
      }
    }
  }
  return count;
}

function createImageReplayLimiter(messages: ApiMessage[]): ImageReplayLimiter {
  const validImageCount = countValidReplayImages(messages);
  return {
    firstIncludedImageIndex: Math.max(0, validImageCount - MAX_OPENAI_INPUT_IMAGES),
    seenValidImages: 0,
  };
}

function shouldSendNextValidImage(limiter: ImageReplayLimiter): boolean {
  const shouldSend = limiter.seenValidImages >= limiter.firstIncludedImageIndex;
  limiter.seenValidImages += 1;
  return shouldSend;
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

export function buildOpenAIInput(messages: ApiMessage[]): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = [];
  const imageLimiter = createImageReplayLimiter(messages);

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        input.push({
          type: "message",
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

          const images = extractToolResultImages(result.content)
            .filter(() => shouldSendNextValidImage(imageLimiter));
          if (images.length > 0) {
            input.push({
              type: "message",
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
            type: "message",
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
          parts.push(buildImageInputPart(block.source.media_type, block.source.data, imageLimiter));
        }
      }
      if (parts.length > 0) {
        input.push({ type: "message", role: "user", content: parts });
      }
      continue;
    }

    const providerData = message.providerData?.openai;
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
        type: "message",
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

function mapServiceTier(serviceTier: StreamOptions["serviceTier"]): string | undefined {
  switch (serviceTier) {
    // OpenAI's Codex backend expects the fast tier under the wire value
    // `priority`, even though the app-level setting is exposed as `fast`.
    case "fast":
      return "priority";
    default:
      return undefined;
  }
}

function shouldRequestReasoningSummary(model: ModelId): boolean {
  return supportsOpenAIReasoningSummary(model);
}

function buildRequestShape(model: ModelId, options: StreamOptions): OpenAIRequestShape {
  const tools = buildOpenAITools(options.tools);
  const serviceTier = mapServiceTier(options.serviceTier);
  const effort = mapEffort(options.effort);
  return {
    model,
    instructions: options.system || "You are a helpful assistant.",
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: effort === "none" ? [] : ["reasoning.encrypted_content"],
    reasoning: {
      effort,
      // Always request the fullest summary OpenAI exposes when the selected
      // model accepts that parameter. Codex Spark rejects `reasoning.summary`
      // with a 400, so omit it there and fall back to whatever reasoning data
      // the backend emits by default.
      ...(effort !== "none" && shouldRequestReasoningSummary(model) ? { summary: OPENAI_REASONING_SUMMARY } : {}),
    },
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(tools ? { tools } : {}),
  };
}

export function buildRequestBody(
  messages: ApiMessage[],
  model: ModelId,
  options: StreamOptions,
): Record<string, unknown> {
  const input = buildOpenAIInput(messages);
  const shape = buildRequestShape(model, options);
  // Build the canonical full replay body. A turn-scoped websocket session may
  // transform this into a Codex-style incremental request with
  // previous_response_id at send time, while keeping this full body as the
  // correctness fallback for reconnects, compaction, or mismatched history.
  return {
    ...shape,
    input,
    client_metadata: buildCodexClientMetadata(options.promptCacheKey),
    stream: true,
    store: false,
    ...buildPromptCacheBodyFields(options),
  };
}
