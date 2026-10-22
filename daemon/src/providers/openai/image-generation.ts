/**
 * Image generation for the `image` external tool, made with the daemon's own
 * OpenAI login (GenerateImageCommand). The tool asks over the daemon socket,
 * so the access token never reaches a shell, argv or a tool process.
 */
import { getVerifiedSession } from "./auth";
import { CHATGPT_BASE_URL, OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { buildOpenAIHeaders } from "./http";
import { proxiedProviderUrl } from "../../provider-proxy/route";
import { latestSizeModel } from "../../delegation-models";
import { getProvider } from "../registry";
import { log } from "../../log";

// The image_generation tool runs on any Codex chat model; the chat model only
// relays the prompt, so prefer the newest of the cheapest sizes. Resolved
// from the live catalog because Codex retires old slugs (gpt-5.4-mini did).
const IMAGE_GENERATION_SIZES = ["luna", "terra", "sol"] as const;
const IMAGE_GENERATION_FALLBACK_MODEL = "gpt-6-luna";
const IMAGE_GENERATION_INSTRUCTIONS = "Call the image generation tool EXACTLY according to the user's request. No interpretation no adding things copy the user request word for word.";
const IMAGE_GENERATION_STALL_TIMEOUT_MS = 180_000;

export interface GeneratedImage {
  imageBase64: string;
  revisedPrompt: string | null;
}

export interface ImageGenerationSession {
  accessToken: string;
  accountId: string | null;
}

interface ResponseItem {
  type?: unknown;
  revised_prompt?: unknown;
  result?: unknown;
}

function imageFromItem(item: ResponseItem): GeneratedImage {
  if (typeof item.result !== "string" || item.result.trim() === "") {
    throw new Error("OpenAI image generation returned empty image data");
  }
  return {
    imageBase64: item.result,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
  };
}

function isImageItem(value: unknown): value is ResponseItem {
  return !!value && typeof value === "object" && (value as ResponseItem).type === "image_generation_call";
}

function imageFromEvent(event: Record<string, unknown>): GeneratedImage | null {
  if (event.type === "response.output_item.done" && isImageItem(event.item)) return imageFromItem(event.item);
  if (event.type === "response.completed" || event.type === "response.incomplete") {
    const output = (event.response as { output?: unknown } | undefined)?.output;
    const item = Array.isArray(output) ? output.find(isImageItem) : undefined;
    if (item) return imageFromItem(item);
  }
  return null;
}

function parseEvents(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const piece of chunk.split("\n\n")) {
    const data = piece.split("\n").map(line => line.trim()).filter(line => line.startsWith("data: "))
      .map(line => line.slice(6)).join("\n");
    if (!data || data === "[DONE]") continue;
    try { events.push(JSON.parse(data) as Record<string, unknown>); } catch { /* ignore malformed fragments */ }
  }
  return events;
}

async function readStream(res: Response, stallTimeoutMs: number, signal?: AbortSignal): Promise<GeneratedImage> {
  if (!res.body) throw new Error("OpenAI image generation returned no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generated: GeneratedImage | null = null;
  try {
    while (true) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          stallTimer = setTimeout(() => reject(new Error(`OpenAI image generation sent no data for ${stallTimeoutMs / 1000}s`)), stallTimeoutMs);
        }),
      ]).finally(() => clearTimeout(stallTimer));
      if (done) break;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary === -1) continue;
      for (const event of parseEvents(buffer.slice(0, boundary))) generated = imageFromEvent(event) ?? generated;
      buffer = buffer.slice(boundary + 2);
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  for (const event of parseEvents(buffer)) generated = imageFromEvent(event) ?? generated;
  if (!generated) throw new Error("OpenAI image generation finished without an image");
  return generated;
}

/** Candidate models in preference order: newest luna, then terra, then sol. */
export function imageGenerationModels(catalog: readonly string[]): string[] {
  const models = IMAGE_GENERATION_SIZES.map(size => latestSizeModel(size, catalog))
    .filter((model): model is string => model !== undefined);
  return models.length > 0 ? models : [IMAGE_GENERATION_FALLBACK_MODEL];
}

/** A 400 that names the model means this slug is not accepted; try the next. */
function isModelRejection(status: number, body: string): boolean {
  return status === 400 && /model/i.test(body);
}

export async function generateImageWithSession(
  session: ImageGenerationSession,
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; stallTimeoutMs?: number; models?: readonly string[] } = {},
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new Error("Image prompt is empty");
  const models = options.models?.length ? options.models : [IMAGE_GENERATION_FALLBACK_MODEL];
  for (const [index, model] of models.entries()) {
    const res = await requestImage(session, model, prompt, options);
    if (res.ok) return readStream(res, options.stallTimeoutMs ?? IMAGE_GENERATION_STALL_TIMEOUT_MS, options.signal);
    const text = await res.text();
    if (index < models.length - 1 && isModelRejection(res.status, text)) {
      log("warn", `image generation: ${model} rejected (${res.status}), trying ${models[index + 1]}`);
      continue;
    }
    throw new Error(`OpenAI image generation with ${model} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  throw new Error("OpenAI image generation has no model to use");
}

async function requestImage(
  session: ImageGenerationSession,
  model: string,
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<Response> {
  const headers = buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  if (session.accountId) headers["ChatGPT-Account-ID"] = session.accountId;
  return (options.fetchImpl ?? fetch)(proxiedProviderUrl("openai", OPENAI_CODEX_RESPONSES_URL, CHATGPT_BASE_URL), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions: IMAGE_GENERATION_INSTRUCTIONS,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      tools: [{ type: "image_generation" }],
      stream: true,
      store: false,
    }),
    signal: options.signal,
  });
}

export async function generateImage(prompt: string, options: { signal?: AbortSignal } = {}): Promise<GeneratedImage> {
  const catalog = getProvider("openai")?.models.map(model => model.id) ?? [];
  return generateImageWithSession(await getVerifiedSession({ chatgptOnly: true }), prompt, { ...options, models: imageGenerationModels(catalog) });
}
