import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { transcribeAudio as transcribeOpenAIAudio } from "./providers/openai/transcription";

export const DEFAULT_AUDIO_MIME_TYPE = "audio/wav";
export const UNKNOWN_AUDIO_MIME_TYPE = "application/octet-stream";

const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".amr": "audio/amr",
  ".caf": "audio/x-caf",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mka": "audio/x-matroska",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".mpeg": "audio/mpeg",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".wave": "audio/wav",
  ".weba": "audio/webm",
  ".webm": "audio/webm",
};

export interface AudioTranscriptionOptions {
  /** MIME type for the audio payload. Defaults to audio/wav for raw bytes, or extension inference for files. */
  mimeType?: string;
  /** Upload filename sent to the transcription backend. Defaults to a sensible name or the input file basename. */
  filename?: string;
  signal?: AbortSignal;
}

export function inferAudioMimeType(filePath: string): string | null {
  return AUDIO_MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? null;
}

function normalizeMimeType(mimeType: string | undefined, fallback: string): string {
  const normalized = mimeType?.trim();
  return normalized || fallback;
}

function assertNonEmptyAudio(audioBytes: Uint8Array): void {
  if (audioBytes.byteLength === 0) {
    throw new Error("Audio file is empty");
  }
}

export async function transcribeAudioBytes(
  audioBytes: Uint8Array,
  options: AudioTranscriptionOptions = {},
): Promise<string> {
  assertNonEmptyAudio(audioBytes);
  const mimeType = normalizeMimeType(options.mimeType, DEFAULT_AUDIO_MIME_TYPE);
  return transcribeOpenAIAudio(audioBytes, mimeType, {
    filename: options.filename,
    signal: options.signal,
  });
}

export async function transcribeAudioFile(
  filePath: string,
  options: AudioTranscriptionOptions = {},
): Promise<string> {
  const bytes = await readFile(filePath);
  const mimeType = normalizeMimeType(options.mimeType, inferAudioMimeType(filePath) ?? UNKNOWN_AUDIO_MIME_TYPE);
  return transcribeAudioBytes(bytes, {
    ...options,
    mimeType,
    filename: options.filename ?? basename(filePath),
  });
}
