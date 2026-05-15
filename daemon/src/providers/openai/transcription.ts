import { getVerifiedSession } from "./auth";
import { OPENAI_TRANSCRIBE_URL } from "./constants";
import { buildOpenAIHeaders } from "./http";
import { log } from "../../log";

export interface OpenAITranscriptionSession {
  accessToken: string;
  accountId: string | null;
}

export interface OpenAITranscriptionOptions {
  filename?: string;
  signal?: AbortSignal;
}

interface TranscriptionResponse {
  text?: unknown;
}

const MAX_TRANSCRIPTION_RETRIES = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRetryAfterSeconds(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function hasTranscriptionRetryHint429(body: string): boolean {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return /transcription is temporarily unavailable|retry_after_seconds/i.test(body);
  }

  if (!isRecord(data)) return false;

  if (hasRetryAfterSeconds(data.retry_after_seconds)) return true;

  const topLevelMessage = typeof data.detail === "string" ? data.detail : typeof data.message === "string" ? data.message : "";
  if (/transcription is temporarily unavailable|temporarily unavailable/i.test(topLevelMessage)) return true;

  const detail = data.detail;
  if (!isRecord(detail)) return false;

  if (hasRetryAfterSeconds(detail.retry_after_seconds)) return true;

  const nestedMessage = typeof detail.detail === "string"
    ? detail.detail
    : typeof detail.message === "string"
      ? detail.message
      : "";
  return /transcription is temporarily unavailable|temporarily unavailable/i.test(nestedMessage);
}

function isRetriableTranscriptionHttpError(status: number, body: string): boolean {
  // OpenAI sometimes returns HTTP 429 with a JSON `retry_after_seconds` hint for
  // transient transcription capacity errors. The hint is deliberately ignored:
  // voice input should retry immediately instead of making the user wait.
  if (status === 429) return hasTranscriptionRetryHint429(body);
  return status === 500 || status === 502 || status === 503 || status === 504;
}

function formatTranscriptionHttpError(status: number, body: string): Error {
  return new Error(`OpenAI transcription failed (${status}): ${body.slice(0, 500)}`);
}

export async function transcribeAudioWithSession(
  session: OpenAITranscriptionSession,
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions = {},
): Promise<string> {
  const headers = buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
  });
  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  for (let attempt = 0; ; attempt += 1) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(audioBytes)], { type: mimeType }), options.filename ?? "audio.wav");

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers,
      body: form,
      signal: options.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      if (attempt < MAX_TRANSCRIPTION_RETRIES && isRetriableTranscriptionHttpError(res.status, text)) {
        log("warn", `openai transcription: retrying HTTP ${res.status} immediately (attempt ${attempt + 1}/${MAX_TRANSCRIPTION_RETRIES})`);
        continue;
      }
      throw formatTranscriptionHttpError(res.status, text);
    }

    const data = await res.json() as TranscriptionResponse;
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) {
      throw new Error("OpenAI transcription returned an empty result");
    }
    return text;
  }
}

export async function transcribeAudio(
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions = {},
): Promise<string> {
  const session = await getVerifiedSession();
  return transcribeAudioWithSession(session, audioBytes, mimeType, options);
}
