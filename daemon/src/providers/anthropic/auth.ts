/**
 * Claude Code-backed authentication for Anthropic in exocortexd.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth, type OAuthProfile } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";
import {
  getClaudeAuthStatus,
  getClaudeAuthStatusSync,
  getClaudeVersion,
  loginWithClaudeCli,
  logoutWithClaudeCliSync,
} from "./cli";
import type { ClaudeAuthStatus, StoredAnthropicAuth } from "./types";

const ANTHROPIC_PROVIDER_ID = "anthropic";

function toProfile(input: {
  email?: string | null;
  accountUuid?: string | null;
  displayName?: string | null;
  orgId?: string | null;
  orgName?: string | null;
  subscriptionType?: string | null;
  organizationRole?: string | null;
  workspaceRole?: string | null;
}): OAuthProfile | null {
  if (!input.email) return null;
  return {
    accountUuid: input.accountUuid ?? input.email,
    email: input.email,
    displayName: input.displayName ?? null,
    organizationUuid: input.orgId ?? null,
    organizationName: input.orgName ?? null,
    organizationType: input.subscriptionType ?? null,
    organizationRole: input.organizationRole ?? null,
    workspaceRole: input.workspaceRole ?? null,
  };
}

function profileFromStatus(status: ClaudeAuthStatus): OAuthProfile | null {
  return toProfile({
    email: status.email,
    orgId: status.orgId,
    orgName: status.orgName,
    subscriptionType: status.subscriptionType,
  });
}

function loadStoredAuth(): StoredAnthropicAuth | null {
  return loadProviderAuth<StoredAnthropicAuth>(ANTHROPIC_PROVIDER_ID);
}

function saveStoredAuth(auth: StoredAnthropicAuth): void {
  saveProviderAuth(ANTHROPIC_PROVIDER_ID, auth);
}

interface ClaudeLocalConfig {
  oauthAccount?: {
    accountUuid?: unknown;
    emailAddress?: unknown;
    displayName?: unknown;
    organizationUuid?: unknown;
    organizationName?: unknown;
    billingType?: unknown;
    organizationRole?: unknown;
    workspaceRole?: unknown;
  };
}

function normalizeLocalSubscriptionType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value) {
    case "claude_max": return "max";
    case "claude_pro": return "pro";
    case "claude_team": return "team";
    case "claude_enterprise": return "enterprise";
    default: return null;
  }
}

function localClaudeConfigPath(): string {
  return join(process.env.HOME || process.cwd(), ".claude.json");
}

function loadClaudeLocalProfile(): OAuthProfile | null {
  const configPath = localClaudeConfigPath();
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as ClaudeLocalConfig;
    const account = parsed.oauthAccount;
    if (!account || typeof account !== "object") return null;
    return toProfile({
      email: typeof account.emailAddress === "string" ? account.emailAddress : null,
      accountUuid: typeof account.accountUuid === "string" ? account.accountUuid : null,
      displayName: typeof account.displayName === "string" ? account.displayName : null,
      orgId: typeof account.organizationUuid === "string" ? account.organizationUuid : null,
      orgName: typeof account.organizationName === "string" ? account.organizationName : null,
      subscriptionType: normalizeLocalSubscriptionType(account.billingType),
      organizationRole: typeof account.organizationRole === "string" ? account.organizationRole : null,
      workspaceRole: typeof account.workspaceRole === "string" ? account.workspaceRole : null,
    });
  } catch {
    return null;
  }
}

function toStoredAuth(status: ClaudeAuthStatus, version: string | null): StoredAnthropicAuth {
  const localProfile = loadClaudeLocalProfile();
  return {
    cli: {
      authenticated: status.loggedIn,
      version,
      authMethod: status.authMethod ?? null,
      subscriptionType: status.subscriptionType ?? localProfile?.organizationType ?? null,
    },
    profile: profileFromStatus(status) ?? localProfile,
    updatedAt: new Date().toISOString(),
  };
}

async function probeCliAuth(signal?: AbortSignal): Promise<StoredAnthropicAuth> {
  const version = await getClaudeVersion(signal);
  const status = await getClaudeAuthStatus(signal);
  const stored = toStoredAuth(status, version);
  saveStoredAuth(stored);
  return stored;
}

export async function refreshTokens(_refreshToken: string): Promise<never> {
  throw new AuthError("Anthropic authentication is managed by Claude Code and does not support token refresh.");
}

export async function verifyAuth(_accessToken: string): Promise<boolean> {
  try {
    const stored = await probeCliAuth();
    return stored.cli.authenticated;
  } catch {
    return false;
  }
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});

  say("Checking Claude Code installation...");
  const stored = await probeCliAuth();
  if (stored.cli.authenticated) {
    return { status: "already_authenticated", email: stored.profile?.email ?? null };
  }

  const result = await login(callbacks);
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export function hasConfiguredCredentials(): boolean {
  if (typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === "string" && process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 0) {
    return true;
  }

  // Prefer Exocortex's cached Claude Code auth metadata for hot paths like
  // daemon/TUI startup. Spawning `claude auth status --json` synchronously costs
  // hundreds of milliseconds on every check, while real send/login paths still
  // call ensureAuthenticated()/verifyAuth() and refresh the cache from the CLI.
  const stored = loadStoredAuth();
  if (stored?.cli?.authenticated === true) return true;
  if (loadClaudeLocalProfile() !== null) return true;

  const liveStatus = getClaudeAuthStatusSync();
  return liveStatus?.loggedIn === true;
}

export function clearAuth(): boolean {
  try {
    logoutWithClaudeCliSync();
  } catch {
    // best-effort; local cache clearing below still lets Exocortex recover
  }
  return clearProviderAuth(ANTHROPIC_PROVIDER_ID);
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  cbs.onProgress?.("Checking Claude Code installation...");
  await getClaudeVersion();
  cbs.onProgress?.("Opening Claude Code login...");
  await loginWithClaudeCli(cbs);
  cbs.onProgress?.("Verifying Claude Code session...");
  const stored = await probeCliAuth();
  if (!stored.cli.authenticated) {
    throw new AuthError("Claude Code login completed, but the session is still not authenticated. Run `claude auth login` and try again.");
  }
  return {
    profile: stored.profile,
  };
}
