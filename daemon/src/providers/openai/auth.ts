import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { log } from "../../log";
import {
  clearProviderAuth,
  isTokenExpired,
  loadProviderAuth,
  saveProviderAuth,
  type OAuthProfile,
  type StoredTokens,
} from "../../store";
import {
  OPENAI_AUTH_CLIENT_ID,
  OPENAI_AUTH_URL,
  OPENAI_CALLBACK_PATH,
  OPENAI_CALLBACK_PORT,
  OPENAI_CODEX_CLIENT_VERSION,
  OPENAI_MODELS_URL,
  OPENAI_ORIGINATOR,
  OPENAI_TOKEN_URL,
  OPENAI_USERINFO_URL,
} from "./constants";
import { isWindows } from "@exocortex/shared/paths";

const CODEX_AUTH_PATH = join(homedir(), ".config", "codex", "auth.json");
const OPENAI_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
];

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface StoredOpenAIAuth {
  tokens: StoredTokens;
  profile: OAuthProfile | null;
  updatedAt: string;
  source: "codex" | "oauth";
  authMode: string | null;
  accountId: string | null;
  idToken: string | null;
}

interface CodexAuthFile {
  auth_mode?: string;
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
}

interface OpenAITokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
}

interface DecodedClaims {
  sub?: string;
  email?: string;
  name?: string;
  scope?: string;
  chatgpt_plan_type?: string;
  exp?: number;
}

interface LoginFlowResult {
  auth: StoredOpenAIAuth;
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

function loadStoredAuth(): StoredOpenAIAuth | null {
  return loadProviderAuth<StoredOpenAIAuth>("openai");
}

function saveStoredAuth(auth: StoredOpenAIAuth): void {
  saveProviderAuth("openai", auth);
}

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

function decodeJwt(token: string | null | undefined): DecodedClaims | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as DecodedClaims;
  } catch {
    return null;
  }
}

async function fetchUserInfo(accessToken: string): Promise<{ sub?: string; email?: string; name?: string } | null> {
  try {
    const res = await fetch(OPENAI_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ sub?: string; email?: string; name?: string }>;
  } catch {
    return null;
  }
}

function mapSubscription(claims: DecodedClaims | null): string | null {
  return claims?.chatgpt_plan_type ?? null;
}

function buildScopes(token: OpenAITokenResponse, accessClaims: DecodedClaims | null): string[] {
  const scope = token.scope ?? accessClaims?.scope ?? "";
  return scope.split(" ").map((part) => part.trim()).filter(Boolean);
}

async function buildStoredAuth(
  token: OpenAITokenResponse,
  source: StoredOpenAIAuth["source"],
  opts?: {
    accountId?: string | null;
    authMode?: string | null;
    fallbackRefreshToken?: string | null;
    fallbackIdToken?: string | null;
  },
): Promise<StoredOpenAIAuth> {
  const accessClaims = decodeJwt(token.access_token);
  const idToken = token.id_token ?? opts?.fallbackIdToken ?? null;
  const idClaims = decodeJwt(idToken);
  const userInfo = await fetchUserInfo(token.access_token);

  return {
    tokens: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? opts?.fallbackRefreshToken ?? null,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: buildScopes(token, accessClaims),
      subscriptionType: mapSubscription(accessClaims) ?? mapSubscription(idClaims),
      rateLimitTier: null,
    },
    profile: {
      accountUuid: opts?.accountId ?? userInfo?.sub ?? idClaims?.sub ?? accessClaims?.sub ?? "",
      email: userInfo?.email ?? idClaims?.email ?? accessClaims?.email ?? "",
      displayName: userInfo?.name ?? idClaims?.name ?? accessClaims?.name ?? null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source,
    authMode: opts?.authMode ?? null,
    accountId: opts?.accountId ?? null,
    idToken,
  };
}

function loadCodexAuthFile(): CodexAuthFile | null {
  if (!existsSync(CODEX_AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CODEX_AUTH_PATH, "utf8")) as CodexAuthFile;
  } catch (err) {
    log("warn", `openai auth: failed to parse ${CODEX_AUTH_PATH}: ${err}`);
    return null;
  }
}

function requestHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    originator: OPENAI_ORIGINATOR,
    "User-Agent": "exocortexd/openai",
  };
}

function requestHeadersWithAccount(accessToken: string, accountId?: string | null): HeadersInit {
  return {
    ...requestHeaders(accessToken),
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<OpenAITokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_AUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });

  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<OpenAITokenResponse>;
}

