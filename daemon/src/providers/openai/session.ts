import { log } from "../../log";
import type { OAuthProfile, StoredTokens } from "../../store";
import { OPENAI_CODEX_CLIENT_VERSION, OPENAI_MODELS_URL, OPENAI_USERINFO_URL } from "./constants";
import { fetchAccountContext, type OpenAIAccountContext } from "./account-context";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";

export interface StoredOpenAIAuth {
  tokens: StoredTokens;
  profile: OAuthProfile | null;
  updatedAt: string;
  source: "codex" | "oauth";
  authMode: string | null;
  accountId: string | null;
  idToken: string | null;
}

export interface OpenAITokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
}

interface DecodedClaims {
  sub?: string;
  email?: string;
  name?: string;
  scope?: string;
  chatgpt_plan_type?: string;
  exp?: number;
}

function decodeJwt(token: string | null | undefined): DecodedClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as DecodedClaims;
  } catch {
    return null;
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ sub?: string; email?: string; name?: string } | null> {
  try {
    const res = await fetch(OPENAI_USERINFO_URL, {
      headers: requestHeaders(accessToken),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return parseOpenAIJson<{ sub?: string; email?: string; name?: string }>(text, "OpenAI userinfo");
    } catch {
      log("warn", `openai auth: userinfo returned non-JSON response from ${OPENAI_USERINFO_URL}`);
      return null;
    }
  } catch {
    return null;
  }
}

function mapSubscription(claims: DecodedClaims | null): string | null {
  return claims?.chatgpt_plan_type ?? null;
}

function buildScopes(token: OpenAITokenResponse, accessClaims: DecodedClaims | null): string[] {
  const scope = token.scope ?? accessClaims?.scope ?? "";
  return scope.split(" ").map((part) => part.trim()).filter(Boolean);
}

function mergeAccountContext(
  auth: StoredOpenAIAuth,
  accountContext: OpenAIAccountContext | null,
): StoredOpenAIAuth {
  if (!accountContext) return auth;

  return {
    ...auth,
    tokens: {
      ...auth.tokens,
      subscriptionType: accountContext.subscriptionType ?? auth.tokens.subscriptionType,
    },
    profile: {
      accountUuid: accountContext.accountId,
      email: auth.profile?.email ?? "",
      displayName: auth.profile?.displayName ?? null,
      organizationUuid: null,
      organizationName: accountContext.organizationName,
      organizationType: accountContext.organizationType,
      organizationRole: accountContext.organizationRole,
      workspaceRole: accountContext.workspaceRole,
    },
    updatedAt: new Date().toISOString(),
    accountId: accountContext.accountId,
  };
}

export async function buildStoredAuth(
  token: OpenAITokenResponse,
  source: StoredOpenAIAuth["source"],
  opts?: {
    accountId?: string | null;
    authMode?: string | null;
    fallbackRefreshToken?: string | null;
    fallbackIdToken?: string | null;
  },
): Promise<StoredOpenAIAuth> {
  const accessClaims = decodeJwt(token.access_token);
  const idToken = token.id_token ?? opts?.fallbackIdToken ?? null;
  const idClaims = decodeJwt(idToken);
  const userInfo = await fetchUserInfo(token.access_token);
  const accountContext = await fetchAccountContext(token.access_token);

  return mergeAccountContext({
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? opts?.fallbackRefreshToken ?? null,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: buildScopes(token, accessClaims),
      subscriptionType: mapSubscription(accessClaims) ?? mapSubscription(idClaims),
      rateLimitTier: null,
    },
    profile: {
      accountUuid: opts?.accountId ?? userInfo?.sub ?? idClaims?.sub ?? accessClaims?.sub ?? "",
      email: userInfo?.email ?? idClaims?.email ?? accessClaims?.email ?? "",
      displayName: userInfo?.name ?? idClaims?.name ?? accessClaims?.name ?? null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source,
    authMode: opts?.authMode ?? null,
    accountId: opts?.accountId ?? null,
    idToken,
  }, accountContext);
}

export async function enrichStoredAuth(auth: StoredOpenAIAuth): Promise<StoredOpenAIAuth> {
  if (auth.accountId) return auth;
  return mergeAccountContext(auth, await fetchAccountContext(auth.tokens.accessToken));
}

function requestHeaders(accessToken: string): HeadersInit {
  return buildOpenAIJsonHeaders({
    Authorization: `Bearer ${accessToken}`,
  });
}

function requestHeadersWithAccount(accessToken: string, accountId?: string | null): HeadersInit {
  return {
    ...requestHeaders(accessToken),
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

export async function verifyAuth(accessToken: string, accountId?: string | null): Promise<boolean> {
  try {
    const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
    const res = await fetch(url, {
      headers: requestHeadersWithAccount(accessToken, accountId),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
