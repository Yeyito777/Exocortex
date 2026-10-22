import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth } from "../../store";
import { AuthError, isNonRetryableProviderError } from "../errors";
import {
  currentOpenAILoginKind,
  ensureAuthenticated,
  getCurrentAccountKey,
  getVerifiedSession,
  hasConfiguredCredentials,
  logout,
  setOpenAIBrowserOAuthForTest,
  type StoredOpenAIAuthPool,
} from "./auth";
import { loadOpenAIApiKey, openAIApiKeyAccountKey, redactOpenAIApiKey } from "./api-key";
import { streamMessage, streamMessageWithSession } from "./api";
import { OPENAI_API_MODELS_URL, OPENAI_API_RESPONSES_URL, OPENAI_TOKEN_URL } from "./constants";
import { selectOpenAIApiKeyModels } from "./models";
import { apiKeyUsage, resetApiKeyUsageForTest } from "./api-key-usage";
import type { StoredOpenAIAuth } from "./session";

const originalFetch = globalThis.fetch;
const API_KEY = "sk-proj-test-key-0123456789abcdef";

function chatGPTAuth(expired: boolean): StoredOpenAIAuth {
  return {
    tokens: {
      accessToken: "chatgpt-access",
      refreshToken: "chatgpt-refresh",
      expiresAt: expired ? Date.now() - 60_000 : Date.now() + 60 * 60_000,
      scopes: [],
      subscriptionType: "pro",
      rateLimitTier: null,
    },
    profile: {
      accountUuid: "acct_one",
      email: "one@example.com",
      displayName: null,
      organizationUuid: null,
      organizationName: null,
      organizationType: null,
      organizationRole: null,
      workspaceRole: null,
    },
    updatedAt: new Date().toISOString(),
    source: "oauth",
    authMode: null,
    accountId: "acct_one",
    idToken: null,
  };
}

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const expiredRefreshBody = JSON.stringify({
  error: { message: "Your session has expired. Please log in again.", type: "invalid_request_error", code: "refresh_token_expired" },
});

/** Fetch mock: /v1/models lists `models`, the token endpoint answers 401 refresh_token_expired. */
function mockOpenAI(models: string[] = ["gpt-6.1-sol", "gpt-6-luna", "dall-e-3"]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === OPENAI_API_MODELS_URL) {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth !== `Bearer ${API_KEY}`) {
        return new Response(JSON.stringify({ error: { code: "invalid_api_key", message: "Incorrect API key provided: sk-***" } }), { status: 401 });
      }
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
    }
    if (url === OPENAI_TOKEN_URL) return new Response(expiredRefreshBody, { status: 401 });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOpenAIBrowserOAuthForTest(null);
  clearProviderAuth("openai");
  clearProviderAuth("openai-api-key");
  resetApiKeyUsageForTest();
});

describe("expired ChatGPT refresh tokens", () => {
  test("a 401 refresh_token_expired is a non-retryable login error, and the token endpoint is not asked again", async () => {
    saveProviderAuth("openai", chatGPTAuth(true));
    const calls = mockOpenAI();

    const first = await getVerifiedSession().catch((err: unknown) => err);
    expect(first).toBeInstanceOf(AuthError);
    expect((first as Error).message).toMatch(/expired.*\/login openai/i);
    expect((first as Error).message).not.toContain("Your session has expired");

    await expect(getVerifiedSession()).rejects.toBeInstanceOf(AuthError);
    expect(calls.filter((call) => call.url === OPENAI_TOKEN_URL)).toHaveLength(1);
    // Persisted, so a daemon restart does not retry the dead token either.
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.accounts[0]?.refreshRejected).toMatch(/refresh_token_expired/);
  });

  test("a turn fails at once instead of retrying the refresh", async () => {
    saveProviderAuth("openai", chatGPTAuth(true));
    const calls = mockOpenAI();
    const onRetry = mock(() => {});

    await expect(streamMessage([{ role: "user", content: "hi" }], "gpt-6-luna", {
      onText: () => {}, onThinking: () => {}, onRetry,
    })).rejects.toBeInstanceOf(AuthError);
    expect(onRetry).not.toHaveBeenCalled();
    expect(calls.filter((call) => call.url === OPENAI_TOKEN_URL)).toHaveLength(1);
  });

  test("a transient refresh failure stays retryable", async () => {
    saveProviderAuth("openai", chatGPTAuth(true));
    globalThis.fetch = mock(async () => new Response("upstream down", { status: 503 })) as unknown as typeof fetch;
    const err = await getVerifiedSession().catch((error: unknown) => error);
    expect(err).not.toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("Token refresh failed (503)");
  });
});

