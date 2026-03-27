import type { ApiMessage, ApiContentBlock, ModelId, EffortLevel } from "../../messages";
import { createAbortError, isAbortLikeError } from "../../abort";
import { getVerifiedSession, AuthError } from "./auth";
import { OPENAI_CODEX_RESPONSES_URL, OPENAI_ORIGINATOR } from "./constants";
import { mergeReasoningSummaries } from "./reasoning";
import { readOpenAIEventsForTest, readOpenAIStream } from "./stream";
import type { OpenAIAssistantProviderData } from "./types";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";

export { AuthError, mergeReasoningSummaries as mergeReasoningSummariesForTest, readOpenAIEventsForTest };

const STREAM_STALL_TIMEOUT = 120_000;
const MAX_RETRIES = 8;

type OpenAIInputItem =
  | { role: "user"; content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }>; id?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "reasoning"; id: string; encrypted_content?: string | null; summary: Array<{ type: "summary_text"; text: string }> };

function retryBackoff(
  attempt: number,
  errMsg: string,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
  const delaySec = Math.round(delay / 1000);
  callbacks.onRetry?.(attempt + 1, MAX_RETRIES, errMsg, delaySec);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
    .map((part) => ({ mediaType: part.source!.media_type!, base64: part.source!.data! }));
}

function buildOpenAIInput(messages: ApiMessage[]): OpenAIInputItem[] {
  const input: OpenAIInputItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        input.push({
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

          const images = extractToolResultImages(result.content);
          if (images.length > 0) {
            input.push({
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
          parts.push({
            type: "input_image",
            image_url: encodeImage(block.source.media_type, block.source.data),
          });
        }
      }
      if (parts.length > 0) {
        input.push({ role: "user", content: parts });
      }
      continue;
    }

    const providerData = (message.providerData as OpenAIAssistantProviderData | undefined)?.openai;
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

export function buildOpenAIInputForTest(messages: ApiMessage[]): unknown[] {
  return buildOpenAIInput(messages);
}

export function buildRequestBodyForTest(
  messages: ApiMessage[],
  model: ModelId,
  _maxTokens: number,
  options: StreamOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    input: buildOpenAIInput(messages),
    stream: true,
    store: false,
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: mapEffort(options.effort),
      summary: "concise",
    },
    instructions: options.system || "You are a helpful assistant.",
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = (options.tools as Array<{ name: string; description: string; input_schema: Record<string, unknown> }>).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      strict: false,
    }));
  }

  return body;
}

/**
 * Core OpenAI transport loop once auth has already been resolved.
 *
 * Kept separate from streamMessage() so tests can exercise retry/abort
 * behavior without depending on auth state.
 */
export async function streamMessageWithSession(
  session: { accessToken: string; accountId: string | null },
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { maxTokens = 32000, signal } = options;
  let retryAttempt = 0;

  while (true) {
    let res: Response;
    try {
      res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          originator: OPENAI_ORIGINATOR,
          "User-Agent": "exocortexd/openai",
          ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
        },
        body: JSON.stringify(buildRequestBodyForTest(messages, model, maxTokens, options)),
        signal,
      });
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal);
        continue;
      }
      throw err;
    }

    if (res.status === 401) {
      throw new AuthError("OpenAI authentication failed. Re-run `bun run src/main.ts login openai`.");
    }

    if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, `HTTP ${res.status}`, callbacks, signal);
        continue;
      }
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}) after ${MAX_RETRIES} retries: ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI API error (${res.status}): ${text}`);
    }

    callbacks.onHeaders?.(res.headers);
    try {
      return await readOpenAIStream(res, callbacks, STREAM_STALL_TIMEOUT);
    } catch (err) {
      if (signal?.aborted || isAbortLikeError(err)) throw err;
      if (retryAttempt < MAX_RETRIES) {
        await retryBackoff(retryAttempt++, err instanceof Error ? err.message : String(err), callbacks, signal);
        continue;
      }
      throw err;
    }
  }
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const session = await getVerifiedSession();
  return streamMessageWithSession(session, messages, model, callbacks, options);
}
