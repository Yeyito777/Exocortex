import { clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type OAuthProfile, type StoredTokens } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginOptions, LoginResult } from "../types";
import { OPENROUTER_KEY_PATH, OPENROUTER_PROVIDER_ID } from "./constants";
import { buildOpenRouterJsonHeaders, buildOpenRouterUrl, redactOpenRouterApiKey } from "./http";
import type { StoredOpenRouterAuth } from "./types";

const FAR_FUTURE_EXPIRES_AT = 4_102_444_800_000; // 2100-01-01T00:00:00.000Z

function normalizeApiKey(apiKey: string | null | undefined): string | null {
  const trimmed = apiKey?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function loadStoredAuth(): StoredOpenRouterAuth | null {
  return loadProviderAuth<StoredOpenRouterAuth>(OPENROUTER_PROVIDER_ID);
}

function saveStoredAuth(auth: StoredOpenRouterAuth): void {
  saveProviderAuth(OPENROUTER_PROVIDER_ID, auth);
}

function envApiKey(): string | null {
  return normalizeApiKey(process.env.OPENROUTER_API_KEY);
}

function profileForApiKey(apiKey: string): OAuthProfile {
  const label = redactOpenRouterApiKey(apiKey);
  return {
    accountUuid: label,
    email: label,
    displayName: label,
    organizationUuid: null,
    organizationName: "OpenRouter",
    organizationType: "api_key",
    organizationRole: null,
    workspaceRole: null,
  };
}

function buildStoredAuth(apiKey: string, source: StoredOpenRouterAuth["source"]): StoredOpenRouterAuth {
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
    apiKeyLabel: redactOpenRouterApiKey(apiKey),
    updatedAt: new Date().toISOString(),
  };
}

export function openRouterLoginInstruction(): string {
  return "OpenRouter uses API-key login. Create/copy a key at https://openrouter.ai/settings/keys, then run `/login openrouter <api-key>` (for example `/login openrouter sk-...`).";
}

async function verifyKey(apiKey: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(buildOpenRouterUrl(OPENROUTER_KEY_PATH), {
    headers: buildOpenRouterJsonHeaders(apiKey),
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Do not echo an upstream response that could contain credentials.
    throw new AuthError(`OpenRouter API key verification failed (${res.status})`);
  }
  try {
    const payload = JSON.parse(text);
    if (!payload?.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new Error("Invalid key response");
  } catch {
    throw new AuthError("OpenRouter API key verification failed: invalid /key response");
  }
}

async function verifyAndPersist(apiKey: string, source: StoredOpenRouterAuth["source"], callbacks?: LoginCallbacks): Promise<StoredOpenRouterAuth> {
  callbacks?.onProgress?.("Verifying OpenRouter API key...");
  await verifyKey(apiKey);
  const auth = buildStoredAuth(apiKey, source);
  saveStoredAuth(auth);
  return auth;
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  const apiKey = normalizeApiKey(options?.apiKey) ?? envApiKey();
  if (!apiKey) {
    throw new AuthError(openRouterLoginInstruction());
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
    callbacks?.onProgress?.("Checking stored OpenRouter API key...");
    if (await verifyAuth(stored.tokens.accessToken)) {
      return { status: "already_authenticated", email: stored.profile?.displayName ?? null };
    }
  }

  const fromEnv = envApiKey();
  if (fromEnv) {
    const auth = await verifyAndPersist(fromEnv, "env", callbacks);
    return { status: "logged_in", email: auth.profile?.displayName ?? null };
  }

  throw new AuthError(openRouterLoginInstruction());
}

export async function verifyAuth(accessToken: string): Promise<boolean> {
  try {
    await verifyKey(accessToken);
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

  throw new AuthError(`OpenRouter is not authenticated. ${openRouterLoginInstruction()}`);
}

export function clearAuth(): boolean {
  const hadEnv = envApiKey() !== null;
  delete process.env.OPENROUTER_API_KEY;
  return clearProviderAuth(OPENROUTER_PROVIDER_ID) || hadEnv;
}
