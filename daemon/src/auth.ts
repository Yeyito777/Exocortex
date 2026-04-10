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

export function login(provider: ProviderId, callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  return getProviderAdapter(provider).auth.login(callbacks);
}

export function ensureAuthenticated(provider: ProviderId, callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  return getProviderAdapter(provider).auth.ensureAuthenticated(callbacks);
}

export function refreshTokens(provider: ProviderId, refreshToken: string) {
  const refresh = getProviderAdapter(provider).auth.refreshTokens;
  if (!refresh) {
    throw new Error(`Token refresh is not supported for provider: ${provider}`);
  }
  return refresh(refreshToken);
}

export function verifyAuth(provider: ProviderId, accessToken: string): Promise<boolean> {
  return getProviderAdapter(provider).auth.verifyAuth(accessToken);
}

export function clearAuth(provider: ProviderId): boolean {
  return getProviderAdapter(provider).auth.clearAuth();
}

export function hasConfiguredCredentials(provider: ProviderId): boolean {
  return getProviderAdapter(provider).auth.hasConfiguredCredentials();
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
