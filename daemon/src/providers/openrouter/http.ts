import { readExocortexConfig } from "@exocortex/shared/config";
import { OPENROUTER_DEFAULT_BASE_URL } from "./constants";
import type { OpenRouterErrorResponse } from "./types";

export function getOpenRouterBaseUrl(): string {
  const configured = readExocortexConfig().providers?.openrouter?.baseUrl;
  const fromConfig = typeof configured === "string" && configured.trim() ? configured.trim() : null;
  const fromEnv = process.env.OPENROUTER_BASE_URL?.trim() || null;
  return (fromConfig ?? fromEnv ?? OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function buildOpenRouterUrl(path: string): string {
  return `${getOpenRouterBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildOpenRouterJsonHeaders(apiKey: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...overrides,
  };
}

export function redactOpenRouterApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 12) return "sk-***";
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

export function parseOpenRouterError(text: string): string | null {
  try {
    const data = JSON.parse(text) as OpenRouterErrorResponse;
    const err = data.error;
    if (!err) return null;
    const message = err.message ?? "OpenRouter API error";
    const code = err.code ? ` (${err.code})` : "";
    return `${message}${code}`;
  } catch {
    return null;
  }
}
