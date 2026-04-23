import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import { loadProviderAuth, type StoredAuth } from "../store";
import { generateImage } from "../providers/openai/image-generation";
import type { ImageData, Tool, ToolExecutionContext, ToolResult, ToolSummary } from "./types";
import { cap, getString, summarizeParams } from "./util";

function hasOpenAIAuth(): boolean {
  const stored = loadProviderAuth<StoredAuth>("openai");
  return !!stored?.tokens?.accessToken || !!stored?.tokens?.refreshToken;
}

function summarize(input: Record<string, unknown>): ToolSummary {
  const prompt = getString(input, "prompt") ?? "";
  return { label: "Image", detail: summarizeParams(prompt, input, ["prompt"]) };
}

function sniffImageMediaType(bytes: Uint8Array): ImageData["mediaType"] {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4E
    && bytes[3] === 0x47
    && bytes[4] === 0x0D
    && bytes[5] === 0x0A
    && bytes[6] === 0x1A
    && bytes[7] === 0x0A) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const head = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
    const webp = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return "image/png";
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/png":
    default:
      return "png";
  }
}

async function saveGeneratedImage(bytes: Uint8Array, mediaType: string): Promise<string> {
  const dir = join(dataDir(), "generated-images");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${extensionForMediaType(mediaType)}`);
  await writeFile(filePath, bytes);
  return filePath;
}

export function formatGenerateImageOutput(savedPath: string, revisedPrompt: string | null): string {
  return revisedPrompt
    ? `Revised prompt:\n${revisedPrompt}\n\nSaved:\n${savedPath}`
    : `Saved:\n${savedPath}`;
}

async function executeGenerateImage(
  input: Record<string, unknown>,
  _context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const prompt = getString(input, "prompt")?.trim();
  if (!prompt) {
    return { output: "Missing required string parameter: prompt", isError: true };
  }

  try {
    const generated = await generateImage(prompt, signal);
    const bytes = Buffer.from(generated.base64, "base64");
    if (bytes.length === 0) {
      return { output: "OpenAI image generation returned empty image data", isError: true };
    }

    const mediaType = sniffImageMediaType(bytes);
    const base64 = bytes.toString("base64");
    const savedPath = await saveGeneratedImage(bytes, mediaType);

    return {
      output: cap(formatGenerateImageOutput(savedPath, generated.revisedPrompt)),
      isError: false,
      image: { mediaType, base64 },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error generating image: ${msg}`, isError: true };
  }
}

export const generateImageTool: Tool = {
  name: "generate_image",
  description: "Generate a raster image using OpenAI. Returns the generated image inline and saves a copy under Exocortex's data directory.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "The image you want generated." },
    },
    required: ["prompt"],
  },
  systemHint: "Use the generate_image tool when the user wants a raster image created. It returns the image inline for review and saves a local copy under Exocortex's generated-images directory.",
  display: {
    label: "Image",
    color: "#ffb86c",
  },
  isAvailable: hasOpenAIAuth,
  summarize,
  execute: executeGenerateImage,
};
