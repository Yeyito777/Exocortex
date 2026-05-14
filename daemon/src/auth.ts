import { createEmptyProviderAuthInfo } from "@exocortex/shared/auth";
import type { ProviderId } from "./messages";
import type { ProviderAuthInfo } from "./protocol";
import { getProviderAdapter } from "./providers/catalog";
import type { EnsureAuthResult, LoginCallbacks, LoginOptions, LoginResult } from "./providers/types";
import { AuthError } from "./providers/errors";
import { isTokenExpired, loadProviderAuth, type StoredAuth } from "./store";

export { AuthError };
export type { LoginResult, LoginCallbacks, EnsureAuthResult };

interface StoredAuthLike extends StoredAuth {
  source?: string | null;
  accountId?: string | null;
}

interface StoredAuthPoolLike {
  accounts?: StoredAuthLike[];
  currentIndex?: number;
}

function isStoredAuthLike(value: unknown): value is StoredAuthLike {
  return typeof value === "object" && value !== null && "tokens" in value;
}

function isStoredAuthPoolLike(value: unknown): value is StoredAuthPoolLike {
  return typeof value === "object" && value !== null && Array.isArray((value as StoredAuthPoolLike).accounts);
}

function normalizeAuthRecords(stored: unknown): { accounts: StoredAuthLike[]; currentIndex: number } {
  if (isStoredAuthPoolLike(stored)) {
    const accounts = (stored.accounts ?? []).filter(isStoredAuthLike);
    const rawIndex = typeof stored.currentIndex === "number" ? stored.currentIndex : 0;
    return { accounts, currentIndex: accounts.length > 0 ? Math.max(0, Math.min(accounts.length - 1, rawIndex)) : -1 };
  }
  if (isStoredAuthLike(stored)) return { accounts: [stored], currentIndex: 0 };
  return { accounts: [], currentIndex: -1 };
}

const CREDENTIALS_CACHE_TTL_MS = 5_000;

const credentialsCache = new Map<ProviderId, { value: boolean; expiresAt: number }>();

export function invalidateCredentialsCache(provider?: ProviderId): void {
  if (provider) credentialsCache.delete(provider);
  else credentialsCache.clear();
}

export async function login(provider: ProviderId, callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult> {
  try {
    return await getProviderAdapter(provider).auth.login(callbacks, options);
  } finally {
    invalidateCredentialsCache(provider);
  }
}

export async function ensureAuthenticated(provider: ProviderId, callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult> {
  try {
    return await getProviderAdapter(provider).auth.ensureAuthenticated(callbacks, options);
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
    deepseek: hasConfiguredCredentials("deepseek"),
  };
}

export function getAuthInfo(provider: ProviderId): ProviderAuthInfo {
  const { accounts, currentIndex } = normalizeAuthRecords(loadProviderAuth<unknown>(provider));
  const stored = currentIndex >= 0 ? accounts[currentIndex] : null;
  if (!stored?.tokens) return createEmptyProviderAuthInfo();

  const expired = isTokenExpired(stored.tokens);
  const refreshable = !!stored.tokens.refreshToken;
  const status: ProviderAuthInfo["status"] = expired
    ? (refreshable ? "refreshable" : "expired")
    : "logged_in";
  const accountInfos = accounts.map((account, index) => ({
    email: account.profile?.email ?? null,
    displayName: account.profile?.displayName ?? null,
    subscriptionType: account.tokens.subscriptionType,
    accountId: account.accountId ?? account.profile?.accountUuid ?? null,
    current: index === currentIndex,
  }));

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
    ...(accountInfos.length > 0 ? {
      accounts: accountInfos,
      currentAccount: accountInfos[currentIndex] ?? null,
    } : {}),
  };
}

export function getAuthInfoByProvider(): Record<ProviderId, ProviderAuthInfo> {
  return {
    openai: getAuthInfo("openai"),
    deepseek: getAuthInfo("deepseek"),
  };
}
