/**
 * Credential storage for exocortexd.
 *
 * Reads/writes OAuth tokens to ~/.config/exocortex/credentials.json.
 */

import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { log } from "./log";
import { configDir } from "@exocortex/shared/paths";

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

// ── Paths ───────────────────────────────────────────────────────────

const CONFIG_DIR = configDir();
const CRED_FILE = join(CONFIG_DIR, "credentials.json");

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

// ── Public API ──────────────────────────────────────────────────────

export function saveAuth(auth: StoredAuth): void {
  ensureDir();
  writeFileSync(CRED_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function loadAuth(): StoredAuth | null {
  if (existsSync(CRED_FILE)) {
    try { return JSON.parse(readFileSync(CRED_FILE, "utf-8")); }
    catch (err) { log("warn", `store: failed to parse ${CRED_FILE}: ${err}`); }
  }
  return null;
}

export function clearAuth(): boolean {
  if (existsSync(CRED_FILE)) {
    try { unlinkSync(CRED_FILE); return true; }
    catch (err) { log("warn", `store: failed to remove ${CRED_FILE}: ${err}`); }
  }
  return false;
}

export function isTokenExpired(tokens: StoredTokens): boolean {
  if (!tokens.expiresAt) return true;
  return Date.now() >= tokens.expiresAt - 300_000; // 5 min buffer
}
