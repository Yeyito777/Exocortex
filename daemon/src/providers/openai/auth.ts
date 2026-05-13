import { clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type StoredTokens } from "../../store";
import { OPENAI_AUTH_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";
import { runOpenAIBrowserOAuth } from "./oauth";
import {
  buildStoredAuth,
  enrichStoredAuth,
  type OpenAITokenResponse,
  type StoredOpenAIAuth,
  verifyAuth as verifyStoredSession,
} from "./session";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";

export interface StoredOpenAIAuthPool extends StoredOpenAIAuth {
  /**
   * Keep the currently selected account duplicated at the top level (tokens,
   * profile, etc.) so older Exocortex builds still see a normal OpenAI login.
   */
  multiAccountVersion: 1;
  /** Older dev builds briefly wrote `version: 1`; keep reading it but do not rely on it. */
  version?: 1;
  accounts: StoredOpenAIAuth[];
  currentIndex: number;
  /** One-shot override set by `/login openai switch` so the next request uses the selected account. */
  nextIndexOverride?: number | null;
}

export interface OpenAIAccountSummary {
  index: number;
  email: string | null;
  displayName: string | null;
  plan: string | null;
  accountId: string | null;
  current: boolean;
  updatedAt: string | null;
}

function isStoredOpenAIAuth(value: unknown): value is StoredOpenAIAuth {
  return typeof value === "object" && value !== null && "tokens" in value;
}

function isStoredOpenAIAuthPool(value: unknown): value is StoredOpenAIAuthPool {
  return typeof value === "object" && value !== null && "accounts" in value && Array.isArray((value as { accounts?: unknown }).accounts);
}

function normalizeCurrentIndex(index: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

function toAuthPool(value: StoredOpenAIAuth | StoredOpenAIAuthPool | null): StoredOpenAIAuthPool {
  if (isStoredOpenAIAuthPool(value)) {
    const accounts = value.accounts.filter(isStoredOpenAIAuth);
    const currentIndex = normalizeCurrentIndex(value.currentIndex, accounts.length);
    const current = accounts[currentIndex];
    return {
      ...(current ?? value),
      multiAccountVersion: 1,
      version: 1,
      accounts,
      currentIndex,
      nextIndexOverride: typeof value.nextIndexOverride === "number"
        ? normalizeCurrentIndex(value.nextIndexOverride, accounts.length)
        : null,
      updatedAt: current?.updatedAt ?? (typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()),
    };
  }

  if (isStoredOpenAIAuth(value)) {
    return {
      ...value,
      multiAccountVersion: 1,
      accounts: [value],
      currentIndex: 0,
      nextIndexOverride: null,
      updatedAt: value.updatedAt ?? new Date().toISOString(),
    };
  }

  return {
    tokens: {
      accessToken: "",
      refreshToken: null,
      expiresAt: 0,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
    },
    profile: null,
    source: "oauth",
    authMode: null,
    accountId: null,
    idToken: null,
    accounts: [],
    currentIndex: -1,
    nextIndexOverride: null,
    updatedAt: new Date().toISOString(),
    multiAccountVersion: 1,
  };
}

function loadStoredAuthPool(): StoredOpenAIAuthPool {
  return toAuthPool(loadProviderAuth<StoredOpenAIAuth | StoredOpenAIAuthPool>("openai"));
}

function saveStoredAuthPool(pool: StoredOpenAIAuthPool): void {
  const accounts = pool.accounts.filter(isStoredOpenAIAuth);
  if (accounts.length === 0) {
    clearProviderAuth("openai");
    return;
  }

  const currentIndex = normalizeCurrentIndex(pool.currentIndex, accounts.length);
  const current = accounts[currentIndex];

  saveProviderAuth("openai", {
    ...current,
    multiAccountVersion: 1,
    accounts,
    currentIndex,
    nextIndexOverride: pool.nextIndexOverride == null ? null : normalizeCurrentIndex(pool.nextIndexOverride, accounts.length),
    updatedAt: new Date().toISOString(),
  } satisfies StoredOpenAIAuthPool);
}

function getAccountKey(auth: StoredOpenAIAuth): string {
  return auth.profile?.accountUuid?.trim()
    || auth.accountId?.trim()
    || auth.profile?.email?.trim().toLowerCase()
    || auth.tokens.refreshToken
    || auth.tokens.accessToken;
}

function saveAccountAt(index: number, auth: StoredOpenAIAuth, opts: { clearNextOverride?: boolean } = {}): void {
  const pool = loadStoredAuthPool();
  if (index < 0 || index >= pool.accounts.length) return;
  pool.accounts[index] = auth;
  pool.currentIndex = index;
  if (opts.clearNextOverride) pool.nextIndexOverride = null;
  saveStoredAuthPool(pool);
}

function loadStoredAuth(): StoredOpenAIAuth | null {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) return null;
  return pool.accounts[normalizeCurrentIndex(pool.currentIndex, pool.accounts.length)] ?? null;
}

function saveStoredAuth(auth: StoredOpenAIAuth): void {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    saveStoredAuthPool(toAuthPool(auth));
    return;
  }
  pool.accounts[normalizeCurrentIndex(pool.currentIndex, pool.accounts.length)] = auth;
  saveStoredAuthPool(pool);
}

