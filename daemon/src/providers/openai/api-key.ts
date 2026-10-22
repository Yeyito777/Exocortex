/**
 * OpenAI API-key login: the second way to sign the openai provider in, beside
 * the ChatGPT account pool. With it, requests go to the public OpenAI API
 * (api.openai.com) and are billed to the key's organization.
 *
 * The key lives in its own credential slot so the ChatGPT pool code (and
 * older builds reading it) never sees it. `active` records which method the
 * user logged in with last: the most recent login wins.
 */
import { createHash } from "node:crypto";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth } from "../../store";
import { AuthError } from "../errors";
import { OPENAI_API_MODELS_URL } from "./constants";

const OPENAI_API_KEY_SLOT = "openai-api-key";

export interface StoredOpenAIApiKey {
  apiKey: string;
  /** Redacted form safe to show and log. */
  label: string;
  /** True while the API key, not the ChatGPT account, is the selected login. */
  active: boolean;
  /** Model ids the key could use when it was last verified. */
  models: string[];
  updatedAt: string;
}

export interface VerifiedOpenAIApiKey {
  modelIds: string[];
  /** `openai-organization` response header, when OpenAI sent one. */
  organization: string | null;
  /** `openai-project` response header, when OpenAI sent one. */
  project: string | null;
}

export function normalizeOpenAIApiKey(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function redactOpenAIApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 16) return "sk-***";
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

function isStoredApiKey(value: unknown): value is StoredOpenAIApiKey {
  return typeof value === "object" && value !== null
    && typeof (value as { apiKey?: unknown }).apiKey === "string"
    && (value as { apiKey: string }).apiKey.length > 0;
}

export function loadOpenAIApiKey(): StoredOpenAIApiKey | null {
  const stored = loadProviderAuth<unknown>(OPENAI_API_KEY_SLOT);
  if (!isStoredApiKey(stored)) return null;
  return {
    ...stored,
    label: stored.label || redactOpenAIApiKey(stored.apiKey),
    active: stored.active === true,
    models: Array.isArray(stored.models) ? stored.models.filter((id): id is string => typeof id === "string") : [],
  };
}

export function saveOpenAIApiKey(apiKey: string, models: string[]): StoredOpenAIApiKey {
  const stored: StoredOpenAIApiKey = {
    apiKey,
    label: redactOpenAIApiKey(apiKey),
    active: true,
    models: [...models].sort(),
    updatedAt: new Date().toISOString(),
  };
  saveProviderAuth(OPENAI_API_KEY_SLOT, stored);
  return stored;
}

/** A ChatGPT login just happened: it becomes the selected method, the key stays stored. */
export function deactivateOpenAIApiKey(): void {
  const stored = loadOpenAIApiKey();
  if (!stored?.active) return;
  saveProviderAuth(OPENAI_API_KEY_SLOT, { ...stored, active: false });
}

export function updateOpenAIApiKeyModels(apiKey: string, models: string[]): void {
  const stored = loadOpenAIApiKey();
  if (!stored || stored.apiKey !== apiKey) return;
  const sorted = [...models].sort();
  if (JSON.stringify(sorted) === JSON.stringify(stored.models)) return;
  saveProviderAuth(OPENAI_API_KEY_SLOT, { ...stored, models: sorted });
}

export function clearOpenAIApiKey(): boolean {
  return clearProviderAuth(OPENAI_API_KEY_SLOT);
}

/** Non-secret identity of the key: scopes replayed encrypted reasoning and usage. */
export function openAIApiKeyAccountKey(apiKey: string): string {
  return `api-key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
}

function parseApiError(text: string): string | null {
  try {
    const data = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const message = typeof data.error?.message === "string" ? data.error.message : null;
    const code = typeof data.error?.code === "string" ? data.error.code : null;
    if (!message && !code) return null;
    // OpenAI echoes a redacted key in invalid_api_key messages; keep only the code then.
    if (code === "invalid_api_key") return "invalid_api_key";
    return [code, message].filter(Boolean).join(": ");
  } catch {
    return null;
  }
}

/** One cheap request (GET /v1/models) proving the key works, and what it can use. */
export async function verifyOpenAIApiKey(
  apiKey: string,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<VerifiedOpenAIApiKey> {
  const res = await (opts.fetchImpl ?? fetch)(OPENAI_API_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: opts.signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = parseApiError(text);
    throw new AuthError(`OpenAI API key verification failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  let data: { data?: Array<{ id?: unknown }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new AuthError("OpenAI API key verification failed: invalid /v1/models response");
  }
  const modelIds = (data.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    modelIds,
    organization: res.headers.get("openai-organization"),
    project: res.headers.get("openai-project"),
  };
}
