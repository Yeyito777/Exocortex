import type { ApiMessage, ApiContentBlock, ModelId, EffortLevel } from "../../messages";
import type { StreamOptions } from "../types";
import { buildPromptCacheBodyFields } from "./cache";
import {
  defaultOpenAIVerbosity,
  openAIUltraReasoningEffortForRequest,
  supportsOpenAIFastServiceTier,
  supportsOpenAIMaxReasoningEffort,
  supportsOpenAIReasoningSummary,
  supportsOpenAIUltraReasoningEffort,
  usesOpenAIResponsesLite,
} from "./capabilities";
import { OPENAI_RESPONSES_LITE_WS_METADATA_KEY } from "./constants";
import { buildCodexClientMetadata } from "./identity";
import type { OpenAIReasoningItem } from "./types";
import { isValidImagePayload } from "../../image-validation";

export type OpenAIInputItem =
  | { type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { type: "message"; role: "assistant"; content: Array<{ type: "output_text"; text: string }>; id?: string }
  | { type: "message"; role: "developer"; content: Array<{ type: "input_text"; text: string }> }
  | { type: "additional_tools"; role: "developer"; tools: OpenAIResponsesLiteTool[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null; summary: Array<{ type: "summary_text"; text: string }> }
  | { type: "compaction"; id?: string; encrypted_content: string; internal_chat_message_metadata_passthrough?: unknown }
  | { type: "compaction_trigger" };

const OPENAI_REASONING_SUMMARY = "detailed" as const;
const OPENAI_ULTRA_MULTI_AGENT_INSTRUCTION = "<multi_agent_mode>Proactive multi-agent delegation is active.</multi_agent_mode>";
const MAX_OPENAI_INPUT_IMAGES = 5;
const OMITTED_OLDER_IMAGE_TEXT = `[Older image omitted from replay; only the latest ${MAX_OPENAI_INPUT_IMAGES} images are sent to OpenAI.]`;

interface OpenAIRequestShape {
  model: ModelId;
  instructions?: string;
  tool_choice: string;
  parallel_tool_calls: boolean;
  include: string[];
  reasoning: {
    effort: string;
    summary?: string;
    context?: "all_turns";
  };
  text?: { verbosity: "low" | "medium" | "high" };
  service_tier?: string;
  tools?: Array<{
    type: string;
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict: boolean;
  }>;
}

interface OpenAIResponsesLiteFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

interface OpenAIResponsesLiteNamespaceTool {
  type: "namespace";
  name: "functions";
  description: "";
  tools: OpenAIResponsesLiteFunctionTool[];
}

type OpenAIResponsesLiteTool = OpenAIResponsesLiteNamespaceTool;

function mapEffort(effort: EffortLevel | undefined, model: ModelId): string {
  switch (effort) {
    case "none": return "none";
    case "minimal": return "minimal";
    case "low": return "low";
    case "medium": return "medium";
    case "xhigh": return "xhigh";
    // Codex exposes Ultra as a client-side automatic-delegation mode. The
    // underlying wire effort is model metadata: Astra uses xhigh, while the
    // GPT-5.6 tiers use max.
    case "ultra": return openAIUltraReasoningEffortForRequest(model);
    case "max": return supportsOpenAIMaxReasoningEffort(model) ? "max" : "xhigh";
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
    for (const compaction of providerData?.compactionItems ?? []) {
      input.push({
        type: "compaction",
        // Keep response item IDs in local checkpoint state, but do not send them
        // with store:false/item_ids disabled (matching Codex's request cleanup).
        encrypted_content: compaction.encryptedContent,
        ...(compaction.internalChatMessageMetadataPassthrough !== undefined
          ? { internal_chat_message_metadata_passthrough: compaction.internalChatMessageMetadataPassthrough }
          : {}),
      });
    }
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

function buildResponsesLiteTools(tools: StreamOptions["tools"]): OpenAIResponsesLiteTool[] {
  if (!tools || tools.length === 0) return [];
  const functions = (tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
    strict: false,
  }));
  return [{
    type: "namespace",
    name: "functions",
    description: "",
    tools: functions,
  }];
}

function prependResponsesLiteContext(
  input: OpenAIInputItem[],
  system: string | undefined,
  tools: StreamOptions["tools"],
): void {
  const prefix: OpenAIInputItem[] = [];
  const additionalTools = buildResponsesLiteTools(tools);
  if (additionalTools.length > 0) {
    prefix.push({ type: "additional_tools", role: "developer", tools: additionalTools });
  }
  if (system) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: system }],
    });
  }
  input.unshift(...prefix);
}

function mapServiceTier(serviceTier: StreamOptions["serviceTier"], model: ModelId): string | undefined {
  if (!supportsOpenAIFastServiceTier(model)) return undefined;
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

function requestInstructions(model: ModelId, options: StreamOptions): string {
  const base = options.system || "You are a helpful assistant.";
  if (!supportsOpenAIUltraReasoningEffort(model) || options.effort !== "ultra") return base;
  return `${base}\n\n${OPENAI_ULTRA_MULTI_AGENT_INSTRUCTION}`;
}

function buildRequestShape(model: ModelId, options: StreamOptions): OpenAIRequestShape {
  const responsesLite = usesOpenAIResponsesLite(model);
  const tools = responsesLite ? undefined : buildOpenAITools(options.tools);
  const serviceTier = mapServiceTier(options.serviceTier, model);
  const effort = mapEffort(options.effort, model);
  const verbosity = defaultOpenAIVerbosity(model);
  return {
    model,
    ...(responsesLite ? {} : { instructions: requestInstructions(model, options) }),
    tool_choice: "auto",
    parallel_tool_calls: !responsesLite,
    include: effort === "none" ? [] : ["reasoning.encrypted_content"],
    reasoning: {
      effort,
      // Always request the fullest summary OpenAI exposes when the selected
      // model accepts that parameter. Codex Spark rejects `reasoning.summary`
      // with a 400, so omit it there and fall back to whatever reasoning data
      // the backend emits by default.
      ...(effort !== "none" && shouldRequestReasoningSummary(model) ? { summary: OPENAI_REASONING_SUMMARY } : {}),
      ...(responsesLite ? { context: "all_turns" as const } : {}),
    },
    ...(verbosity ? { text: { verbosity } } : {}),
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
  if (usesOpenAIResponsesLite(model)) {
    prependResponsesLiteContext(input, requestInstructions(model, options), options.tools);
  }
  if (options.compaction) input.push({ type: "compaction_trigger" });
  const shape = buildRequestShape(model, options);
  const clientMetadata = buildCodexClientMetadata(
    options.promptCacheKey,
    options.codexWindowId,
    options.compaction ? options.compactionMetadata ?? {} : undefined,
    options.codexTurnId,
    options.codexTurnStartedAtMs,
  );
  if (usesOpenAIResponsesLite(model)) {
    clientMetadata[OPENAI_RESPONSES_LITE_WS_METADATA_KEY] = "true";
  }
  // Build the canonical full replay body. A turn-scoped websocket session may
  // transform this into a Codex-style incremental request with
  // previous_response_id at send time, while keeping this full body as the
  // correctness fallback for reconnects, compaction, or mismatched history.
  return {
    ...shape,
    input,
    client_metadata: clientMetadata,
    stream: true,
    store: false,
    ...buildPromptCacheBodyFields(options),
  };
}
