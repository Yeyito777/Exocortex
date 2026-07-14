import { clearProviderAuth, isTokenExpired, loadProviderAuth, saveProviderAuth, type StoredTokens } from "../../store";
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
import { createHash } from "node:crypto";

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

/**
 * Non-secret fingerprint used to discard sockets carrying superseded auth.
 * Deriving it from persisted credentials also notices a login performed by a
 * separate Exocortex CLI process, without exposing token material to callers.
 */
export function getOpenAIAuthSessionRevision(): string | null {
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
  if (previousRejection) throw new Error(previousRejection);
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
      if (/invalid_grant|refresh_token_(?:reused|invalidated)/i.test(text)) {
        rejectedRefreshTokens.set(
          refreshTokenFingerprint(refreshToken),
          `Token refresh failed (${res.status}): ${text}`,
        );
      }
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

export async function ensureAuthenticated(callbacks?: LoginCallbacks, options?: LoginOptions): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const stored = loadStoredAuth();
  const storedRefreshRejected = !!stored?.tokens?.refreshToken
    && rejectedRefreshMessage(stored.tokens.refreshToken) !== null;

  if (stored?.tokens?.accessToken && !storedRefreshRejected && !isTokenExpired(stored.tokens)) {
    say("Checking stored OpenAI session...");
    if (await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
      const enriched = await enrichAndPersistAuth(stored);
      if (!enriched) return ensureAuthenticated(callbacks, options);
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
      if (!isCurrentStoredSession(stored)) return ensureAuthenticated(callbacks, options);
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
  if (hasConfiguredCredentials()) {
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
    accessToken: cached.accessToken,
    accountId: cached.accountId,
    accountKey: cached.accountKey,
  };
}

export async function getVerifiedSession(opts: { forceRefresh?: boolean } = {}): Promise<VerifiedOpenAISession> {
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
    if (!isCurrentStoredSession(stored)) return getVerifiedSession();
    saveAccountAt(index, enriched);
    return cacheVerifiedSession({ accessToken: enriched.tokens.accessToken, accountId: enriched.accountId, accountKey: getAccountKey(enriched) });
  }

  if (stored?.tokens?.refreshToken) {
    const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
      source: stored.source,
      accountId: stored.accountId,
      authMode: stored.authMode,
      fallbackIdToken: stored.idToken,
    });
    if (!isCurrentStoredSession(stored)) return getVerifiedSession();
    saveAccountAt(index, refreshed);
    return cacheVerifiedSession({ accessToken: refreshed.tokens.accessToken, accountId: refreshed.accountId, accountKey: getAccountKey(refreshed) });
  }

  if (stored?.tokens?.accessToken && await verifyStoredSession(stored.tokens.accessToken, stored.accountId)) {
    const enriched = await enrichStoredAuth(stored);
    if (!isCurrentStoredSession(stored)) return getVerifiedSession();
    saveAccountAt(index, enriched);
    return cacheVerifiedSession({ accessToken: enriched.tokens.accessToken, accountId: enriched.accountId, accountKey: getAccountKey(enriched) });
  }

  throw new AuthError("Current OpenAI account could not be verified. Use `/login openai` to re-authenticate it, or `/account <email>` to switch accounts.");
}

export function getCurrentAccountKey(): string | null {
  const stored = loadStoredAuth();
  return stored ? getAccountKey(stored) : null;
}

/** One-way persisted replay scope for a runtime account identity. */
export function accountScopeForKey(key: string | null | undefined): string | null {
  return key
    ? `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`
    : null;
}

/** Non-secret stable account identity suitable for persisted replay scoping. */
export function getCurrentAccountScope(): string | null {
  return accountScopeForKey(getCurrentAccountKey());
}

export function logout(): boolean {
  return clearProviderAuth("openai");
}