function persistIfChanged(current: StoredOpenAIAuth, next: StoredOpenAIAuth): void {
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    saveStoredAuth(next);
  }
}

async function enrichAndPersistAuth(auth: StoredOpenAIAuth): Promise<StoredOpenAIAuth> {
  const enriched = await enrichStoredAuth(auth);
  persistIfChanged(auth, enriched);
  return enriched;
}

const inflightRefreshes = new Map<string, Promise<StoredOpenAIAuth>>();

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const refreshed = await refreshStoredAuth(refreshToken);
  return refreshed.tokens;
}

async function refreshStoredAuth(
  refreshToken: string,
  opts?: { source?: StoredOpenAIAuth["source"]; accountId?: string | null; authMode?: string | null; fallbackIdToken?: string | null },
): Promise<StoredOpenAIAuth> {
  const existing = inflightRefreshes.get(refreshToken);
  if (existing) return existing;

  const inflightRefresh = (async () => {
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
    inflightRefreshes.delete(refreshToken);
  });
  inflightRefreshes.set(refreshToken, inflightRefresh);
  return inflightRefresh;
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const stored = loadStoredAuth();

  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens)) {
    say("Checking stored OpenAI session...");
    if (await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
      const enriched = await enrichAndPersistAuth(stored);
      return { status: "already_authenticated", email: enriched.profile?.email ?? null };
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
  if (hasConfiguredCredentials()) {
    throw new AuthError("OpenAI is already authenticated. Use `/login openai add` to connect another account.");
  }
  return addAccount(callbacks);
}

export async function addAccount(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};

  const token = await runOpenAIBrowserOAuth(cbs);
  const auth = await buildStoredAuth(token, "oauth");

  const pool = loadStoredAuthPool();
  const key = getAccountKey(auth);
  const existingIndex = pool.accounts.findIndex((candidate) => getAccountKey(candidate) === key);
  if (existingIndex >= 0) {
    pool.accounts[existingIndex] = auth;
    pool.currentIndex = existingIndex;
  } else {
    pool.accounts.push(auth);
    pool.currentIndex = pool.accounts.length - 1;
  }
  saveStoredAuthPool(pool);
  return {
    tokens: auth.tokens,
    profile: auth.profile,
  };
}

export function listAccounts(): OpenAIAccountSummary[] {
  const pool = loadStoredAuthPool();
  const currentIndex = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
  return pool.accounts.map((auth, i) => ({
    index: i + 1,
    email: auth.profile?.email?.trim() || null,
    displayName: auth.profile?.displayName?.trim() || null,
    plan: auth.tokens.subscriptionType ?? null,
    accountId: auth.accountId ?? auth.profile?.accountUuid ?? null,
    current: i === currentIndex,
    updatedAt: auth.updatedAt ?? null,
  }));
}

