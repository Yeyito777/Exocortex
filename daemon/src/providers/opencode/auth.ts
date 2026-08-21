import type { OAuthProfile } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";
import { OPENCODE_MODELS_PATH, OPENCODE_PUBLIC_API_KEY, OX_ALPHA_MODEL_ID } from "./constants";
import { buildOpenCodeJsonHeaders, buildOpenCodeUrl, parseOpenCodeError } from "./http";
import type { OpenCodeModelsResponse } from "./types";

function configuredApiKey(): string {
  return process.env.OPENCODE_API_KEY?.trim() || OPENCODE_PUBLIC_API_KEY;
}

function publicProfile(): OAuthProfile {
  return {
    accountUuid: "opencode-public",
    email: "Public preview",
    displayName: "Public preview",
    organizationUuid: null,
    organizationName: "OpenCode Zen",
    organizationType: "public",
    organizationRole: null,
    workspaceRole: null,
  };
}

async function fetchModels(apiKey: string): Promise<void> {
  const res = await fetch(buildOpenCodeUrl(OPENCODE_MODELS_PATH), {
    headers: buildOpenCodeJsonHeaders(apiKey),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AuthError(`OpenCode Zen access check failed (${res.status}): ${parseOpenCodeError(text) ?? text.slice(0, 300)}`);
  }
  try {
    const data = JSON.parse(text) as OpenCodeModelsResponse;
    if (data.data?.some((model) => model.id === OX_ALPHA_MODEL_ID)) return;
  } catch {
    throw new AuthError("OpenCode Zen access check failed: invalid /models response");
  }
  throw new AuthError("Ox Alpha is no longer advertised by OpenCode Zen; the limited-time public preview may have ended.");
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  cbs.onProgress?.("Checking OpenCode Zen public access...");
  await fetchModels(configuredApiKey());
  return { profile: publicProfile() };
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  callbacks?.onProgress?.("Checking OpenCode Zen public access...");
  await fetchModels(configuredApiKey());
  return { status: "already_authenticated", email: "Public preview" };
}

export async function verifyAuth(accessToken: string): Promise<boolean> {
  try {
    await fetchModels(accessToken || OPENCODE_PUBLIC_API_KEY);
    return true;
  } catch {
    return false;
  }
}

export function getApiKey(): string {
  return configuredApiKey();
}

export function hasConfiguredCredentials(): boolean {
  // OpenCode intentionally exposes zero-cost Zen models through the sentinel
  // Bearer token "public" and applies anonymous per-IP limits server-side.
  return true;
}

export function clearAuth(): boolean {
  // Public access cannot be logged out. An optional environment key remains
  // process configuration rather than mutable daemon-owned credential state.
  return false;
}
