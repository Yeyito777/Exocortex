/**
 * Image generation for the `image` external tool, made with the daemon's own
 * OpenAI login (GenerateImageCommand). The tool asks over the daemon socket,
 * so the access token never reaches a shell, argv or a tool process.
 */
import { getVerifiedSession, type VerifiedOpenAISession } from "./auth";
import { CHATGPT_BASE_URL, OPENAI_API_IMAGE_GENERATIONS_URL, OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { AuthError } from "../errors";
import { loadOpenAIApiKey } from "./api-key";
import { recordApiKeyUsage } from "./api-key-usage";
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

// ── API key: /v1/images/generations ────────────────────────────────

/** Best first: GPT Image 2.5 Sunburst is the quality variant, Flare the faster one. */
const API_IMAGE_MODELS = [
  "gpt-image-2.5-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
const API_IMAGE_TIMEOUT_MS = 300_000;

/** Image models the key lists, best first; the best known one when the list is unknown. */
export function apiImageModels(available: readonly string[]): string[] {
  const listed = API_IMAGE_MODELS.filter((model) => available.includes(model));
  return listed.length > 0 ? listed : [API_IMAGE_MODELS[0]];
}

interface ApiImageResponse {
  data?: Array<{ b64_json?: unknown; revised_prompt?: unknown }>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** A model the key cannot use (unknown, or the organization is not verified for it): try the next. */
function isApiImageModelRejection(status: number, body: string): boolean {
  return (status === 400 || status === 403 || status === 404) && /model|verif/i.test(body);
}

export async function generateImageWithApiKey(
  session: Pick<VerifiedOpenAISession, "accessToken" | "accountKey">,
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; models?: readonly string[] } = {},
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new Error("Image prompt is empty");
  const models = options.models?.length ? options.models : [API_IMAGE_MODELS[0]];
  const timeout = AbortSignal.timeout(API_IMAGE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  for (const [index, model] of models.entries()) {
    const res = await (options.fetchImpl ?? fetch)(OPENAI_API_IMAGE_GENERATIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model, prompt, n: 1 }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new AuthError("The OpenAI API key was rejected (HTTP 401). Log in again with `/login openai key <api-key>`.");
      if (index < models.length - 1 && isApiImageModelRejection(res.status, text)) {
        log("warn", `image generation: ${model} rejected (${res.status}), trying ${models[index + 1]}`);
        continue;
      }
      throw new Error(`OpenAI image generation with ${model} failed (${res.status}): ${text.slice(0, 500)}`);
    }
    let data: ApiImageResponse;
    try {
      data = JSON.parse(text) as ApiImageResponse;
    } catch {
      throw new Error(`OpenAI image generation with ${model} returned non-JSON: ${text.slice(0, 200)}`);
    }
    recordApiKeyUsage(session.accountKey, {
      model,
      inputTokens: typeof data.usage?.input_tokens === "number" ? data.usage.input_tokens : 0,
      outputTokens: typeof data.usage?.output_tokens === "number" ? data.usage.output_tokens : 0,
    });
    const image = data.data?.[0];
    if (typeof image?.b64_json !== "string" || image.b64_json.trim() === "") {
      throw new Error("OpenAI image generation returned empty image data");
    }
    return {
      imageBase64: image.b64_json,
      revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt : null,
    };
  }
  throw new Error("OpenAI image generation has no model to use");
}

/**
 * Generate with the login requests use: the ChatGPT account's image tool, or
 * the public Images API when OpenAI runs on an API key (logged in with one,
 * or the ChatGPT session expired).
 */
export async function generateImage(prompt: string, options: { signal?: AbortSignal } = {}): Promise<GeneratedImage> {
  const session = await getVerifiedSession();
  if (session.kind === "api_key") {
    return generateImageWithApiKey(session, prompt, { ...options, models: apiImageModels(loadOpenAIApiKey()?.models ?? []) });
  }
  const catalog = getProvider("openai")?.models.map(model => model.id) ?? [];
  return generateImageWithSession(session, prompt, { ...options, models: imageGenerationModels(catalog) });
}
