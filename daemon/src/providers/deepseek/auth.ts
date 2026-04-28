import { clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type OAuthProfile, type StoredTokens } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginOptions, LoginResult } from "../types";
import { DEEPSEEK_MODELS_PATH, DEEPSEEK_PROVIDER_ID } from "./constants";
import { buildDeepSeekJsonHeaders, buildDeepSeekUrl, parseDeepSeekError, redactDeepSeekApiKey } from "./http";
import type { DeepSeekModelsResponse, StoredDeepSeekAuth } from "./types";

const FAR_FUTURE_EXPIRES_AT = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z

function normalizeApiKey(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function loadStoredAuth(): StoredDeepSeekAuth | null {
  return loadProviderAuth<StoredDeepSeekAuth>(DEEPSEEK_PROVIDER_ID);
}

function saveStoredAuth(auth: StoredDeepSeekAuth): void {
  saveProviderAuth(DEEPSEEK_PROVIDER_ID, auth);
}

function envApiKey(): string | null {
  return normalizeApiKey(process.env.DEEPSEEK_API_KEY);
}

function profileForApiKey(apiKey: string): OAuthProfile {
  const label = redactDeepSeekApiKey(apiKey);
  return {
    accountUuid: label,
    email: label,
    displayName: label,
    organizationUuid: null,
    organizationName: "DeepSeek",
    organizationType: "api_key",
    organizationRole: null,
    workspaceRole: null,
  };
}

function buildStoredAuth(apiKey: string, source: StoredDeepSeekAuth["source"]): StoredDeepSeekAuth {
  const tokens: StoredTokens = {
    accessToken: apiKey,
    refreshToken: null,
    expiresAt: FAR_FUTURE_EXPIRES_AT,
    scopes: ["api"],
    subscriptionType: "api_key",
    rateLimitTier: null,
  };
  return {
    tokens,
    profile: profileForApiKey(apiKey),
    source,
    apiKeyLabel: redactDeepSeekApiKey(apiKey),
    updatedAt: new Date().toISOString(),
  };
}

export function deepSeekLoginInstruction(): string {
  return "DeepSeek uses API-key login. Create/copy a key at https://platform.deepseek.com/api_keys, then run `/login deepseek <api-key>` (for example `/login deepseek sk-...`).";
}

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<DeepSeekModelsResponse> {
  const res = await fetch(buildDeepSeekUrl(DEEPSEEK_MODELS_PATH), {
    headers: buildDeepSeekJsonHeaders(apiKey),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const parsed = parseDeepSeekError(text);
    throw new AuthError(`DeepSeek API key verification failed (${res.status}): ${parsed ?? text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as DeepSeekModelsResponse;
  } catch {
    throw new AuthError("DeepSeek API key verification failed: invalid /models response");
  }
}

async function verifyAndPersist(apiKey: string, source: StoredDeepSeekAuth["source"], callbacks?: LoginCallbacks): Promise<StoredDeepSeekAuth> {
  callbacks?.onProgress?.("Verifying DeepSeek API key...");
  await fetchModels(apiKey);
  const auth = buildStoredAuth(apiKey, source);
  saveStoredAuth(auth);
  return auth;
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  const apiKey = normalizeApiKey(options?.apiKey) ?? envApiKey();
  if (!apiKey) {
    throw new AuthError(deepSeekLoginInstruction());
  }
  const auth = await verifyAndPersist(apiKey, options?.apiKey ? "api_key" : "env", cbs);
  return {
    tokens: auth.tokens,
    profile: auth.profile,
  };
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult> {
  const apiKey = normalizeApiKey(options?.apiKey);
  if (apiKey) {
    const auth = await verifyAndPersist(apiKey, "api_key", callbacks);
    return { status: "logged_in", email: auth.profile?.displayName ?? null };
  }

  const stored = loadStoredAuth();
  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens)) {
    callbacks?.onProgress?.("Checking stored DeepSeek API key...");
    if (await verifyAuth(stored.tokens.accessToken)) {
      return { status: "already_authenticated", email: stored.profile?.displayName ?? null };
    }
  }

  const fromEnv = envApiKey();
  if (fromEnv) {
    const auth = await verifyAndPersist(fromEnv, "env", callbacks);
    return { status: "logged_in", email: auth.profile?.displayName ?? null };
  }

  throw new AuthError(deepSeekLoginInstruction());
}

export async function verifyAuth(accessToken: string): Promise<boolean> {
  try {
    await fetchModels(accessToken);
    return true;
  } catch {
    return false;
  }
}

export function hasConfiguredCredentials(): boolean {
  const stored = loadStoredAuth();
  if (stored?.tokens?.accessToken) return true;
  return envApiKey() !== null;
}

export async function getVerifiedApiKey(): Promise<string> {
  const stored = loadStoredAuth();
  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens) && await verifyAuth(stored.tokens.accessToken)) {
    return stored.tokens.accessToken;
  }

  const fromEnv = envApiKey();
  if (fromEnv && await verifyAuth(fromEnv)) {
    saveStoredAuth(buildStoredAuth(fromEnv, "env"));
    return fromEnv;
  }

  throw new AuthError(`DeepSeek is not authenticated. ${deepSeekLoginInstruction()}`);
}

export function clearAuth(): boolean {
  const hadEnv = envApiKey() !== null;
  delete process.env.DEEPSEEK_API_KEY;
  return clearProviderAuth(DEEPSEEK_PROVIDER_ID) || hadEnv;
}
