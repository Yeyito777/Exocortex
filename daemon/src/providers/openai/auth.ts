import { borrowsSharedCredentials, clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type StoredTokens } from "../../store";
import { OPENAI_AUTH_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";
import { runOpenAIBrowserOAuth } from "./oauth";
import { runOpenAIDeviceOAuth } from "./device-oauth";
import {
  buildStoredAuth,
  enrichStoredAuth,
  type OpenAITokenResponse,
  type StoredOpenAIAuth,
  verifyAuth as verifyStoredSession,
} from "./session";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginOptions, LoginResult } from "../types";
import type { OAuthProfile } from "../../store";
import { createHash } from "node:crypto";
import { log } from "../../log";
import { providerProxyReady, providerProxyRemoteStatus, providerProxyRoute } from "../../provider-proxy/route";
import {
  clearOpenAIApiKey,
  deactivateOpenAIApiKey,
  loadOpenAIApiKey,
  normalizeOpenAIApiKey,
  openAIApiKeyAccountKey,
  saveOpenAIApiKey,
  verifyOpenAIApiKey,
  type StoredOpenAIApiKey,
} from "./api-key";

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
      updatedAt: current?.updatedAt ?? (typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString()),
    };
  }

  if (isStoredOpenAIAuth(value)) {
    return {
      ...value,
      multiAccountVersion: 1,
      accounts: [value],
      currentIndex: 0,
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

function saveAccountAt(index: number, auth: StoredOpenAIAuth): void {
  const pool = loadStoredAuthPool();
  if (index < 0 || index >= pool.accounts.length) return;
  pool.accounts[index] = auth;
  pool.currentIndex = index;
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

function authSessionFingerprint(stored: StoredOpenAIAuth | null | undefined): string | null {
  if (!stored) return null;
  return `sha256:${createHash("sha256").update(JSON.stringify([
    stored.accountId,
    stored.profile?.accountUuid,
    stored.tokens.accessToken,
    stored.tokens.refreshToken,
  ])).digest("hex").slice(0, 32)}`;
}

function isCurrentStoredSession(stored: StoredOpenAIAuth): boolean {
  return authSessionFingerprint(loadStoredAuth()) === authSessionFingerprint(stored);
}

function persistIfChanged(current: StoredOpenAIAuth, next: StoredOpenAIAuth): void {
  if (JSON.stringify(current) !== JSON.stringify(next)) {
    saveStoredAuth(next);
  }
}

async function enrichAndPersistAuth(auth: StoredOpenAIAuth): Promise<StoredOpenAIAuth | null> {
  const enriched = await enrichStoredAuth(auth);
  if (!isCurrentStoredSession(auth)) return null;
  persistIfChanged(auth, enriched);
  return enriched;
}

const inflightRefreshes = new Map<string, Promise<StoredOpenAIAuth>>();
const rejectedRefreshTokens = new Map<string, string>();
let browserOAuthForTest: typeof runOpenAIBrowserOAuth | null = null;
let deviceOAuthForTest: typeof runOpenAIDeviceOAuth | null = null;

function refreshTokenFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function rejectedRefreshMessage(refreshToken: string): string | null {
  return rejectedRefreshTokens.get(refreshTokenFingerprint(refreshToken)) ?? null;
}

/** Why this account's refresh token was definitively rejected, this run or an earlier one. */
function storedRefreshRejection(stored: StoredOpenAIAuth | null | undefined): string | null {
  if (!stored) return null;
  const token = stored.tokens?.refreshToken;
  return (token ? rejectedRefreshMessage(token) : null) ?? (stored.refreshRejected?.trim() || null);
}

// OpenAI answers a dead refresh token with 400 invalid_grant or, for an expired
// ChatGPT session, 401 refresh_token_expired. Neither recovers on retry.
const DEFINITIVE_REFRESH_REJECTION = /invalid_grant|refresh_token_(?:expired|reused|invalidated|revoked)/i;

function definitiveRefreshRejection(status: number, text: string): string | null {
  if (status !== 400 && status !== 401) return null;
  const code = DEFINITIVE_REFRESH_REJECTION.exec(text)?.[0];
  if (!code) return null;
  return `OpenAI ChatGPT session expired (${status} ${code}). Log in again with \`/login openai\`, or use an API key with \`/login openai key <api-key>\`.`;
}

/** Remember a dead refresh token in memory and on the account record, so nothing hammers the token endpoint with it. */
function rememberRejectedRefreshToken(refreshToken: string, message: string): void {
  rejectedRefreshTokens.set(refreshTokenFingerprint(refreshToken), message);
  const pool = loadStoredAuthPool();
  let changed = false;
  for (const account of pool.accounts) {
    if (account.tokens?.refreshToken === refreshToken && account.refreshRejected !== message) {
      account.refreshRejected = message;
      changed = true;
    }
  }
  if (changed) saveStoredAuthPool(pool);
}

/**
 * Non-secret fingerprint used to discard sockets carrying superseded auth.
 * Deriving it from persisted credentials also notices a login performed by a
 * separate Exocortex CLI process, without exposing token material to callers.
 */
export function getOpenAIAuthSessionRevision(): string | null {
  if (currentOpenAILoginKind() === "api_key") {
    const apiKey = loadOpenAIApiKey();
    if (apiKey) return `sha256:${createHash("sha256").update(JSON.stringify(["api_key", apiKey.apiKey])).digest("hex").slice(0, 32)}`;
  }
  return authSessionFingerprint(loadStoredAuth());
}

export function setOpenAIBrowserOAuthForTest(override: typeof runOpenAIBrowserOAuth | null): void {
  browserOAuthForTest = override;
  if (override === null) rejectedRefreshTokens.clear();
}

export function setOpenAIDeviceOAuthForTest(override: typeof runOpenAIDeviceOAuth | null): void {
  deviceOAuthForTest = override;
}

function runOAuth(callbacks?: LoginCallbacks, method: LoginOptions["method"] = "browser") {
  if (method === "code") return (deviceOAuthForTest ?? runOpenAIDeviceOAuth)(callbacks);
  if (method === "browser") return (browserOAuthForTest ?? runOpenAIBrowserOAuth)(callbacks);
  throw new AuthError(`Unsupported OpenAI login method: ${String(method)}`);
}

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const refreshed = await refreshStoredAuth(refreshToken);
  return refreshed.tokens;
}

async function refreshStoredAuth(
  refreshToken: string,
  opts?: { source?: StoredOpenAIAuth["source"]; accountId?: string | null; authMode?: string | null; fallbackIdToken?: string | null },
): Promise<StoredOpenAIAuth> {
  const previousRejection = rejectedRefreshMessage(refreshToken);
  if (previousRejection) throw new AuthError(previousRejection);
  // OpenAI rotates refresh tokens, and replaying a rotated one can revoke the
  // whole login: a test daemon borrowing the main's logins never refreshes.
  if (borrowsSharedCredentials()) {
    throw new AuthError("This test daemon borrows the main daemon's ChatGPT login and never refreshes it (a refresh here could sign the main daemon out). The main daemon refreshes it when it next uses OpenAI.");
  }
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
      const rejection = definitiveRefreshRejection(res.status, text);
      if (rejection) {
        rememberRejectedRefreshToken(refreshToken, rejection);
        log("warn", `openai auth: refresh token rejected (${res.status}); the ChatGPT account needs a new login`);
        throw new AuthError(rejection);
      }
      throw new Error(`Token refresh failed (${res.status}): ${text.slice(0, 500)}`);
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

export async function ensureAuthenticated(callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult> {
  const apiKey = normalizeOpenAIApiKey(options?.apiKey);
  if (apiKey) {
    const result = await loginWithApiKey(apiKey, callbacks, options);
    return { status: "logged_in", email: result.profile?.displayName ?? null };
  }
  rejectMethodSwitchDuringTurns("chatgpt", options);
  const result = await ensureChatGPTAuthenticated(callbacks, options);
  // Logging in with the ChatGPT account makes it the selected method again.
  deactivateOpenAIApiKey();
  verifiedSessionCache = null;
  return result;
}

async function ensureChatGPTAuthenticated(callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const stored = loadStoredAuth();
  const storedRefreshRejected = storedRefreshRejection(stored) !== null;

  if (stored?.tokens?.accessToken && !storedRefreshRejected && !isTokenExpired(stored.tokens)) {
    say("Checking stored OpenAI session...");
    if (await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
      const enriched = await enrichAndPersistAuth(stored);
      if (!enriched) return ensureChatGPTAuthenticated(callbacks, options);
      return { status: "already_authenticated", email: enriched.profile?.email ?? null };
    }
  }

  if (stored?.tokens?.refreshToken && !storedRefreshRejected) {
    say("Refreshing stored OpenAI session...");
    try {
      const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
        source: stored.source,
        accountId: stored.accountId,
        authMode: stored.authMode,
        fallbackIdToken: stored.idToken,
      });
      if (!isCurrentStoredSession(stored)) return ensureChatGPTAuthenticated(callbacks, options);
      saveStoredAuth(refreshed);
      return { status: "refreshed", email: refreshed.profile?.email ?? null };
    } catch {
      // Fall through to the user-selected interactive login flow.
    }
  }

  if (storedRefreshRejected) say("Stored OpenAI session was rejected; re-authenticating...");
  if (!stored && options?.requireSameAccount) {
    throw new AuthError("Cannot safely authenticate active OpenAI turns because their current account credentials are missing.");
  }

  const result = stored
    ? await replaceCurrentAccount(stored, callbacks, options?.requireSameAccount === true, options?.method)
    : await login(callbacks, options);
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult> {
  const apiKey = normalizeOpenAIApiKey(options?.apiKey);
  if (apiKey) {
    return loginWithApiKey(apiKey, typeof callbacks === "function" ? { onProgress: callbacks } : callbacks, options);
  }
  if (hasChatGPTCredentials()) {
    throw new AuthError("OpenAI is already authenticated. Use `/login openai add` to connect another account.");
  }
  return addAccount(callbacks, options);
}

export async function addAccount(callbacks?: LoginCallbacks | ((msg: string) => void), options?: LoginOptions): Promise<LoginResult> {
  const cbs = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};

  const token = await runOAuth(cbs, options?.method);
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
  deactivateOpenAIApiKey();
  verifiedSessionCache = null;
  return {
    tokens: auth.tokens,
    profile: auth.profile,
  };
}

function hasStableAccountIdentity(auth: StoredOpenAIAuth | null | undefined): boolean {
  return !!(auth?.accountId?.trim() || auth?.profile?.accountUuid?.trim() || auth?.profile?.email?.trim());
}

function accountsRepresentSameIdentity(
  expected: StoredOpenAIAuth | null | undefined,
  replacement: StoredOpenAIAuth | null | undefined,
): boolean {
  if (!expected || !replacement) return false;
  const expectedAccountId = expected.accountId?.trim() || null;
  const replacementAccountId = replacement.accountId?.trim() || null;
  // ChatGPT-Account-ID is the strongest identity and scopes encrypted replay.
  // If both logins resolved one, an email match must not hide a workspace change.
  if (expectedAccountId && replacementAccountId) return expectedAccountId === replacementAccountId;

  const expectedEmail = expected.profile?.email?.trim().toLowerCase() || null;
  const replacementEmail = replacement.profile?.email?.trim().toLowerCase() || null;
  if (expectedEmail && replacementEmail && expectedEmail === replacementEmail) return true;

  const expectedProfileId = expected.profile?.accountUuid?.trim() || null;
  const replacementProfileId = replacement.profile?.accountUuid?.trim() || null;
  return !!expectedProfileId && expectedProfileId === replacementProfileId;
}

function preserveCurrentAccountScope(
  expected: StoredOpenAIAuth,
  replacement: StoredOpenAIAuth,
): StoredOpenAIAuth {
  if (replacement.accountId) return replacement;
  const accountId = expected.accountId;
  const accountUuid = expected.profile?.accountUuid || accountId || replacement.profile?.accountUuid || "";
  return {
    ...replacement,
    accountId,
    profile: replacement.profile ? {
      ...replacement.profile,
      accountUuid,
      email: replacement.profile.email || expected.profile?.email || "",
    } : expected.profile,
  };
}

async function replaceCurrentAccount(
  expected: StoredOpenAIAuth,
  callbacks?: LoginCallbacks,
  requireSameAccount = false,
  method: LoginOptions["method"] = "browser",
): Promise<LoginResult> {
  if (requireSameAccount && !hasStableAccountIdentity(expected)) {
    throw new AuthError("Cannot safely re-authenticate an active OpenAI turn because the current account identity is unknown.");
  }

  const token = await runOAuth(callbacks ?? {}, method);
  const replacementAuth = await buildStoredAuth(token, "oauth");
  if (hasStableAccountIdentity(expected) && !accountsRepresentSameIdentity(expected, replacementAuth)) {
    throw new AuthError(
      "Reauthentication returned a different OpenAI account. Sign in with the current account, or use `/login openai add` after active OpenAI turns finish.",
    );
  }
  if (requireSameAccount && !hasStableAccountIdentity(replacementAuth)) {
    throw new AuthError("OpenAI did not return enough account information to safely resume active turns.");
  }
  const auth = preserveCurrentAccountScope(expected, replacementAuth);

  // Reload after interactive OAuth: active requests may have refreshed the same
  // account while the callback was pending. Account mutations are blocked by
  // the handler, but verify that invariant before replacing anything on disk.
  const pool = loadStoredAuthPool();
  const currentIndex = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
  const current = pool.accounts[currentIndex];
  if (!current) {
    throw new AuthError("The current OpenAI account was removed while reauthentication was in progress.");
  }
  if (hasStableAccountIdentity(expected) && !accountsRepresentSameIdentity(expected, current)) {
    throw new AuthError("The selected OpenAI account changed while reauthentication was in progress. Please retry `/login openai`.");
  }

  pool.accounts[currentIndex] = auth;
  pool.currentIndex = currentIndex;
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
  const email = auth.profile?.email?.trim().toLowerCase() ?? null;
  return auth.profile?.email?.toLowerCase() === normalized
    || (email !== null && censorEmailForIdentifier(email) === normalized)
    || auth.accountId?.toLowerCase() === normalized
    || auth.profile?.accountUuid?.toLowerCase() === normalized;
}

function censorEmailForIdentifier(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "******";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
}

export function removeAccount(identifier?: string): OpenAIAccountSummary {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    throw new AuthError("No OpenAI accounts are connected.");
  }
  if (!identifier?.trim() && pool.accounts.length > 1) {
    throw new AuthError("Specify which OpenAI account to remove: `/login openai remove <email>`.");
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
    throw new AuthError("Specify which OpenAI account to switch to: `/account <email>`.");
  }

  const switchIndex = pool.accounts.findIndex((auth, i) => matchesAccountIdentifier(auth, i, identifier));
  if (switchIndex < 0) {
    throw new AuthError(`OpenAI account not found: ${identifier}`);
  }

  pool.currentIndex = switchIndex;
  saveStoredAuthPool(pool);
  deactivateOpenAIApiKey();

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

export function hasChatGPTCredentials(): boolean {
  return loadStoredAuthPool().accounts.some((stored) => !!stored.tokens?.accessToken || !!stored.tokens?.refreshToken);
}

export function hasConfiguredCredentials(): boolean {
  return hasChatGPTCredentials() || loadOpenAIApiKey() !== null;
}

// ── API-key login ─────────────────────────────────────────────────

export type OpenAILoginKind = "chatgpt" | "api_key";

/** Whether the current ChatGPT account can still produce a token without a new login. */
function chatGPTSessionUsable(stored: StoredOpenAIAuth | null): boolean {
  if (!stored?.tokens) return false;
  if (stored.tokens.accessToken && !isTokenExpired(stored.tokens)) return true;
  return !!stored.tokens.refreshToken && storedRefreshRejection(stored) === null;
}

/**
 * Which login the openai provider uses right now. The most recent login wins;
 * a ChatGPT session that expired falls back to a stored API key rather than
 * blocking it.
 */
export function currentOpenAILoginKind(): OpenAILoginKind | null {
  const apiKey = loadOpenAIApiKey();
  const stored = loadStoredAuth();
  if (!apiKey) return stored ? "chatgpt" : null;
  if (apiKey.active || !stored) return "api_key";
  return chatGPTSessionUsable(stored) ? "chatgpt" : "api_key";
}

function apiKeyProfile(stored: StoredOpenAIApiKey): OAuthProfile {
  return {
    accountUuid: stored.label,
    email: "",
    displayName: `API key ${stored.label}`,
    organizationUuid: null,
    organizationName: "OpenAI API",
    organizationType: "api_key",
    organizationRole: null,
    workspaceRole: null,
  };
}

/** The selected API key's display identity, when the API key is the login in use. */
export function getActiveOpenAIApiKeyInfo(): { label: string; displayName: string; updatedAt: string } | null {
  if (providerProxyRoute("openai")) return null;
  if (currentOpenAILoginKind() !== "api_key") return null;
  const stored = loadOpenAIApiKey();
  return stored ? { label: stored.label, displayName: apiKeyProfile(stored).displayName ?? stored.label, updatedAt: stored.updatedAt } : null;
}

/**
 * Switching between the ChatGPT account and an API key changes the account
 * that scopes encrypted replay; running turns could not continue across it.
 */
function rejectMethodSwitchDuringTurns(target: OpenAILoginKind, options?: LoginOptions, apiKey?: string): void {
  if (!options?.requireSameAccount) return;
  const current = currentOpenAILoginKind();
  if (current === null) return;
  const sameKey = target !== "api_key" || loadOpenAIApiKey()?.apiKey === apiKey;
  if (current === target && sameKey) return;
  throw new AuthError(target === "api_key"
    ? "OpenAI turns are running on another login; switch to an API key after they finish."
    : "OpenAI turns are running on the API key; switch back to the ChatGPT account after they finish.");
}

async function loginWithApiKey(apiKey: string, callbacks?: LoginCallbacks, options?: LoginOptions): Promise<LoginResult> {
  rejectMethodSwitchDuringTurns("api_key", options, apiKey);
  callbacks?.onProgress?.("Verifying OpenAI API key...");
  const verified = await verifyOpenAIApiKey(apiKey);
  const stored = saveOpenAIApiKey(apiKey, verified.modelIds);
  verifiedSessionCache = null;
  log("info", `openai auth: API key ${stored.label} saved (${verified.modelIds.length} models)`);
  return { profile: apiKeyProfile(stored) };
}

function apiKeySession(stored: StoredOpenAIApiKey): VerifiedOpenAISession {
  return { kind: "api_key", accessToken: stored.apiKey, accountId: null, accountKey: openAIApiKeyAccountKey(stored.apiKey) };
}

export function verifyAuth(accessToken: string, accountId?: string | null): Promise<boolean> {
  return verifyStoredSession(accessToken, accountId);
}

export async function getVerifiedAccessToken(): Promise<string> {
  return (await getVerifiedSession()).accessToken;
}

export interface VerifiedOpenAISession {
  /** ChatGPT account (chatgpt.com backend) or API key (public API). Absent means ChatGPT. */
  kind?: OpenAILoginKind;
  accessToken: string;
  accountId: string | null;
  accountKey: string | null;
}

const VERIFIED_SESSION_CACHE_TTL_MS = 60_000;

let verifiedSessionCache: (VerifiedOpenAISession & {
  checkedAt: number;
}) | null = null;

function cacheVerifiedSession(session: VerifiedOpenAISession): VerifiedOpenAISession {
  verifiedSessionCache = { ...session, checkedAt: Date.now() };
  return session;
}

function cachedVerifiedSessionFor(stored: StoredOpenAIAuth): VerifiedOpenAISession | null {
  const cached = verifiedSessionCache;
  if (!cached) return null;
  if (Date.now() - cached.checkedAt > VERIFIED_SESSION_CACHE_TTL_MS) return null;
  if (cached.accessToken !== stored.tokens.accessToken) return null;
  if (cached.accountId !== stored.accountId) return null;
  return {
    kind: "chatgpt",
    accessToken: cached.accessToken,
    accountId: cached.accountId,
    accountKey: cached.accountKey,
  };
}

/**
 * Under /proxy the remote machine authenticates requests: they carry the local
 * forwarder's secret, which the remote replaces with its own token, and the
 * remote's account scopes replayed reasoning.
 */
async function proxiedSession(): Promise<VerifiedOpenAISession | null> {
  const route = providerProxyRoute("openai");
  if (!route) return null;
  const remote = await providerProxyReady("openai");
  return { kind: "chatgpt", accessToken: route.token, accountId: null, accountKey: proxiedAccountKey(remote.accountScope, route.alias) };
}

function proxiedAccountKey(remoteScope: string | null | undefined, alias: string): string {
  return `proxy:${remoteScope ?? alias}`;
}

/**
 * The session requests use: the API key or the ChatGPT account, whichever
 * login is current. `chatgptOnly` is for ChatGPT-backend features (usage
 * windows, transcription, image generation, /proxy) that an API key cannot use.
 */
export async function getVerifiedSession(opts: { forceRefresh?: boolean; chatgptOnly?: boolean } = {}): Promise<VerifiedOpenAISession> {
  const proxied = await proxiedSession();
  if (proxied) return proxied;
  if (opts.chatgptOnly) return getVerifiedChatGPTSession(opts);
  const apiKey = loadOpenAIApiKey();
  if (!apiKey) return getVerifiedChatGPTSession(opts);
  if (currentOpenAILoginKind() === "api_key") return apiKeySession(apiKey);
  try {
    return await getVerifiedChatGPTSession(opts);
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    log("warn", `openai auth: ChatGPT session unusable (${err.message}); using the API key ${apiKey.label}`);
    return apiKeySession(apiKey);
  }
}

async function getVerifiedChatGPTSession(opts: { forceRefresh?: boolean } = {}): Promise<VerifiedOpenAISession> {
  const pool = loadStoredAuthPool();
  if (pool.accounts.length === 0) {
    throw new AuthError("OpenAI is not authenticated. Run `/login openai`.");
  }

  const index = normalizeCurrentIndex(pool.currentIndex, pool.accounts.length);
  const stored = pool.accounts[index];

  const cached = !opts.forceRefresh && stored?.tokens?.accessToken && !isTokenExpired(stored.tokens)
    ? cachedVerifiedSessionFor(stored)
    : null;
  if (cached) return cached;

  if (
    stored?.tokens?.accessToken
    && !opts.forceRefresh
    && !isTokenExpired(stored.tokens)
    && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)
  ) {
    const enriched = await enrichStoredAuth(stored);
    if (!isCurrentStoredSession(stored)) return getVerifiedChatGPTSession();
    saveAccountAt(index, enriched);
    return cacheVerifiedSession({ kind: "chatgpt", accessToken: enriched.tokens.accessToken, accountId: enriched.accountId, accountKey: getAccountKey(enriched) });
  }

  const rejection = storedRefreshRejection(stored);
  if (rejection) throw new AuthError(rejection);

  if (stored?.tokens?.refreshToken) {
    const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
      source: stored.source,
      accountId: stored.accountId,
      authMode: stored.authMode,
      fallbackIdToken: stored.idToken,
    });
    if (!isCurrentStoredSession(stored)) return getVerifiedChatGPTSession();
    saveAccountAt(index, refreshed);
    return cacheVerifiedSession({ kind: "chatgpt", accessToken: refreshed.tokens.accessToken, accountId: refreshed.accountId, accountKey: getAccountKey(refreshed) });
  }

  if (stored?.tokens?.accessToken && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
    const enriched = await enrichStoredAuth(stored);
    if (!isCurrentStoredSession(stored)) return getVerifiedChatGPTSession();
    saveAccountAt(index, enriched);
    return cacheVerifiedSession({ kind: "chatgpt", accessToken: enriched.tokens.accessToken, accountId: enriched.accountId, accountKey: getAccountKey(enriched) });
  }

  throw new AuthError("Current OpenAI account could not be verified. Use `/login openai` to re-authenticate it, or `/account <email>` to switch accounts.");
}

