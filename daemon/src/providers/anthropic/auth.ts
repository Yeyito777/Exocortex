/**
 * OAuth authentication for exocortexd.
 *
 * Handles the full PKCE login flow against claude.ai/platform.claude.com,
 * token refresh, and profile fetching.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomBytes, createHash } from "crypto";
import { log } from "../../log";
import { ANTHROPIC_BASE_URL } from "./constants";
import { clearAuth, loadAuth, saveAuth, isTokenExpired, type StoredTokens, type OAuthProfile } from "../../store";
import { isWindows } from "@exocortex/shared/paths";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDEAI_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const SUCCESS_URL = "https://platform.claude.com/oauth/code/success?app=claude-code";

const CLAUDE_AI_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
];

function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(length = 64): string {
  return base64url(randomBytes(length)).slice(0, length);
}

function generateCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

function generateState(): string {
  return base64url(randomBytes(32));
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

interface CallbackResult {
  code: string;
  state: string;
}

async function startCallbackServer(
  expectedState: string,
): Promise<{ port: number; waitForCallback: () => Promise<CallbackResult>; shutdown: () => void }> {
  const server = createServer();
  let resolveCallback: ((r: CallbackResult) => void) | null = null;
  let rejectCallback: ((e: Error) => void) | null = null;

  let port = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 39152 + Math.floor(Math.random() * 10000);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(candidate, "127.0.0.1", () => resolve(true));
    });
    if (ok) { port = candidate; break; }
  }
  if (port === 0) throw new Error("Could not find available port for OAuth callback");

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404); res.end("Not found"); return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400); res.end(`Auth failed: ${error}`);
      rejectCallback?.(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !state || state !== expectedState) {
      res.writeHead(400); res.end("Invalid callback");
      rejectCallback?.(new Error("OAuth state mismatch"));
      return;
    }

    res.writeHead(302, { Location: SUCCESS_URL });
    res.end();
    resolveCallback?.({ code, state });
  });

  const waitForCallback = (): Promise<CallbackResult> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("OAuth callback timed out")), 300_000);
      resolveCallback = (r) => { clearTimeout(timer); resolve(r); };
      rejectCallback = (e) => { clearTimeout(timer); reject(e); };
    });

  return { port, waitForCallback, shutdown: () => server.close() };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

async function exchangeCode(
  code: string, codeVerifier: string, state: string, redirectUri: string,
): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code, redirect_uri: redirectUri, client_id: CLIENT_ID, code_verifier: codeVerifier, state,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<TokenResponse>;
}

interface ProfileResponse {
  account: { uuid: string; email: string; display_name: string | null };
  organization: {
    uuid: string; name: string; organization_type: string;
    rate_limit_tier: string; billing_type: string;
  };
}

interface RolesResponse {
  organization_role: string | null;
  workspace_role: string | null;
}

async function fetchProfile(accessToken: string): Promise<ProfileResponse | null> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    return res.ok ? (res.json() as Promise<ProfileResponse>) : null;
  } catch { return null; }
}

async function fetchRoles(accessToken: string): Promise<RolesResponse | null> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/claude_cli/roles`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok ? (res.json() as Promise<RolesResponse>) : null;
  } catch { return null; }
}

function mapSubscription(orgType: string | null | undefined): string | null {
  switch (orgType) {
    case "claude_max": return "max";
    case "claude_pro": return "pro";
    case "claude_enterprise": return "enterprise";
    case "claude_team": return "team";
    default: return null;
  }
}

let inflightRefresh: Promise<StoredTokens> | null = null;

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = doRefresh(refreshToken).finally(() => { inflightRefresh = null; });
  return inflightRefresh;
}

async function doRefresh(refreshToken: string): Promise<StoredTokens> {
  log("info", "auth: refreshing tokens");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: CLAUDE_AI_SCOPES.join(" "),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 && text.includes("invalid_grant")) {
      throw new AuthError(`Session expired — use login to re-authenticate. (${text})`);
    }
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  const profile = await fetchProfile(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope?.split(" ") ?? CLAUDE_AI_SCOPES,
    subscriptionType: mapSubscription(profile?.organization?.organization_type),
    rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
  };
}

export async function verifyAuth(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/claude_cli/client_data`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch { return false; }
}

export async function getVerifiedAccessToken(): Promise<string> {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    throw new AuthError("Anthropic is not authenticated. Run `bun run src/main.ts login anthropic`.");
  }

  if (isTokenExpired(auth.tokens)) {
    if (!auth.tokens.refreshToken) {
      throw new AuthError("Anthropic token expired and no refresh token is available.");
    }
    const newTokens = await refreshTokens(auth.tokens.refreshToken);
    saveAuth({ ...auth, tokens: newTokens, updatedAt: new Date().toISOString() });
    return newTokens.accessToken;
  }

  return auth.tokens.accessToken;
}

export interface LoginResult {
  tokens: StoredTokens;
  profile: OAuthProfile | null;
}

export interface LoginCallbacks {
  onProgress?: (msg: string) => void;
  onOpenUrl?: (url: string) => void;
}

export interface EnsureAuthResult {
  status: "already_authenticated" | "refreshed" | "logged_in";
  email: string | null;
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const existing = loadAuth();

  if (existing?.tokens?.accessToken && !isTokenExpired(existing.tokens)) {
    const valid = await verifyAuth(existing.tokens.accessToken);
    if (valid) {
      return { status: "already_authenticated", email: existing.profile?.email ?? null };
    }
  }

  if (existing?.tokens?.refreshToken) {
    try {
      const newTokens = await refreshTokens(existing.tokens.refreshToken);
      saveAuth({ ...existing, tokens: newTokens, updatedAt: new Date().toISOString() });
      return { status: "refreshed", email: existing.profile?.email ?? null };
    } catch { /* refresh failed — fall through to full login */ }
  }

  const result = await login(callbacks);
  saveAuth({ tokens: result.tokens, profile: result.profile, updatedAt: new Date().toISOString() });
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export function hasConfiguredCredentials(): boolean {
  const auth = loadAuth();
  return !!auth?.tokens?.accessToken || !!auth?.tokens?.refreshToken;
}

