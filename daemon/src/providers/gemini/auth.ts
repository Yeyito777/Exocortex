/**
 * Sign-in for the gemini provider. The Antigravity CLI owns the Google
 * sign-in (its own token store or the OS keyring); Exocortex keeps only
 * account metadata, shaped like other providers' stored auth, and checks the
 * sign-in by running `agy models`, which fails without one.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProviderAuth, saveProviderAuth, type OAuthProfile, type StoredAuth } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";
import { agyMissingMessage, getAgyVersion, hasAgyBinary, loginWithAgy } from "./cli";
import { AgyNotSignedInError, listAgyModels } from "./models";
import { lastGeminiQuota, readGeminiQuota } from "./usage";

const PROVIDER_ID = "gemini";
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;
const STATUS_TTL_MS = 10 * 60_000;

interface StoredGeminiAuth extends StoredAuth {
  source: "antigravity-cli";
  cliVersion: string | null;
}

interface DisconnectedGeminiAuth {
  source: "disconnected";
  updatedAt: string;
}

let checkedAt = 0;
let checkedOk = false;
let inflight: Promise<boolean> | null = null;
let planName: string | null = null;

function loadStored(): StoredGeminiAuth | DisconnectedGeminiAuth | null {
  return loadProviderAuth<StoredGeminiAuth | DisconnectedGeminiAuth>(PROVIDER_ID);
}

/** The signed-in Google account: from the CLI's `/usage` report, else Google's own active-account file (that field only). */
function accountEmail(): string | null {
  const fromQuota = lastGeminiQuota()?.account;
  if (fromQuota) return fromQuota;
  const file = join(homedir(), ".gemini", "google_accounts.json");
  if (!existsSync(file)) return null;
  try {
    const active = (JSON.parse(readFileSync(file, "utf8")) as { active?: unknown }).active;
    return typeof active === "string" && active.includes("@") ? active : null;
  } catch {
    return null;
  }
}

/** The plan the CLI reported for this account (ACP session metadata, e.g. "Google AI Pro"). */
export function noteGeminiPlan(name: string | null | undefined): void {
  if (!name || name === planName) return;
  planName = name;
  const stored = loadStored();
  if (stored?.source === "antigravity-cli") saveProviderAuth(PROVIDER_ID, { ...stored, tokens: { ...stored.tokens, subscriptionType: name } });
}

function toStoredAuth(email: string | null, cliVersion: string | null): StoredGeminiAuth {
  const profile: OAuthProfile | null = email ? {
    accountUuid: email,
    email,
    displayName: null,
    organizationUuid: null,
    organizationName: null,
    organizationType: planName,
    organizationRole: null,
    workspaceRole: null,
  } : null;
  return {
    // No secret is stored: the Antigravity CLI keeps its own credentials.
    tokens: {
      accessToken: "",
      refreshToken: null,
      expiresAt: NEVER_EXPIRES,
      scopes: ["antigravity-cli"],
      subscriptionType: planName ?? (loadStored() as StoredGeminiAuth | null)?.tokens?.subscriptionType ?? null,
      rateLimitTier: null,
    },
    profile,
    updatedAt: new Date().toISOString(),
    source: "antigravity-cli",
    cliVersion,
  };
}

/** Whether the CLI is signed in, from a cache refreshed at most every ten minutes. */
async function cliSignedIn(maxAgeMs = STATUS_TTL_MS, signal?: AbortSignal): Promise<boolean> {
  if (Date.now() - checkedAt < maxAgeMs) return checkedOk;
  inflight ??= (async () => {
    try {
      await listAgyModels(signal);
      checkedOk = true;
    } catch (error) {
      if (error instanceof AgyNotSignedInError) checkedOk = false;
      else throw error;
    } finally {
      checkedAt = Date.now();
      inflight = null;
    }
    return checkedOk;
  })();
  return inflight;
}

/** A turn that ran counts as a fresh check. */
export function noteGeminiSignInWorking(): void {
  checkedAt = Date.now();
  checkedOk = true;
}

export function invalidateGeminiSignIn(): void {
  checkedAt = 0;
}

/** Refuse unless Exocortex is connected and the CLI is signed in. */
export async function requireGeminiAuth(signal?: AbortSignal): Promise<void> {
  if (loadStored()?.source === "disconnected") {
    throw new AuthError("Gemini is disconnected. Run /login gemini to use it again.");
  }
  if (!hasAgyBinary()) throw new AuthError(agyMissingMessage());
  if (!(await cliSignedIn(STATUS_TTL_MS, signal))) {
    throw new AuthError("The Antigravity CLI is not signed in to Google. Run `exocortexd login gemini` in a terminal.");
  }
}

async function probe(): Promise<string | null> {
  const version = await getAgyVersion();
  if (!(await cliSignedIn(0))) throw new AuthError("The Antigravity CLI is not signed in to Google.");
  await readGeminiQuota(true).catch(() => null);
  const email = accountEmail();
  saveProviderAuth(PROVIDER_ID, toStoredAuth(email, version));
  return email;
}

export async function verifyAuth(_accessToken: string): Promise<boolean> {
  try {
    await requireGeminiAuth();
    return true;
  } catch {
    return false;
  }
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  if (!hasAgyBinary()) throw new AuthError(agyMissingMessage());
  cbs.onProgress?.("Checking the Antigravity CLI sign-in...");
  if (!(await cliSignedIn(0))) {
    await loginWithAgy(cbs);
    invalidateGeminiSignIn();
  }
  cbs.onProgress?.("Reading the Google AI plan...");
  const email = await probe();
  return {
    profile: email ? {
      accountUuid: email, email, displayName: null, organizationUuid: null,
      organizationName: null, organizationType: planName, organizationRole: null, workspaceRole: null,
    } : null,
  };
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  callbacks?.onProgress?.("Checking the Antigravity CLI...");
  try {
    await requireGeminiAuth();
    if (loadStored()?.source !== "antigravity-cli") await probe();
    return { status: "already_authenticated", email: accountEmail() };
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
  }
  const result = await login(callbacks);
  return { status: "logged_in", email: result.profile?.email ?? null };
}

/** The CLI's own token file (Linux; macOS keeps it in the keychain). Only its existence is checked. */
function cliTokenFileExists(): boolean {
  return existsSync(join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token"));
}

let backgroundProbe: Promise<void> | null = null;

/** Record the CLI's sign-in once, in the background, the first time it is asked about. */
function probeInBackground(): void {
  backgroundProbe ??= probe().then(() => {}, () => {});
}

export function hasConfiguredCredentials(): boolean {
  // Startup/UI hot path: trust the stored probe. Sends re-check the CLI.
  const stored = loadStored();
  if (stored?.source === "antigravity-cli") return true;
  if (stored?.source === "disconnected" || !hasAgyBinary()) return false;
  // Never connected: adopt a signed-in CLI, as Claude Code's login is adopted.
  probeInBackground();
  return cliTokenFileExists();
}

/**
 * Disconnect Exocortex from Gemini. The CLI stays signed in, as the owner's
 * own `agy` sessions share it; `agy` itself signs out.
 */
export function clearAuth(): boolean {
  const wasConnected = loadStored()?.source === "antigravity-cli";
  saveProviderAuth(PROVIDER_ID, { source: "disconnected", updatedAt: new Date().toISOString() } satisfies DisconnectedGeminiAuth);
  return wasConnected;
}