export function getCurrentAccountKey(): string | null {
  const route = providerProxyRoute("openai");
  if (route) return proxiedAccountKey(providerProxyRemoteStatus("openai")?.accountScope, route.alias);
  if (currentOpenAILoginKind() === "api_key") {
    const apiKey = loadOpenAIApiKey();
    if (apiKey) return openAIApiKeyAccountKey(apiKey.apiKey);
  }
  const stored = loadStoredAuth();
  return stored ? getAccountKey(stored) : null;
}

/** One-way persisted replay scope for a runtime account identity. */
export function accountScopeForKey(key: string | null | undefined): string | null {
  return key
    ? `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`
    : null;
}

/** Replay scope of the ChatGPT account, whichever login is current (for /proxy, which serves only ChatGPT). */
export function getChatGPTAccountScope(): string | null {
  const stored = loadStoredAuth();
  return accountScopeForKey(stored ? getAccountKey(stored) : null);
}

/** Non-secret stable account identity suitable for persisted replay scoping. */
export function getCurrentAccountScope(): string | null {
  return accountScopeForKey(getCurrentAccountKey());
}

export function logout(): boolean {
  verifiedSessionCache = null;
  const clearedApiKey = clearOpenAIApiKey();
  return clearProviderAuth("openai") || clearedApiKey;
}
