/**
 * The remote side of /proxy: this daemon's own provider credentials and
 * status, attached to requests other daemons send it over a link.
 *
 * Tokens are only ever put into the upstream request headers here; nothing in
 * this module returns them to a link or logs them. Claude requests carry the
 * login of the account the pool routed them to (claude-routing.ts): Claude
 * Code's own stored login in that account's configuration directory, which
 * Claude Code itself keeps refreshed.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderProxyRemoteStatus, ProxyableProviderId } from "@exocortex/shared/provider-proxy";
import { PROVIDER_PROXY_ORIGINS } from "@exocortex/shared/provider-proxy";
import { getAuthInfo, hasConfiguredCredentials } from "../auth";
import { getLastUsage } from "../usage";
import { getProviderAdapter } from "../providers/catalog";
import { getCurrentAccountScope, getVerifiedSession } from "../providers/openai/auth";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "../providers/openai/cookies";
import { requireSubscriptionAuth } from "../providers/anthropic/auth";
import { refreshAccountUsage } from "../providers/anthropic/usage";
import { getClaudeAccount, MAIN_ACCOUNT_ID } from "../providers/anthropic/accounts";
import { claudeAccountStates } from "../providers/anthropic/account-pool";
import { log } from "../log";
import { isProviderProxied } from "./route";

export interface UpstreamAuth {
  /** The upstream origin for a provider (allowlisted; tests may point it at a mock). */
  origin(provider: ProxyableProviderId): string;
  /**
   * Headers that authenticate one upstream request. `afterRejection` is set
   * when the previous attempt got 401: refresh the credentials first.
   * `account` is the Claude account the request was routed to (default `main`).
   */
  headers(provider: ProxyableProviderId, url: string, options: { afterRejection: boolean; clientHeaders: Record<string, string>; account?: string }): Promise<Record<string, string>>;
  /** Upstream response headers, for cookie jars. */
  observeResponse?(provider: ProxyableProviderId, url: string, headers: Headers): void;
  /** Whether a provider can be served at all right now (logged in), for the request gate. */
  status(provider: ProxyableProviderId, options?: { refreshUsage?: boolean }): Promise<ProviderProxyRemoteStatus>;
  consumeReset(provider: ProxyableProviderId): Promise<{ outcome: string; windowsReset: number; remainingResets?: number }>;
}

/** Test-only upstream override: honored only in test processes, never in a normal daemon. */
function testOrigins(): Partial<Record<ProxyableProviderId, string>> {
  if (process.env.EXOCORTEX_TEST !== "1") return {};
  const raw = process.env.EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<Record<ProxyableProviderId, string>>;
  } catch {
    return {};
  }
}

// ── Anthropic: Claude Code's own OAuth login ─────────────────────────

const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
/** Refresh this long before Claude Code's token expires. */
const CLAUDE_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const ANTHROPIC_STATUS_TTL_MS = 60_000;

interface ClaudeOAuth {
  accessToken: string;
  expiresAt: number | null;
}

