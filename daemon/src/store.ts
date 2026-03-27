/**
 * Credential storage for exocortexd.
 *
 * Reads/writes OAuth tokens to ~/.config/exocortex/secrets/credentials.json.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { log } from "./log";
import { secretsDir } from "@exocortex/shared/paths";
import type { ProviderId } from "@exocortex/shared/messages";

// ── Types ───────────────────────────────────────────────────────────

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export interface OAuthProfile {
  accountUuid: string;
  email: string;
  displayName: string | null;
  organizationUuid: string | null;
  organizationName: string | null;
  organizationType: string | null;
  organizationRole: string | null;
  workspaceRole: string | null;
}

export interface StoredAuth {
  tokens: StoredTokens;
  profile: OAuthProfile | null;
  updatedAt: string;
}

interface CredentialsFileV2 {
  version: 2;
  providers: Partial<Record<ProviderId, unknown>>;
}

// ── Paths ───────────────────────────────────────────────────────────

const SECRETS_DIR = secretsDir();
const CRED_FILE = join(SECRETS_DIR, "credentials.json");

function ensureDir(): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
}

// ── Public API ──────────────────────────────────────────────────────

function writeStore(file: CredentialsFileV2): void {
  ensureDir();
  writeFileSync(CRED_FILE, JSON.stringify(file, null, 2), { mode: 0o600 });
}

function readStore(): CredentialsFileV2 {
  if (!existsSync(CRED_FILE)) {
    return { version: 2, providers: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(CRED_FILE, "utf-8")) as CredentialsFileV2 | StoredAuth;
    if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === 2 && "providers" in parsed) {
      return parsed;
    }
    if (parsed && typeof parsed === "object" && "tokens" in parsed) {
      const migrated: CredentialsFileV2 = {
        version: 2,
        providers: { anthropic: parsed },
      };
      writeStore(migrated);
      return migrated;
    }
  } catch (err) {
    log("warn", `store: failed to parse ${CRED_FILE}: ${err}`);
  }
  return { version: 2, providers: {} };
}

export function saveProviderAuth<T>(provider: ProviderId, auth: T): void {
  const file = readStore();
  file.providers[provider] = auth;
  writeStore(file);
}

export function loadProviderAuth<T>(provider: ProviderId): T | null {
  const file = readStore();
  return (file.providers[provider] as T | undefined) ?? null;
}

export function clearProviderAuth(provider: ProviderId): boolean {
  const file = readStore();
  if (!(provider in file.providers)) return false;
  delete file.providers[provider];
  if (Object.keys(file.providers).length === 0) {
    if (existsSync(CRED_FILE)) {
      try { unlinkSync(CRED_FILE); return true; }
      catch (err) { log("warn", `store: failed to remove ${CRED_FILE}: ${err}`); }
    }
    return false;
  }
  writeStore(file);
  return true;
}

export function hasProviderAuth(provider: ProviderId): boolean {
  return loadProviderAuth(provider) !== null;
}

export function saveAuth(auth: StoredAuth): void {
  saveProviderAuth("anthropic", auth);
}

export function loadAuth(): StoredAuth | null {
  return loadProviderAuth<StoredAuth>("anthropic");
}

export function clearAuth(): boolean {
  return clearProviderAuth("anthropic");
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  if (!tokens.expiresAt) return true;
  return Date.now() >= tokens.expiresAt - 300_000; // 5 min buffer
}