let inflightRefresh: Promise<StoredOpenAIAuth> | null = null;

export async function refreshTokens(refreshToken: string): Promise<StoredTokens> {
  const refreshed = await refreshStoredAuth(refreshToken);
  return refreshed.tokens;
}

async function refreshStoredAuth(
  refreshToken: string,
  opts?: { source?: StoredOpenAIAuth["source"]; accountId?: string | null; authMode?: string | null; fallbackIdToken?: string | null },
): Promise<StoredOpenAIAuth> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_AUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });

    const res = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      if (res.status === 400 && text.includes("invalid_grant")) {
        throw new AuthError(`Session expired — use login to re-authenticate. (${text})`);
      }
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const token = await res.json() as OpenAITokenResponse;
    return buildStoredAuth(token, opts?.source ?? "oauth", {
      accountId: opts?.accountId,
      authMode: opts?.authMode,
      fallbackRefreshToken: refreshToken,
      fallbackIdToken: opts?.fallbackIdToken ?? null,
    });
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export async function verifyAuth(accessToken: string, accountId?: string | null): Promise<boolean> {
  try {
    const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
    const res = await fetch(url, {
      headers: requestHeadersWithAccount(accessToken, accountId),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function importCodexSession(): Promise<StoredOpenAIAuth | null> {
  const codex = loadCodexAuthFile();
  const refreshToken = codex?.tokens?.refresh_token;
  const accessToken = codex?.tokens?.access_token;
  if (!refreshToken && !accessToken) return null;

  if (refreshToken) {
    return refreshStoredAuth(refreshToken, {
      source: "codex",
      accountId: codex?.tokens?.account_id ?? null,
      authMode: codex?.auth_mode ?? null,
      fallbackIdToken: codex?.tokens?.id_token ?? null,
    });
  }

  if (!accessToken || !(await verifyAuth(accessToken, codex?.tokens?.account_id ?? null))) return null;

  const claims = decodeJwt(accessToken);
  return {
    tokens: {
      accessToken,
      refreshToken: null,
      expiresAt: claims?.exp ? claims.exp * 1000 : Date.now() + 15 * 60 * 1000,
      scopes: (claims?.scope ?? "").split(" ").filter(Boolean),
      subscriptionType: mapSubscription(claims),
      rateLimitTier: null,
    },
    profile: {
      accountUuid: codex?.tokens?.account_id ?? claims?.sub ?? "",
      email: claims?.email ?? "",
      displayName: claims?.name ?? null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source: "codex",
    authMode: codex?.auth_mode ?? null,
    accountId: codex?.tokens?.account_id ?? null,
    idToken: codex?.tokens?.id_token ?? null,
  };
}

interface CallbackResult {
  code: string;
  state: string;
}

async function startCallbackServer(
  expectedState: string,
): Promise<{ waitForCallback: () => Promise<CallbackResult>; shutdown: () => void }> {
  const server = createServer();
  let resolveCallback: ((result: CallbackResult) => void) | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${OPENAI_CALLBACK_PORT}`);
    if (url.pathname !== OPENAI_CALLBACK_PATH) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      res.writeHead(400);
      res.end(`OpenAI auth failed: ${error}`);
      rejectCallback?.(new Error(`OAuth error: ${error}`));
      return;
    }
    if (!code || !state || state !== expectedState) {
      res.writeHead(400);
      res.end("Invalid callback");
      rejectCallback?.(new Error("OAuth state mismatch"));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body style=\"font-family:sans-serif;padding:2rem\">Authentication completed. You can close this tab.</body></html>");
    resolveCallback?.({ code, state });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(OPENAI_CALLBACK_PORT, "127.0.0.1", () => resolve());
  });

  const waitForCallback = (): Promise<CallbackResult> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth callback timed out")), 300_000);
    resolveCallback = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    rejectCallback = (error) => {
      clearTimeout(timer);
      reject(error);
    };
  });

  return {
    waitForCallback,
    shutdown: () => server.close(),
  };
}

function defaultOpenUrl(url: string): void {
  const openCmd = isWindows
    ? ["powershell", "-NoProfile", "-Command", `Start-Process "${url}"`]
    : ["xdg-open", url];
  Bun.spawn(openCmd, { stdout: "ignore", stderr: "ignore" }).unref();
}

async function runBrowserLogin(callbacks?: LoginCallbacks): Promise<LoginFlowResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const openUrl = callbacks?.onOpenUrl ?? defaultOpenUrl;

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = generateState();
  const { waitForCallback, shutdown } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${OPENAI_CALLBACK_PORT}${OPENAI_CALLBACK_PATH}`;

  try {
    const url = new URL(OPENAI_AUTH_URL);
    url.searchParams.set("client_id", OPENAI_AUTH_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", OPENAI_SCOPES.join(" "));
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", OPENAI_ORIGINATOR);

    say("Opening browser for OpenAI authentication...");
    openUrl(url.toString());

    const { code } = await waitForCallback();
    say("Exchanging OpenAI authorization code...");
    const token = await exchangeCode(code, verifier, redirectUri);
    const auth = await buildStoredAuth(token, "oauth");
    return { auth };
  } finally {
    shutdown();
  }
}

export async function ensureAuthenticated(callbacks?: LoginCallbacks): Promise<EnsureAuthResult> {
  const say = callbacks?.onProgress ?? (() => {});
  const stored = loadStoredAuth();

  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens)) {
    say("Checking stored OpenAI session...");
    if (await verifyAuth(stored.tokens.accessToken, stored.accountId)) {
      return { status: "already_authenticated", email: stored.profile?.email ?? null };
    }
    log("warn", "openai auth: stored access token failed verification");
  }

  if (stored?.tokens?.refreshToken) {
    say("Refreshing stored OpenAI session...");
    try {
      const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
        source: stored.source,
        accountId: stored.accountId,
        authMode: stored.authMode,
        fallbackIdToken: stored.idToken,
      });
      saveStoredAuth(refreshed);
      return { status: "refreshed", email: refreshed.profile?.email ?? null };
    } catch (err) {
      log("warn", `openai auth: stored refresh failed: ${err}`);
    }
  }

  if (loadCodexAuthFile()) {
    say("Importing local Codex/OpenAI session...");
    const imported = await importCodexSession();
    if (imported) {
      saveStoredAuth(imported);
      return { status: "logged_in", email: imported.profile?.email ?? null };
    }
  }

  const result = await login(callbacks);
  saveStoredAuth({
    tokens: result.tokens,
    profile: result.profile,
    updatedAt: new Date().toISOString(),
    source: "oauth",
    authMode: "oauth",
    accountId: result.profile?.accountUuid ?? null,
    idToken: null,
  });
  return { status: "logged_in", email: result.profile?.email ?? null };
}

export async function login(callbacks?: LoginCallbacks | ((msg: string) => void)): Promise<LoginResult> {
  const cbs = typeof callbacks === "function" ? { onProgress: callbacks } : callbacks ?? {};
  const codex = loadCodexAuthFile();
  if (codex) {
    cbs.onProgress?.("Using local Codex/OpenAI session...");
    const imported = await importCodexSession();
    if (imported) {
      saveStoredAuth(imported);
      return { tokens: imported.tokens, profile: imported.profile };
    }
  }

  const result = await runBrowserLogin(cbs);
  saveStoredAuth(result.auth);
  return {
    tokens: result.auth.tokens,
    profile: result.auth.profile,
  };
}

export function hasConfiguredCredentials(): boolean {
  const stored = loadStoredAuth();
  return !!stored?.tokens?.accessToken || !!stored?.tokens?.refreshToken || existsSync(CODEX_AUTH_PATH);
}

export async function getVerifiedAccessToken(): Promise<string> {
  return (await getVerifiedSession()).accessToken;
}

export interface VerifiedOpenAISession {
  accessToken: string;
  accountId: string | null;
}

export async function getVerifiedSession(): Promise<VerifiedOpenAISession> {
  const stored = loadStoredAuth();
  if (stored?.tokens?.accessToken && !isTokenExpired(stored.tokens) && await verifyAuth(stored.tokens.accessToken, stored.accountId)) {
    return { accessToken: stored.tokens.accessToken, accountId: stored.accountId };
  }

  if (stored?.tokens?.refreshToken) {
    const refreshed = await refreshStoredAuth(stored.tokens.refreshToken, {
      source: stored.source,
      accountId: stored.accountId,
      authMode: stored.authMode,
      fallbackIdToken: stored.idToken,
    });
    saveStoredAuth(refreshed);
    return { accessToken: refreshed.tokens.accessToken, accountId: refreshed.accountId };
  }

  const imported = await importCodexSession();
  if (imported) {
    saveStoredAuth(imported);
    return { accessToken: imported.tokens.accessToken, accountId: imported.accountId };
  }

  throw new AuthError("OpenAI is not authenticated. Run `bun run src/main.ts login openai`.");
}

export function logout(): boolean {
  return clearProviderAuth("openai");
}
