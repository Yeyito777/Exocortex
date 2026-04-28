import { createEmptyProviderAuthInfo } from "@exocortex/shared/auth";
import type { ProviderId } from "./messages";
import type { ProviderAuthInfo } from "./protocol";
import { getProviderAdapter } from "./providers/catalog";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "./providers/types";
import { AuthError } from "./providers/errors";
import { isTokenExpired, loadProviderAuth, type StoredAuth } from "./store";

export { AuthError };
export type { LoginResult, LoginCallbacks, EnsureAuthResult };

interface StoredAuthLike extends StoredAuth {
  source?: string | null;
}

const CREDENTIALS_CACHE_TTL_MS = 5_000;

const credentialsCache = new Map<ProviderId, { value: boolean; expiresAt: number }>();

function invalidateCredentialsCache(provider?: ProviderId): void {
  if (provider) credentialsCache.delete(provider);
  else credentialsCache.clear();
}

export async function login(provider: ProviderId, callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  try {
    return await getProviderAdapter(provider).auth.login(callbacks);
  } finally {
    invalidateCredentialsCache(provider);
  }
}

export async function ensureAuthenticated(provider: ProviderId, callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  try {
    return await getProviderAdapter(provider).auth.ensureAuthenticated(callbacks);
  } finally {
    invalidateCredentialsCache(provider);
  }
}

export async function refreshTokens(provider: ProviderId, refreshToken: string): Promise<unknown> {
  const refresh = getProviderAdapter(provider).auth.refreshTokens;
  if (!refresh) {
    throw new Error(`Token refresh is not supported for provider: ${provider}`);
  }
  try {
    return await refresh(refreshToken);
  } finally {
    invalidateCredentialsCache(provider);
  }
}

export function verifyAuth(provider: ProviderId, accessToken: string): Promise<boolean> {
  return getProviderAdapter(provider).auth.verifyAuth(accessToken);
}

export function clearAuth(provider: ProviderId): boolean {
  try {
    return getProviderAdapter(provider).auth.clearAuth();
  } finally {
    invalidateCredentialsCache(provider);
  }
}

export function hasConfiguredCredentials(provider: ProviderId): boolean {
  const now = Date.now();
  const cached = credentialsCache.get(provider);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = getProviderAdapter(provider).auth.hasConfiguredCredentials();
  credentialsCache.set(provider, { value, expiresAt: now + CREDENTIALS_CACHE_TTL_MS });
  return value;
}

export function getAuthByProvider(): Record<ProviderId, boolean> {
  return {
    openai: hasConfiguredCredentials("openai"),
    anthropic: hasConfiguredCredentials("anthropic"),
  };
}

export function getAuthInfo(provider: ProviderId): ProviderAuthInfo {
  const stored = loadProviderAuth<StoredAuthLike>(provider);
  if (!stored?.tokens) return createEmptyProviderAuthInfo();

  const expired = isTokenExpired(stored.tokens);
  const refreshable = !!stored.tokens.refreshToken;
  const status: ProviderAuthInfo["status"] = expired
    ? (refreshable ? "refreshable" : "expired")
    : "logged_in";

  return {
    configured: true,
    authenticated: status === "logged_in",
    status,
    email: stored.profile?.email ?? null,
    displayName: stored.profile?.displayName ?? null,
    organizationName: stored.profile?.organizationName ?? null,
    organizationType: stored.profile?.organizationType ?? null,
    organizationRole: stored.profile?.organizationRole ?? null,
    workspaceRole: stored.profile?.workspaceRole ?? null,
    subscriptionType: stored.tokens.subscriptionType,
    rateLimitTier: stored.tokens.rateLimitTier,
    scopes: [...stored.tokens.scopes],
    expiresAt: stored.tokens.expiresAt ?? null,
    updatedAt: stored.updatedAt ?? null,
    source: stored.source ?? null,
  };
}

export function getAuthInfoByProvider(): Record<ProviderId, ProviderAuthInfo> {
  return {
    openai: getAuthInfo("openai"),
    anthropic: getAuthInfo("anthropic"),
  };
}
