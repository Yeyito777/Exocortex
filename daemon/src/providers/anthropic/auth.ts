/**
 * Claude Code-backed authentication for the Anthropic provider.
 *
 * Claude Code owns the OAuth credentials. Exocortex caches only account
 * metadata (shaped like other providers' stored auth so the shared auth-info
 * surfaces work) and refuses anything but a claude.ai subscription login.
 */

import { loadProviderAuth, saveProviderAuth, type OAuthProfile, type StoredAuth } from "../../store";
import { AuthError } from "../errors";
import type { EnsureAuthResult, LoginCallbacks, LoginResult } from "../types";
import { getClaudeAuthStatus, getClaudeAuthStatusSync, getClaudeVersion, isSubscriptionAuth, loginWithClaudeCli } from "./cli";
import type { ClaudeAuthStatus } from "./types";

const PROVIDER_ID = "anthropic";
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

interface StoredAnthropicAuth extends StoredAuth {
  source: "claude-code";
  cliVersion: string | null;
}

/** Written by /logout so a still-signed-in CLI is not silently re-adopted. */
interface DisconnectedAnthropicAuth {
  source: "disconnected";
  updatedAt: string;
}

function loadStored(): StoredAnthropicAuth | DisconnectedAnthropicAuth | null {
  return loadProviderAuth<StoredAnthropicAuth | DisconnectedAnthropicAuth>(PROVIDER_ID);
}

function profileFromStatus(status: ClaudeAuthStatus): OAuthProfile | null {
  if (!status.email) return null;
  return {
    accountUuid: status.orgId ?? status.email,
    email: status.email,
    displayName: null,
    organizationUuid: status.orgId ?? null,
    organizationName: status.orgName ?? null,
    organizationType: status.subscriptionType ?? null,
    organizationRole: null,
    workspaceRole: null,
  };
}

function toStoredAuth(status: ClaudeAuthStatus, cliVersion: string | null): StoredAnthropicAuth {
  return {
    // No secret is stored: Claude Code keeps its own credentials.
    tokens: {
      accessToken: "",
      refreshToken: null,
      expiresAt: NEVER_EXPIRES,
      scopes: ["claude-code"],
      subscriptionType: status.subscriptionType ?? null,
      rateLimitTier: null,
    },
    profile: profileFromStatus(status),
    updatedAt: new Date().toISOString(),
    source: "claude-code",
    cliVersion,
  };
}

function subscriptionError(status: ClaudeAuthStatus): AuthError {
  if (!status.loggedIn) {
    return new AuthError("Claude Code is not signed in. Run `claude auth login` (or /login anthropic) and try again.");
  }
  return new AuthError(
    `Claude Code is signed in with ${status.authMethod ?? "an unknown method"}${status.apiProvider ? ` via ${status.apiProvider}` : ""}, `
      + "but Exocortex only uses Claude Code with a Claude subscription. Run `claude auth login --claudeai`.",
  );
}

/** Verify Claude Code is installed and signed in with a Claude subscription. */
export async function requireSubscriptionAuth(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
  if (loadStored()?.source === "disconnected") {
    throw new AuthError("Anthropic is disconnected. Run /login anthropic to use Claude Code again.");
  }
  const status = await getClaudeAuthStatus(signal);
  if (!isSubscriptionAuth(status)) throw subscriptionError(status);
  return status;
}

/** Like requireSubscriptionAuth, but (re)connects and caches account metadata. */
async function probeSubscriptionAuth(signal?: AbortSignal): Promise<ClaudeAuthStatus> {
  const version = await getClaudeVersion(signal);
  const status = await getClaudeAuthStatus(signal);
  if (!isSubscriptionAuth(status)) throw subscriptionError(status);
  saveProviderAuth(PROVIDER_ID, toStoredAuth(status, version));
  return status;
}

export async function verifyAuth(_accessToken: string): Promise<boolean> {
  try {
    await requireSubscriptionAuth();
    return true;
  } catch {
    return false;
  }
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  cbs.onProgress?.("Checking Claude Code installation...");
  await getClaudeVersion();
  const current = await getClaudeAuthStatus();
  if (!isSubscriptionAuth(current)) await loginWithClaudeCli(cbs);
  cbs.onProgress?.("Verifying Claude subscription...");
  const status = await probeSubscriptionAuth();
  return { profile: profileFromStatus(status) };
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  callbacks?.onProgress?.("Checking Claude Code...");
  try {
    const status = await requireSubscriptionAuth();
    if (loadStored()?.source !== "claude-code") await probeSubscriptionAuth();
    return { status: "already_authenticated", email: status.email ?? null };
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
  }
  const result = await login(callbacks);
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export function hasConfiguredCredentials(): boolean {
  // Startup/UI hot path: trust the cached probe instead of spawning the CLI.
  // Real sends re-verify the subscription before starting Claude Code.
  const stored = loadStored();
  if (stored?.source === "claude-code") return true;
  if (stored?.source === "disconnected") return false;
  const live = getClaudeAuthStatusSync();
  if (!live || !isSubscriptionAuth(live)) return false;
  saveProviderAuth(PROVIDER_ID, toStoredAuth(live, null));
  return true;
}

/**
 * Disconnect Exocortex from Claude Code. Deliberately leaves the Claude Code
 * CLI signed in, since other tools (and the user's own terminal) share it.
 */
export function clearAuth(): boolean {
  const wasConnected = loadStored()?.source === "claude-code";
  const disconnected: DisconnectedAnthropicAuth = { source: "disconnected", updatedAt: new Date().toISOString() };
  saveProviderAuth(PROVIDER_ID, disconnected);
  return wasConnected;
}
