import { transcribeAudioFile } from "../transcription";
import type { Tool, ToolExecutionContext, ToolResult, ToolSummary } from "./types";
import { hasOpenAIAuth } from "./openai-auth";
import { cap, getString, summarizeParams } from "./util";

function summarize(input: Record<string, unknown>): ToolSummary {
  const filePath = getString(input, "file_path") ?? "";
  return { label: "Transcribe", detail: summarizeParams(filePath, input, ["file_path"]) };
}

export function formatTranscribeAudioOutput(text: string): string {
  return text.trim();
}

async function executeTranscribeAudio(
  input: Record<string, unknown>,
  _context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const filePath = getString(input, "file_path")?.trim();
  if (!filePath) {
    return { output: "Missing required string parameter: file_path", isError: true };
  }

  const mimeType = getString(input, "mime_type")?.trim() || undefined;

  try {
    const text = await transcribeAudioFile(filePath, { mimeType, signal });
    return { output: cap(formatTranscribeAudioOutput(text)), isError: false };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error transcribing audio: ${msg}`, isError: true };
  }
}

export const transcribeAudioTool: Tool = {
  name: "transcribe_audio",
  description: "Transcribe speech from a local audio file using OpenAI voice transcription. Provide an absolute path to an audio file; MIME type is inferred from the extension unless supplied.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the local audio file to transcribe." },
      mime_type: { type: "string", description: "Optional MIME type override, e.g. audio/wav, audio/mpeg, audio/mp4, audio/webm, audio/ogg, or audio/flac." },
    },
    required: ["file_path"],
  },
  systemHint: "Use audio transcription when you need to understand spoken content in an audio file.",
  display: {
    label: "Transcribe",
    color: "#f2fa9c",
  },
  isAvailable: hasOpenAIAuth,
  summarize,
  execute: executeTranscribeAudio,
};
