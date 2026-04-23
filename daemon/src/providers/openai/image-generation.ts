import { getVerifiedSession } from "./auth";
import { OPENAI_CODEX_RESPONSES_URL } from "./constants";
import { buildOpenAIHeaders } from "./http";

const OPENAI_IMAGE_GENERATION_MODEL = "gpt-5.4-mini";
const IMAGE_GENERATION_INSTRUCTIONS = "Call the image generation tool EXACTLY according to the user's request. No interpretation no adding things copy the user request word for word.";
const IMAGE_GENERATION_STALL_TIMEOUT_MS = 180_000;

interface OpenAIImageGenerationResponseItem {
  type?: unknown;
  id?: unknown;
  status?: unknown;
  revised_prompt?: unknown;
  result?: unknown;
}

interface OpenAIImageGenerationResponse {
  output?: unknown;
}

export interface OpenAIImageGenerationSession {
  accessToken: string;
  accountId: string | null;
}

export interface OpenAIGeneratedImage {
  id: string | null;
  status: string | null;
  revisedPrompt: string | null;
  base64: string;
}

function buildHeaders(session: OpenAIImageGenerationSession): Record<string, string> {
  return {
    ...buildOpenAIHeaders({
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    }),
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
  };
}

export function buildImageGenerationRequestBody(prompt: string): Record<string, unknown> {
  return {
    model: OPENAI_IMAGE_GENERATION_MODEL,
    instructions: IMAGE_GENERATION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    tools: [{ type: "image_generation" }],
    stream: true,
    store: false,
  };
}

function extractImageGenerationItem(data: OpenAIImageGenerationResponse): OpenAIGeneratedImage {
  const output = Array.isArray(data.output) ? data.output as OpenAIImageGenerationResponseItem[] : [];
  const item = output.find((candidate) => candidate?.type === "image_generation_call");
  if (!item) {
    throw new Error("OpenAI image generation returned no image_generation_call item");
  }
  if (typeof item.result !== "string" || item.result.trim() === "") {
    throw new Error("OpenAI image generation returned empty image data");
  }

  return {
    id: typeof item.id === "string" ? item.id : null,
    status: typeof item.status === "string" ? item.status : null,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
    base64: item.result,
  };
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const pieces = chunk.split("\n\n");
  for (const piece of pieces) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.slice(6)).join("\n");
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

function extractImageFromEvent(event: Record<string, unknown>): OpenAIGeneratedImage | null {
  if (event.type === "response.output_item.done") {
    const item = event.item;
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "image_generation_call") {
      return extractImageGenerationItem({ output: [item] });
    }
  }

  if (event.type === "response.completed" || event.type === "response.incomplete") {
    const response = event.response;
    if (response && typeof response === "object") {
      const output = (response as OpenAIImageGenerationResponse).output;
      if (Array.isArray(output) && output.some((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "image_generation_call")) {
        return extractImageGenerationItem(response as OpenAIImageGenerationResponse);
      }
    }
  }

  return null;
}

async function readImageGenerationStream(res: Response, stallTimeoutMs: number): Promise<OpenAIGeneratedImage> {
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let generated: OpenAIGeneratedImage | null = null;

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(
          () => reject(new Error(`No data for ${stallTimeoutMs / 1000}s`)),
          stallTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) continue;
    const ready = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseEventData(ready)) {
      generated = extractImageFromEvent(event) ?? generated;
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer)) {
      generated = extractImageFromEvent(event) ?? generated;
    }
  }

  if (!generated) {
    throw new Error("OpenAI image generation stream completed without an image_generation_call item");
  }

  return generated;
}

export async function generateImageWithSession(
  session: OpenAIImageGenerationSession,
  prompt: string,
  signal?: AbortSignal,
): Promise<OpenAIGeneratedImage> {
  const res = await fetch(OPENAI_CODEX_RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(session),
    body: JSON.stringify(buildImageGenerationRequestBody(prompt)),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI image generation failed (${res.status}): ${text.slice(0, 500)}`);
  }

  return readImageGenerationStream(res, IMAGE_GENERATION_STALL_TIMEOUT_MS);
}

export async function generateImage(
  prompt: string,
  signal?: AbortSignal,
): Promise<OpenAIGeneratedImage> {
  const session = await getVerifiedSession();
  return generateImageWithSession(session, prompt, signal);
}
