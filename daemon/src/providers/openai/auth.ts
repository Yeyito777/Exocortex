import { clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type StoredTokens } from "../../store";
import { OPENAI_AUTH_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";
import { runOpenAIBrowserOAuth } from "./oauth";
import {
  buildStoredAuth,
  type OpenAITokenResponse,
  type StoredOpenAIAuth,
  verifyAuth as verifyStoredSession,
} from "./session";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";

function loadStoredAuth(): StoredOpenAIAuth | null {
  return loadProviderAuth<StoredOpenAIAuth>("openai");
}

function saveStoredAuth(auth: StoredOpenAIAuth): void {
  saveProviderAuth("openai", auth);
}

let inflightRefresh: Promise<StoredOpenAIAuth> | null = null;

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const refreshed = await refreshStoredAuth(refreshToken);
  return refreshed.tokens;
}

async function refreshStoredAuth(
  refreshToken: string,
  opts?: { source?: StoredOpenAIAuth["source"]; accountId?: string | null; authMode?: string | null; fallbackIdToken?: string | null },
): Promise<StoredOpenAIAuth> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_AUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const res = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: buildOpenAIJsonHeaders({
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body: body.toString(),
    });

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 400 && text.includes("invalid_grant")) {
        throw new AuthError(`Session expired — use login to re-authenticate. (${text})`);
      }
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const token = parseOpenAIJson<OpenAITokenResponse>(text, "Token refresh");
    return buildStoredAuth(token, opts?.source ?? "oauth", {
      accountId: opts?.accountId,
      authMode: opts?.authMode,
      fallbackRefreshToken: refreshToken,
      fallbackIdToken: opts?.fallbackIdToken ?? null,
    });
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const stored = loadStoredAuth();

  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens)) {
    say("Checking stored OpenAI session...");
    if (await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
      return { status: "already_authenticated", email: stored.profile?.email ?? null };
    }
  }

  if (stored?.tokens?.refreshToken) {
    say("Refreshing stored OpenAI session...");
    try {
      const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
        source: stored.source,
        accountId: stored.accountId,
        authMode: stored.authMode,
        fallbackIdToken: stored.idToken,
      });
      saveStoredAuth(refreshed);
      return { status: "refreshed", email: refreshed.profile?.email ?? null };
    } catch {
      // fall through to browser login
    }
  }

  const result = await login(callbacks);
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};

  const token = await runOpenAIBrowserOAuth(cbs);
  const auth = await buildStoredAuth(token, "oauth");
  saveStoredAuth(auth);
  return {
    tokens: auth.tokens,
    profile: auth.profile,
  };
}

export function hasConfiguredCredentials(): boolean {
  const stored = loadStoredAuth();
  return !!stored?.tokens?.accessToken || !!stored?.tokens?.refreshToken;
}

export function verifyAuth(accessToken: string, accountId?: string | null): Promise<boolean> {
  return verifyStoredSession(accessToken, accountId);
}

export async function getVerifiedAccessToken(): Promise<string> {
  return (await getVerifiedSession()).accessToken;
}

export interface VerifiedOpenAISession {
  accessToken: string;
  accountId: string | null;
}

export async function getVerifiedSession(): Promise<VerifiedOpenAISession> {
  const stored = loadStoredAuth();
  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens) && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
    return { accessToken: stored.tokens.accessToken, accountId: stored.accountId };
  }

  if (stored?.tokens?.refreshToken) {
    const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
      source: stored.source,
      accountId: stored.accountId,
      authMode: stored.authMode,
      fallbackIdToken: stored.idToken,
    });
    saveStoredAuth(refreshed);
    return { accessToken: refreshed.tokens.accessToken, accountId: refreshed.accountId };
  }

  throw new AuthError("OpenAI is not authenticated. Run `bun run src/main.ts login openai`.");
}

export function logout(): boolean {
  return clearProviderAuth("openai");
}