function claudeConfigDir(account = MAIN_ACCOUNT_ID): string | null {
  if (account === MAIN_ACCOUNT_ID) return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const dir = getClaudeAccount(account)?.configDir;
  if (!dir) return null;
  return dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

/**
 * The macOS Keychain item Claude Code keeps an account's login in: the plain
 * name for the default directory, suffixed with a hash of CLAUDE_CONFIG_DIR
 * for any other (how it keeps several logins apart).
 */
function keychainService(account: string, configDir: string): string {
  const base = "Claude Code-credentials";
  return account === MAIN_ACCOUNT_ID && !process.env.CLAUDE_CONFIG_DIR?.trim()
    ? base
    : `${base}-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
}

function parseClaudeCredentials(text: string): ClaudeOAuth | null {
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    return { accessToken: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null };
  } catch {
    return null;
  }
}

/** An account's stored Claude Code login: its credentials file, or the macOS keychain item Claude Code uses. */
export function readClaudeCodeOAuth(account = MAIN_ACCOUNT_ID): ClaudeOAuth | null {
  const configDir = claudeConfigDir(account);
  if (!configDir) return null;
  const file = join(configDir, ".credentials.json");
  if (existsSync(file)) {
    try {
      return parseClaudeCredentials(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const result = Bun.spawnSync(["security", "find-generic-password", "-s", keychainService(account, configDir), "-w"], { stdout: "pipe", stderr: "ignore" });
      if (result.exitCode === 0) return parseClaudeCredentials(result.stdout.toString());
    } catch {
      // No keychain item.
    }
  }
  return null;
}

function withOAuthBeta(value: string | undefined): string {
  const betas = (value ?? "").split(",").map(part => part.trim()).filter(Boolean);
  if (!betas.includes(CLAUDE_OAUTH_BETA)) betas.push(CLAUDE_OAUTH_BETA);
  return betas.join(",");
}

interface AnthropicLogin { loggedIn: boolean; error?: string; email?: string; orgId?: string }

/** Where the credentials come from; tests substitute these. */
export interface UpstreamCredentialSources {
  /** Claude Code's subscription login status (`claude auth status`). */
  anthropicLogin(): Promise<AnthropicLogin>;
  /** Have Claude Code refresh an account's own OAuth login. */
  refreshClaudeLogin(account?: string): Promise<void>;
  readClaudeOAuth(account?: string): ClaudeOAuth | null;
  /** Another Claude account of the pool can take requests even if `main` cannot. */
  claudePoolAvailable(): boolean;
  /** This daemon's OpenAI session, refreshed when asked to. */
  openaiSession(options: { forceRefresh?: boolean }): Promise<{ accessToken: string; accountId: string | null }>;
}

const defaultSources: UpstreamCredentialSources = {
  anthropicLogin: () => requireSubscriptionAuth()
    .then(status => ({ loggedIn: true, email: status.email, orgId: status.orgId }))
    .catch((error: unknown) => ({ loggedIn: false, error: error instanceof Error ? error.message : String(error) })),
  // Claude Code owns the refresh token and its rotation; a bare usage probe on the account makes it refresh.
  refreshClaudeLogin: async (account = MAIN_ACCOUNT_ID) => { await refreshAccountUsage(account); },
  readClaudeOAuth: readClaudeCodeOAuth,
  claudePoolAvailable: () => claudeAccountStates().some(state => state.id !== MAIN_ACCOUNT_ID && state.available),
  openaiSession: (options) => getVerifiedSession(options),
};

export class UpstreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamAuthError";
  }
}

function scopeOf(value: string | null | undefined): string | null {
  return value ? `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 32)}` : null;
}

// ── Implementation ─────────────────────────────────────────────────

/** A daemon serves only its own logins: one that proxies a provider itself does not relay it further. */
const CHAINED_PROXY_ERROR = (provider: ProxyableProviderId) =>
  `This machine sends ${provider} through /proxy itself; turn that off here or proxy to the machine that is logged in.`;

export function createLocalUpstreamAuth(overrides: Partial<UpstreamCredentialSources> = {}): UpstreamAuth {
  const sources: UpstreamCredentialSources = { ...defaultSources, ...overrides };
  const claudeRefreshes = new Map<string, Promise<void>>();
  let anthropicStatus: { at: number; status: Promise<AnthropicLogin> } | null = null;

  const refreshClaudeLogin = (account: string): Promise<void> => {
    const running = claudeRefreshes.get(account);
    if (running) return running;
    const refresh = (account === MAIN_ACCOUNT_ID ? sources.refreshClaudeLogin() : sources.refreshClaudeLogin(account)).catch((error: unknown) => {
      log("warn", `provider-proxy: Claude Code login refresh for "${account}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { claudeRefreshes.delete(account); });
    claudeRefreshes.set(account, refresh);
    return refresh;
  };

  const whose = (account: string) => account === MAIN_ACCOUNT_ID ? "Claude Code's" : `Claude account "${account}"'s`;
  const readClaudeOAuth = (account: string) => account === MAIN_ACCOUNT_ID ? sources.readClaudeOAuth() : sources.readClaudeOAuth(account);

  const claudeAccessToken = async (afterRejection: boolean, account: string): Promise<string> => {
    let oauth = readClaudeOAuth(account);
    const stale = !oauth || (oauth.expiresAt !== null && oauth.expiresAt - Date.now() < CLAUDE_TOKEN_REFRESH_MARGIN_MS);
    if (stale || afterRejection) {
      const before = oauth?.accessToken;
      await refreshClaudeLogin(account);
      oauth = readClaudeOAuth(account);
      if (afterRejection && oauth?.accessToken === before) {
        throw new UpstreamAuthError(`${whose(account)} login was rejected and could not be refreshed. Run \`claude\` once on this machine.`);
      }
    }
    if (!oauth) throw new UpstreamAuthError(`${account === MAIN_ACCOUNT_ID ? "Claude Code is" : `Claude account "${account}" is`} not signed in on this machine. Run \`claude auth login\` there.`);
    if (oauth.expiresAt !== null && oauth.expiresAt <= Date.now()) {
      throw new UpstreamAuthError(`${whose(account)} login on this machine has expired and could not be refreshed. Run \`claude\` once there.`);
    }
    return oauth.accessToken;
  };

  const anthropicLogin = (): Promise<AnthropicLogin> => {
    if (anthropicStatus && Date.now() - anthropicStatus.at < ANTHROPIC_STATUS_TTL_MS) return anthropicStatus.status;
    const status = sources.anthropicLogin();
    anthropicStatus = { at: Date.now(), status };
    // Do not cache a failure: a login on the remote should work at once.
    void status.then(result => { if (!result.loggedIn && anthropicStatus?.status === status) anthropicStatus = null; });
    return status;
  };

  return {
    origin(provider) {
      return (testOrigins()[provider] ?? PROVIDER_PROXY_ORIGINS[provider]).replace(/\/+$/, "");
    },

    async headers(provider, url, { afterRejection, clientHeaders, account = MAIN_ACCOUNT_ID }): Promise<Record<string, string>> {
      if (isProviderProxied(provider)) throw new UpstreamAuthError(CHAINED_PROXY_ERROR(provider));
      if (provider === "anthropic") {
        // The pool routes only to accounts signed in with a subscription; `main` is checked here as before.
        if (account === MAIN_ACCOUNT_ID) {
          const login = await anthropicLogin();
          if (!login.loggedIn) throw new UpstreamAuthError(login.error ?? "Claude Code is not signed in with a Claude subscription on this machine.");
        }
        return {
          authorization: `Bearer ${await claudeAccessToken(afterRejection, account)}`,
          "anthropic-beta": withOAuthBeta(clientHeaders["anthropic-beta"]),
        };
      }
      let session;
      try {
        session = await sources.openaiSession(afterRejection ? { forceRefresh: true } : {});
      } catch (error) {
        throw new UpstreamAuthError(error instanceof Error ? error.message : String(error));
      }
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
      if (session.accountId) headers["chatgpt-account-id"] = session.accountId;
      const cookie = buildCloudflareCookieHeader(url);
      if (cookie) headers.cookie = cookie;
      return headers;
    },

    observeResponse(provider, url, headers) {
      if (provider === "openai") storeCloudflareCookiesFromHeaders(url, headers);
    },

    async status(provider, options = {}) {
      if (isProviderProxied(provider)) {
        return { loggedIn: false, error: CHAINED_PROXY_ERROR(provider), authInfo: null, accountScope: null, usage: null };
      }
      const adapter = getProviderAdapter(provider);
      let loggedIn: boolean;
      let error: string | undefined;
      let accountScope: string | null;
      if (provider === "anthropic") {
        const login = await anthropicLogin();
        // Requests go to whichever account of the pool can take them.
        loggedIn = login.loggedIn || sources.claudePoolAvailable();
        error = loggedIn ? undefined : login.error;
        accountScope = scopeOf(login.orgId ?? login.email);
      } else {
        loggedIn = hasConfiguredCredentials(provider);
        error = loggedIn ? undefined : "OpenAI is not logged in on this machine. Run /login openai there.";
        accountScope = loggedIn ? getCurrentAccountScope() : null;
      }
      if (loggedIn && options.refreshUsage && adapter.usage.refreshRemoteUsage) {
        try {
          await adapter.usage.refreshRemoteUsage();
        } catch (refreshError) {
          log("debug", `provider-proxy: ${provider} usage refresh failed: ${refreshError instanceof Error ? refreshError.message : refreshError}`);
        }
      }
      const authInfo = loggedIn ? getAuthInfo(provider) : null;
      return {
        loggedIn,
        ...(error ? { error } : {}),
        authInfo,
        accountScope,
        // For Claude, the pool's combined usage: proxied requests are routed across it.
        usage: loggedIn ? getLastUsage(provider) : null,
      };
    },

    async consumeReset(provider) {
      const consume = getProviderAdapter(provider).usage.consumeReset;
      if (!consume) throw new Error(`Usage resets are not supported for ${provider}.`);
      return consume();
    },
  };
}

export const localUpstreamAuth: UpstreamAuth = createLocalUpstreamAuth();
