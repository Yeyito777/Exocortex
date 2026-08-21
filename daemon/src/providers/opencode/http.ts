import { readExocortexConfig } from "@exocortex/shared/config";
import { OPENCODE_DEFAULT_BASE_URL } from "./constants";

export function getOpenCodeBaseUrl(): string {
  const configured = readExocortexConfig().providers?.opencode?.baseUrl;
  const fromConfig = typeof configured === "string" && configured.trim() ? configured.trim() : null;
  const fromEnv = process.env.OPENCODE_BASE_URL?.trim() || null;
  return (fromConfig ?? fromEnv ?? OPENCODE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function buildOpenCodeUrl(path: string): string {
  return `${getOpenCodeBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildOpenCodeJsonHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export function parseOpenCodeError(text: string): string | null {
  try {
    const data = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
    if (typeof data.error === "string") return data.error;
    return data.error?.message ?? data.message ?? null;
  } catch {
    return null;
  }
}
