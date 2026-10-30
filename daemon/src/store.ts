/**
 * Credential storage for exocortexd: config/secrets/credentials.json.
 *
 * A test instance (a linked worktree's daemon) borrows the main checkout's
 * credentials through symlinks (scripts/dev/worktree-common.sh). It reads
 * them live but never writes them: its logins, refreshes and logouts stay in
 * its memory, so nothing a test daemon does can replace, rotate or remove the
 * owner's logins (docs/dev-daemons.md).
 */

import { join } from "path";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { log } from "./log";
import { secretsDir, worktreeName } from "@exocortex/shared/paths";
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

/**
 * A provider's credentials, or a secondary credential a provider keeps beside
 * them (`openai-api-key`: the OpenAI API key next to the ChatGPT account pool).
 */
export type CredentialSlot = ProviderId | "openai-api-key";

interface CredentialsFileV2 {
  version: 2;
  providers: Partial<Record<CredentialSlot, unknown>>;
}

// ── Paths ───────────────────────────────────────────────────────────

const SECRETS_DIR = secretsDir();
const CRED_FILE = join(SECRETS_DIR, "credentials.json");
/** Marks a worktree's config/secrets as the main checkout's, borrowed (scripts/dev/worktree-common.sh). */
const BORROWED_SECRETS_MARKER = ".borrowed-from-main";

function ensureDir(): void {
  if (!existsSync(SECRETS_DIR)) {
    mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  }
}

// ── Borrowed (read-only) credentials ────────────────────────────────

let sharedOverride: boolean | null = null;
let shared: boolean | null = null;
/**
 * This instance's own credential changes while it borrows the shared store
 * (null: logged out here), each with the shared slot it was made over: once
 * the owner changes that slot (a refresh, a new login), the shared one wins.
 */
const localChanges = new Map<CredentialSlot, { value: unknown | null; over: string }>();

function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/**
 * Whether this instance borrows another checkout's credentials (a worktree
 * whose config/secrets is marked borrowed, or is, or holds, a symlink): it
 * must never write them, nor refresh their tokens (a refresh replaces the
 * refresh token, which would sign the owner of the store out).
 */
export function borrowsSharedCredentials(): boolean {
  if (sharedOverride !== null) return sharedOverride;
  shared ??= worktreeName() !== null
    && (isSymlink(SECRETS_DIR) || isSymlink(CRED_FILE) || existsSync(join(SECRETS_DIR, BORROWED_SECRETS_MARKER)));
  return shared;
}

export function setBorrowedCredentialsForTest(value: boolean | null): void {
  sharedOverride = value;
  localChanges.clear();
}

let announcedBorrowed = false;
function keepLocally(provider: CredentialSlot, auth: unknown | null): void {
  if (!announcedBorrowed) {
    announcedBorrowed = true;
    log("info", "store: this test instance borrows the main credentials; its own credential changes stay in memory");
  }
  localChanges.set(provider, { value: auth === null ? null : structuredClone(auth), over: JSON.stringify(readStore().providers[provider] ?? null) });
}

// ── Public API ──────────────────────────────────────────────────────

function writeStore(file: CredentialsFileV2): void {
  if (borrowsSharedCredentials()) throw new Error("store: refusing to write borrowed credentials");
  ensureDir();
  // Replace atomically: a crash mid-write must not truncate every provider's login.
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  renameSync(tmp, CRED_FILE);
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
    if (parsed && typeof parsed === "object" && "tokens" in parsed) return { version: 2, providers: {} };
  } catch (err) {
    log("warn", `store: failed to parse ${CRED_FILE}: ${err}`);
    // Not ours to move: the instance that owns it recovers it.
    if (borrowsSharedCredentials()) return { version: 2, providers: {} };
    // The next save would replace it with one provider: keep the rest recoverable.
    const kept = `${CRED_FILE}.corrupt-${Date.now()}`;
    try {
      renameSync(CRED_FILE, kept);
      log("warn", `store: moved the unreadable credentials file to ${kept}`);
    } catch { /* already gone */ }
  }
  return { version: 2, providers: {} };
}

export function saveProviderAuth<T>(provider: CredentialSlot, auth: T): void {
  if (borrowsSharedCredentials()) return keepLocally(provider, auth);
  const file = readStore();
  file.providers[provider] = auth;
  writeStore(file);
}

export function loadProviderAuth<T>(provider: CredentialSlot): T | null {
  const file = readStore();
  const local = borrowsSharedCredentials() ? localChanges.get(provider) : undefined;
  if (local) {
    if (local.over === JSON.stringify(file.providers[provider] ?? null)) return local.value === null ? null : structuredClone(local.value) as T;
    localChanges.delete(provider);
  }
  return (file.providers[provider] as T | undefined) ?? null;
}

export function clearProviderAuth(provider: CredentialSlot): boolean {
  if (borrowsSharedCredentials()) {
    const had = loadProviderAuth(provider) !== null;
    keepLocally(provider, null);
    return had;
  }
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

export function hasProviderAuth(provider: CredentialSlot): boolean {
  return loadProviderAuth(provider) !== null;
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  if (!tokens.expiresAt) return true;
  return Date.now() >= tokens.expiresAt - 300_000; // 5 min buffer
}
