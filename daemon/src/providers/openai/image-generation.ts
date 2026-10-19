/**
 * Image generation for the `image` external tool, made with the daemon's own
 * OpenAI login (GenerateImageCommand). The tool asks over the daemon socket,
 * so the access token never reaches a shell, argv or a tool process.
 */
import { getVerifiedSession } from "./auth";
import { CHATGPT_BASE_URL, OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { buildOpenAIHeaders } from "./http";
import { proxiedProviderUrl } from "../../provider-proxy/route";

const IMAGE_GENERATION_MODEL = "gpt-5.4-mini";
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

export async function generateImageWithSession(
  session: ImageGenerationSession,
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; stallTimeoutMs?: number } = {},
): Promise<GeneratedImage> {
  if (!prompt.trim()) throw new Error("Image prompt is empty");
  const headers = buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  if (session.accountId) headers["ChatGPT-Account-ID"] = session.accountId;
  const res = await (options.fetchImpl ?? fetch)(proxiedProviderUrl("openai", OPENAI_CODEX_RESPONSES_URL, CHATGPT_BASE_URL), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: IMAGE_GENERATION_MODEL,
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image generation failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return readStream(res, options.stallTimeoutMs ?? IMAGE_GENERATION_STALL_TIMEOUT_MS, options.signal);
}

export async function generateImage(prompt: string, options: { signal?: AbortSignal } = {}): Promise<GeneratedImage> {
  return generateImageWithSession(await getVerifiedSession(), prompt, options);
}
