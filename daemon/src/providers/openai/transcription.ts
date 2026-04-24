import { getVerifiedSession } from "./auth";
import { OPENAI_TRANSCRIBE_URL } from "./constants";
import { buildOpenAIHeaders } from "./http";

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

export async function transcribeAudioWithSession(
  session: OpenAITranscriptionSession,
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions = {},
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audioBytes)], { type: mimeType }), options.filename ?? "audio.wav");

  const headers = buildOpenAIHeaders({
    Authorization: `Bearer ${session.accessToken}`,
  });
  if (session.accountId) {
    headers["ChatGPT-Account-ID"] = session.accountId;
  }

  const res = await fetch(OPENAI_TRANSCRIBE_URL, {
    method: "POST",
    headers,
    body: form,
    signal: options.signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI transcription failed (${res.status}): ${text.slice(0, 500)}`);
  }

  const data = await res.json() as TranscriptionResponse;
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) {
    throw new Error("OpenAI transcription returned an empty result");
  }
  return text;
}

export async function transcribeAudio(
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions = {},
): Promise<string> {
  const session = await getVerifiedSession();
  return transcribeAudioWithSession(session, audioBytes, mimeType, options);
}