function matchesAccountIdentifier(auth: StoredOpenAIAuth, index: number, identifier: string): boolean {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized) return false;
  if (/^#?\d+$/.test(normalized)) {
    return index + 1 === Number(normalized.replace(/^#/, ""));
  }
  return auth.profile?.email?.toLowerCase() === normalized
    || auth.accountId?.toLowerCase() === normalized
    || auth.profile?.accountUuid?.toLowerCase() === normalized;
}

export function removeAccount(identifier?: string): OpenAIAccountSummary {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    throw new AuthError("No OpenAI accounts are connected.");
  }
  if (!identifier?.trim() && pool.accounts.length > 1) {
    throw new AuthError("Specify which OpenAI account to remove: `/login openai remove <email-or-number>`.");
  }

  const currentIndex = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
  const removeIndex = identifier?.trim()
    ? pool.accounts.findIndex((auth, i) => matchesAccountIdentifier(auth, i, identifier))
    : currentIndex;
  if (removeIndex < 0) {
    throw new AuthError(`OpenAI account not found: ${identifier}`);
  }

  const [removed] = pool.accounts.splice(removeIndex, 1);
  const summary: OpenAIAccountSummary = {
    index: removeIndex + 1,
    email: removed.profile?.email?.trim() || null,
    displayName: removed.profile?.displayName?.trim() || null,
    plan: removed.tokens.subscriptionType ?? null,
    accountId: removed.accountId ?? removed.profile?.accountUuid ?? null,
    current: removeIndex === currentIndex,
    updatedAt: removed.updatedAt ?? null,
  };

  if (pool.accounts.length === 0) {
    clearProviderAuth("openai");
  } else {
    pool.currentIndex = removeIndex <= currentIndex ? currentIndex - 1 : currentIndex;
    pool.currentIndex = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
    saveStoredAuthPool(pool);
  }

  return summary;
}

export function switchAccount(identifier?: string): OpenAIAccountSummary {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    throw new AuthError("No OpenAI accounts are connected.");
  }
  if (!identifier?.trim()) {
    throw new AuthError("Specify which OpenAI account to switch to: `/login openai switch <email-or-number>`.");
  }

  const switchIndex = pool.accounts.findIndex((auth, i) => matchesAccountIdentifier(auth, i, identifier));
  if (switchIndex < 0) {
    throw new AuthError(`OpenAI account not found: ${identifier}`);
  }

  pool.currentIndex = switchIndex;
  pool.nextIndexOverride = switchIndex;
  saveStoredAuthPool(pool);

  const switched = pool.accounts[switchIndex];
  return {
    index: switchIndex + 1,
    email: switched.profile?.email?.trim() || null,
    displayName: switched.profile?.displayName?.trim() || null,
    plan: switched.tokens.subscriptionType ?? null,
    accountId: switched.accountId ?? switched.profile?.accountUuid ?? null,
    current: true,
    updatedAt: switched.updatedAt ?? null,
  };
}

export function hasConfiguredCredentials(): boolean {
  return loadStoredAuthPool().accounts.some((stored) => !!stored.tokens?.accessToken || !!stored.tokens?.refreshToken);
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

export async function getVerifiedSession(opts: { forceRefresh?: boolean } = {}): Promise<VerifiedOpenAISession> {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    throw new AuthError("OpenAI is not authenticated. Run `/login openai`.");
  }

  const currentIndex = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
  const overrideIndex = pool.nextIndexOverride == null ? null : normalizeCurrentIndex(pool.nextIndexOverride, pool.accounts.length);
  const startIndex = overrideIndex != null
    ? overrideIndex
    : opts.forceRefresh || pool.accounts.length === 1
    ? currentIndex
    : (currentIndex + 1) % pool.accounts.length;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < pool.accounts.length; attempt++) {
    const index = (startIndex + attempt) % pool.accounts.length;
    const stored = pool.accounts[index];

    if (
      stored?.tokens?.accessToken
      && !opts.forceRefresh
      && !isTokenExpired(stored.tokens)
      && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)
    ) {
      const enriched = await enrichStoredAuth(stored);
      saveAccountAt(index, enriched, { clearNextOverride: overrideIndex != null });
      return { accessToken: enriched.tokens.accessToken, accountId: enriched.accountId };
    }

    if (stored?.tokens?.refreshToken) {
      try {
        const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
          source: stored.source,
          accountId: stored.accountId,
          authMode: stored.authMode,
          fallbackIdToken: stored.idToken,
        });
        saveAccountAt(index, refreshed, { clearNextOverride: overrideIndex != null });
        return { accessToken: refreshed.tokens.accessToken, accountId: refreshed.accountId };
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        lastErr = err;
        continue;
      }
    }

    if (stored?.tokens?.accessToken && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
      const enriched = await enrichStoredAuth(stored);
      saveAccountAt(index, enriched, { clearNextOverride: overrideIndex != null });
      return { accessToken: enriched.tokens.accessToken, accountId: enriched.accountId };
    }

    lastErr = new AuthError("OpenAI account could not be verified.");
  }

  if (lastErr instanceof AuthError) throw lastErr;
  throw new AuthError("OpenAI is not authenticated. Run `/login openai`.");
}

export function getCurrentAccountKey(): string | null {
  const stored = loadStoredAuth();
  return stored ? getAccountKey(stored) : null;
}

export function logout(): boolean {
  return clearProviderAuth("openai");
}
