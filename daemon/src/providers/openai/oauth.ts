import { createServer, type IncomingMessage, type ServerResponse } from "http";
import {
  OPENAI_AUTH_CLIENT_ID,
  OPENAI_AUTH_URL,
  OPENAI_CALLBACK_PATH,
  OPENAI_CALLBACK_PORT,
  OPENAI_ORIGINATOR,
  OPENAI_TOKEN_URL,
} from "./constants";
import { generateCodeChallenge, generateCodeVerifier, generateState, openUrlInBrowser } from "../oauth";
import type { LoginCallbacks } from "../types";
import type { OpenAITokenResponse } from "./session";

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
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      originator: OPENAI_ORIGINATOR,
      "User-Agent": "exocortexd/openai",
    },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }
  try {
    return JSON.parse(text) as OpenAITokenResponse;
  } catch {
    throw new Error(`Token exchange returned non-JSON response: ${text.slice(0, 500)}`);
  }
}

export async function runOpenAIBrowserOAuth(callbacks?: LoginCallbacks): Promise<OpenAITokenResponse> {
  const say = callbacks?.onProgress ?? (() => {});
  const openUrl = callbacks?.onOpenUrl ?? openUrlInBrowser;

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
    url.searchParams.set("scope", [
      "openid",
      "profile",
      "email",
      "offline_access",
      "api.connectors.read",
      "api.connectors.invoke",
    ].join(" "));
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", OPENAI_ORIGINATOR);

    say("Opening browser for OpenAI authentication...");
    openUrl(url.toString());

    const { code } = await waitForCallback();
    say("Exchanging OpenAI authorization code...");
    return await exchangeCode(code, verifier, redirectUri);
  } finally {
    shutdown();
  }
}
