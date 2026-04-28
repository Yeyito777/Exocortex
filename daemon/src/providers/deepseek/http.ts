import { readExocortexConfig } from "@exocortex/shared/config";
import { DEEPSEEK_DEFAULT_BASE_URL } from "./constants";
import type { DeepSeekErrorResponse } from "./types";

export function getDeepSeekBaseUrl(): string {
  const configured = readExocortexConfig().providers?.deepseek?.baseUrl;
  const fromConfig = typeof configured === "string" && configured.trim() ? configured.trim() : null;
  const fromEnv = process.env.DEEPSEEK_BASE_URL?.trim() || null;
  return (fromConfig ?? fromEnv ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function buildDeepSeekUrl(path: string): string {
  return `${getDeepSeekBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildDeepSeekJsonHeaders(apiKey: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...overrides,
  };
}

export function redactDeepSeekApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return "sk-***";
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

export function parseDeepSeekError(text: string): string | null {
  try {
    const data = JSON.parse(text) as DeepSeekErrorResponse;
    const err = data.error;
    if (!err) return null;
    const message = err.message ?? "DeepSeek API error";
    const code = err.code ? ` (${err.code})` : "";
    return `${message}${code}`;
  } catch {
    return null;
  }
}
