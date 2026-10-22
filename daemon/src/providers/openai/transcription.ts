import { getVerifiedSession, type VerifiedOpenAISession } from "./auth";
import { CHATGPT_BASE_URL, OPENAI_API_TRANSCRIPTIONS_URL, OPENAI_TRANSCRIBE_URL } from "./constants";
import { proxiedProviderUrl } from "../../provider-proxy/route";
import { buildOpenAIHeaders } from "./http";
import { log } from "../../log";
import { AuthError } from "../errors";
import { loadOpenAIApiKey } from "./api-key";
import { recordApiKeyUsage } from "./api-key-usage";

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

    const res = await fetch(proxiedProviderUrl("openai", OPENAI_TRANSCRIBE_URL, CHATGPT_BASE_URL), {
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

// ── API key: /v1/audio/transcriptions ──────────────────────────────

/** Best first. gpt-transcribe is OpenAI's recommended file-transcription model. */
const API_TRANSCRIPTION_MODELS = ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;

/** The upload formats the public endpoint accepts, by file extension. */
const API_AUDIO_EXTENSIONS = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
const API_AUDIO_EXTENSION_BY_MIME: Record<string, string> = {
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

/** Transcription models the key lists, best first; the best known one when the list is unknown. */
export function apiTranscriptionModels(available: readonly string[]): string[] {
  const listed = API_TRANSCRIPTION_MODELS.filter((model) => available.includes(model));
  return listed.length > 0 ? listed : [API_TRANSCRIPTION_MODELS[0]];
}

/**
 * The endpoint infers the format from the file name: give an `.opus` voice
 * note (Ogg) or an extensionless upload the extension its MIME type implies.
 */
export function apiUploadFilename(filename: string | undefined, mimeType: string): string {
  const name = filename?.trim() || "audio";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (API_AUDIO_EXTENSIONS.has(extension)) return name;
  const implied = API_AUDIO_EXTENSION_BY_MIME[mimeType.split(";")[0].trim().toLowerCase()];
  if (!implied) return name;
  return `${dot > 0 ? name.slice(0, dot) : name}.${implied}`;
}

function isApiModelRejection(status: number, body: string): boolean {
  return (status === 400 || status === 403 || status === 404) && /model/i.test(body);
}

interface ApiTranscriptionResponse {
  text?: unknown;
  usage?: { type?: unknown; input_tokens?: unknown; output_tokens?: unknown };
}

export async function transcribeAudioWithApiKey(
  session: Pick<VerifiedOpenAISession, "accessToken" | "accountKey">,
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions & { models?: readonly string[]; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const models = options.models?.length ? options.models : [API_TRANSCRIPTION_MODELS[0]];
  const filename = apiUploadFilename(options.filename, mimeType);
  for (const [index, model] of models.entries()) {
    for (let attempt = 0; ; attempt += 1) {
      const form = new FormData();
      form.append("model", model);
      form.append("file", new Blob([Buffer.from(audioBytes)], { type: mimeType }), filename);
      const res = await (options.fetchImpl ?? fetch)(OPENAI_API_TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}`, Accept: "application/json" },
        body: form,
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 401) throw new AuthError("The OpenAI API key was rejected (HTTP 401). Log in again with `/login openai key <api-key>`.");
        if (attempt < MAX_TRANSCRIPTION_RETRIES && isRetriableTranscriptionHttpError(res.status, text)) {
          log("warn", `openai transcription: retrying HTTP ${res.status} immediately (attempt ${attempt + 1}/${MAX_TRANSCRIPTION_RETRIES})`);
          continue;
        }
        if (index < models.length - 1 && isApiModelRejection(res.status, text)) {
          log("warn", `openai transcription: ${model} rejected (${res.status}), trying ${models[index + 1]}`);
          break;
        }
        throw new Error(`OpenAI transcription with ${model} failed (${res.status}): ${text.slice(0, 500)}`);
      }

      const data = await res.json() as ApiTranscriptionResponse;
      const usage = data.usage?.type === "tokens" ? data.usage : null;
      recordApiKeyUsage(session.accountKey, {
        model,
        inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
        outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
      });
      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (!text) throw new Error("OpenAI transcription returned an empty result");
      return text;
    }
  }
  throw new Error("OpenAI transcription has no model to use");
}

/**
 * Transcribe with the login requests use: the ChatGPT account's transcription
 * endpoint, or the public API when OpenAI runs on an API key (logged in with
 * one, or the ChatGPT session expired).
 */
export async function transcribeAudio(
  audioBytes: Uint8Array,
  mimeType = "audio/wav",
  options: OpenAITranscriptionOptions = {},
): Promise<string> {
  const session = await getVerifiedSession();
  if (session.kind === "api_key") {
    const models = apiTranscriptionModels(loadOpenAIApiKey()?.models ?? []);
    return transcribeAudioWithApiKey(session, audioBytes, mimeType, { ...options, models });
  }
  return transcribeAudioWithSession(session, audioBytes, mimeType, options);
}