describe("OpenAI API-key login", () => {
  test("verifies the key, stores it, and makes it the session requests use", async () => {
    const calls = mockOpenAI();
    await expect(ensureAuthenticated(undefined, { apiKey: ` ${API_KEY}\n` })).resolves.toEqual({
      status: "logged_in",
      email: `API key ${redactOpenAIApiKey(API_KEY)}`,
    });
    expect(calls.map((call) => call.url)).toEqual([OPENAI_API_MODELS_URL]);
    expect(loadOpenAIApiKey()).toMatchObject({ apiKey: API_KEY, active: true, models: ["dall-e-3", "gpt-6-luna", "gpt-6.1-sol"] });
    expect(hasConfiguredCredentials()).toBe(true);
    expect(currentOpenAILoginKind()).toBe("api_key");
    expect(getCurrentAccountKey()).toBe(openAIApiKeyAccountKey(API_KEY));
    await expect(getVerifiedSession()).resolves.toMatchObject({ kind: "api_key", accessToken: API_KEY, accountId: null });
    // ChatGPT-backend features never get the API key.
    await expect(getVerifiedSession({ chatgptOnly: true })).rejects.toBeInstanceOf(AuthError);
  });

  test("a rejected key is not stored and its error does not echo the key", async () => {
    mockOpenAI();
    const err = await ensureAuthenticated(undefined, { apiKey: "sk-proj-wrong-key-000000000000" }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toBe("OpenAI API key verification failed (401): invalid_api_key");
    expect(loadOpenAIApiKey()).toBeNull();
  });

  test("the most recent login wins", async () => {
    mockOpenAI();
    saveProviderAuth("openai", chatGPTAuth(false));
    expect(currentOpenAILoginKind()).toBe("chatgpt");

    await ensureAuthenticated(undefined, { apiKey: API_KEY });
    expect(currentOpenAILoginKind()).toBe("api_key");

    setOpenAIBrowserOAuthForTest(async () => ({
      access_token: jwt({ sub: "user", email: "one@example.com" }),
      refresh_token: "fresh-refresh",
      expires_in: 3600,
    }));
    globalThis.fetch = mock(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    // Stored ChatGPT session cannot be verified (404) → interactive login.
    await ensureAuthenticated(undefined, { method: "browser" });
    expect(currentOpenAILoginKind()).toBe("chatgpt");
    expect(loadOpenAIApiKey()?.active).toBe(false);
  });

  test("an expired ChatGPT session falls back to a stored API key instead of blocking it", async () => {
    mockOpenAI();
    await ensureAuthenticated(undefined, { apiKey: API_KEY });
    // A ChatGPT login after it, which has since expired.
    saveProviderAuth("openai", chatGPTAuth(true));
    saveProviderAuth("openai-api-key", { ...loadOpenAIApiKey(), active: false });
    expect(currentOpenAILoginKind()).toBe("chatgpt");

    await expect(getVerifiedSession()).resolves.toMatchObject({ kind: "api_key", accessToken: API_KEY });
    expect(currentOpenAILoginKind()).toBe("api_key");
    expect(getCurrentAccountKey()).toBe(openAIApiKeyAccountKey(API_KEY));
  });

  test("switching login method is refused while OpenAI turns are running", async () => {
    mockOpenAI();
    saveProviderAuth("openai", chatGPTAuth(false));
    await expect(ensureAuthenticated(undefined, { apiKey: API_KEY, requireSameAccount: true }))
      .rejects.toThrow(/after they finish/);
    expect(loadOpenAIApiKey()).toBeNull();
  });

  test("logout clears the API key and the ChatGPT accounts", async () => {
    mockOpenAI();
    saveProviderAuth("openai", chatGPTAuth(false));
    await ensureAuthenticated(undefined, { apiKey: API_KEY });
    expect(logout()).toBe(true);
    expect(loadOpenAIApiKey()).toBeNull();
    expect(hasConfiguredCredentials()).toBe(false);
  });
});

describe("OpenAI API-key requests", () => {
  const session = { kind: "api_key" as const, accessToken: API_KEY, accountId: null, accountKey: openAIApiKeyAccountKey(API_KEY) };

  function completion(): Response {
    const events = [
      { type: "response.created", response: { id: "resp_api" } },
      { type: "response.completed", response: { id: "resp_api", output: [{ type: "message", id: "msg_api", content: [{ type: "output_text", text: "OK" }] }], usage: { input_tokens: 5, output_tokens: 1 } } },
    ];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
  }

  test("go to the public Responses API over HTTPS without Codex headers or fields", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
      return completion();
    }) as unknown as typeof fetch;

    const result = await streamMessageWithSession(session, [{ role: "user", content: "hi" }], "gpt-6.1-sol",
      { onText: () => {}, onThinking: () => {} },
      { promptCacheKey: "conv-1", serviceTier: "ultrafast", tools: [{ name: "noop", description: "noop", input_schema: { type: "object", properties: {} } }] });

    expect(result.text).toBe("OK");
    expect(seen!.url).toBe(OPENAI_API_RESPONSES_URL);
    expect(seen!.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(Object.keys(seen!.headers).filter((name) => /codex|chatgpt|session|thread|openai-beta|cookie/i.test(name))).toEqual([]);
    expect(seen!.body).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false, prompt_cache_key: "conv-1" });
    expect(seen!.body.client_metadata).toBeUndefined();
    expect(seen!.body.access_programs).toBeUndefined();
    expect(seen!.body.service_tier).toBeUndefined();
    // Counted for the API-key usage readout.
    expect(apiKeyUsage(session.accountKey, "x").today).toMatchObject({ requests: 1, inputTokens: 5, outputTokens: 1 });
  });

  test("an exhausted quota fails without retries", async () => {
    let requests = 0;
    globalThis.fetch = mock(async () => {
      requests++;
      return new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." } }), { status: 429 });
    }) as unknown as typeof fetch;
    const onRetry = mock(() => {});
    const err = await streamMessageWithSession(session, [{ role: "user", content: "hi" }], "gpt-6-luna",
      { onText: () => {}, onThinking: () => {}, onRetry }).catch((error: unknown) => error);
    expect(isNonRetryableProviderError(err)).toBe(true);
    expect((err as Error).message).toMatch(/quota/i);
    expect(requests).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("a rejected key asks for a new API-key login", async () => {
    globalThis.fetch = mock(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const err = await streamMessageWithSession(session, [{ role: "user", content: "hi" }], "gpt-6-luna",
      { onText: () => {}, onThinking: () => {} }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("/login openai key");
  });
});

describe("API-key model list", () => {
  test("offers only supported models the key can use, without Codex-only features", () => {
    const models = selectOpenAIApiKeyModels([
      "gpt-6-luna", "gpt-6.1-sol", "gpt-5.4-mini", "gpt-6-sol-daybreak", "gpt-5.3-codex-spark",
      "dall-e-3", "gpt-7-sol", "text-embedding-3-small",
    ]);
    expect(models.map((model) => model.id)).toEqual(["gpt-6.1-sol", "gpt-6-luna", "gpt-5.4-mini", "gpt-7-sol"]);
    expect(models.every((model) => !model.supportsUltrafastMode && !model.supportsDaybreak && !model.supportsStandardCyber)).toBe(true);
    expect(models.find((model) => model.id === "gpt-6.1-sol")?.supportedEfforts.map((effort) => effort.effort)).toContain("max");
  });
});