export { clearAuth };

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs: LoginCallbacks = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  const say = cbs.onProgress ?? console.log;
  const openUrl = cbs.onOpenUrl ?? ((url: string) => {
    const openCmd = isWindows
      ? ["powershell", "-NoProfile", "-Command", `Start-Process "${url}"`]
      : ["xdg-open", url];
    Bun.spawn(openCmd, { stdout: "ignore", stderr: "ignore" }).unref();
  });

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const { port, waitForCallback, shutdown } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${port}/callback`;

  try {
    const url = new URL(CLAUDEAI_AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", CLAUDE_AI_SCOPES.join(" "));
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    say("Opening browser for authentication...");
    openUrl(url.toString());

    const { code } = await waitForCallback();
    say("Exchanging authorization code...");

    const tokenData = await exchangeCode(code, codeVerifier, state, redirectUri);
    const profile = await fetchProfile(tokenData.access_token);
    const roles = await fetchRoles(tokenData.access_token);

    return {
      tokens: {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
        scopes: tokenData.scope?.split(" ") ?? CLAUDE_AI_SCOPES,
        subscriptionType: mapSubscription(profile?.organization?.organization_type),
        rateLimitTier: profile?.organization?.rate_limit_tier ?? null,
      },
      profile: profile ? {
        accountUuid: profile.account.uuid,
        email: profile.account.email,
        displayName: profile.account.display_name,
        organizationUuid: profile.organization?.uuid ?? null,
        organizationName: profile.organization?.name ?? null,
        organizationType: profile.organization?.organization_type ?? null,
        organizationRole: roles?.organization_role ?? null,
        workspaceRole: roles?.workspace_role ?? null,
      } : null,
    };
  } finally {
    shutdown();
  }
}
