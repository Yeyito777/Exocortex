import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth } from "../../store";
import {
  ensureAuthenticated,
  getCurrentAccountScope,
  getOpenAIAuthSessionRevision,
  getVerifiedSession,
  listAccounts,
  setOpenAIBrowserOAuthForTest,
  switchAccount,
  type StoredOpenAIAuthPool,
} from "./auth";
import type { StoredOpenAIAuth } from "./session";

const originalFetch = globalThis.fetch;

function makeAuth(email: string, accountId: string, accessToken: string): StoredOpenAIAuth {
  return {
    tokens: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      expiresAt: Date.now() + 60 * 60_000,
      scopes: [],
      subscriptionType: "pro",
      rateLimitTier: null,
    },
    profile: {
      accountUuid: accountId,
      email,
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
    accountId,
    idToken: null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  setOpenAIBrowserOAuthForTest(null);
  clearProviderAuth("openai");
});

function jwt(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

describe("OpenAI multi-account auth", () => {
  test("replaces a rejected current session with browser OAuth for the same account", async () => {
    const stale = makeAuth("one@example.com", "acct_one", "stale-token");
    stale.tokens.expiresAt = Date.now() - 60_000;
    saveProviderAuth("openai", stale);
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: "refresh_token_invalidated" },
    }), { status: 401 }))) as unknown as typeof fetch;
    setOpenAIBrowserOAuthForTest(async () => ({
      access_token: jwt({ sub: "google-oauth-subject", email: "one@example.com" }),
      refresh_token: "replacement-refresh",
      expires_in: 3600,
    }));
    const revisionBefore = getOpenAIAuthSessionRevision();

    await expect(ensureAuthenticated(undefined, { requireSameAccount: true })).resolves.toMatchObject({
      status: "logged_in",
      email: "one@example.com",
    });

    const stored = loadProviderAuth<StoredOpenAIAuthPool>("openai");
    expect(stored?.tokens.refreshToken).toBe("replacement-refresh");
    expect(stored?.accounts).toHaveLength(1);
    expect(stored?.accountId).toBe("acct_one");
    expect(stored?.profile?.accountUuid).toBe("acct_one");
    expect(getOpenAIAuthSessionRevision()).not.toBe(revisionBefore);
  });

  test("does not replace an active account when browser OAuth returns another account", async () => {
    const stale = makeAuth("one@example.com", "acct_one", "stale-token");
    stale.tokens.expiresAt = Date.now() - 60_000;
    saveProviderAuth("openai", stale);
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: "refresh_token_invalidated" },
    }), { status: 401 }))) as unknown as typeof fetch;
    setOpenAIBrowserOAuthForTest(async () => ({
      access_token: jwt({ sub: "acct_two", email: "two@example.com" }),
      refresh_token: "other-refresh",
      expires_in: 3600,
    }));

    await expect(ensureAuthenticated(undefined, { requireSameAccount: true })).rejects.toThrow(/different OpenAI account/i);

    const stored = loadProviderAuth<StoredOpenAIAuthPool>("openai");
    expect(stored?.tokens.accessToken).toBe("stale-token");
    expect(stored?.tokens.refreshToken).toBe("stale-token-refresh");
  });

  test("derives a non-secret persisted account scope", () => {
    const auth = makeAuth("one@example.com", "acct_one", "token-one");
    saveProviderAuth("openai", auth);

    const scope = getCurrentAccountScope();
    expect(scope).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(scope).not.toContain("acct_one");
    expect(scope).not.toContain("token-one");
    expect(getCurrentAccountScope()).toBe(scope);
  });

  test("uses the app-wide selected account consistently", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    const accounts = [
      makeAuth("one@example.com", "acct_one", "token-one"),
      makeAuth("two@example.com", "acct_two", "token-two"),
    ];
    const pool: StoredOpenAIAuthPool = {
      ...accounts[0],
      multiAccountVersion: 1,
      accounts,
      currentIndex: 0,
    };
    saveProviderAuth("openai", pool);

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-one", accountId: "acct_one", accountKey: "acct_one" });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.tokens.accessToken).toBe("token-one");
    expect(listAccounts().map((account) => ({ email: account.email, current: account.current }))).toEqual([
      { email: "one@example.com", current: true },
      { email: "two@example.com", current: false },
    ]);

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-one", accountId: "acct_one", accountKey: "acct_one" });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.tokens.accessToken).toBe("token-one");
    expect(listAccounts().map((account) => ({ email: account.email, current: account.current }))).toEqual([
      { email: "one@example.com", current: true },
      { email: "two@example.com", current: false },
    ]);
  });

  test("switches the current account by email", () => {
    const accounts = [
      makeAuth("one@example.com", "acct_one", "token-one"),
      makeAuth("two@example.com", "acct_two", "token-two"),
    ];
    saveProviderAuth("openai", {
      ...accounts[0],
      multiAccountVersion: 1,
      accounts,
      currentIndex: 0,
    } satisfies StoredOpenAIAuthPool);

    expect(switchAccount("two@example.com")).toMatchObject({
      email: "two@example.com",
      current: true,
    });
    const stored = loadProviderAuth<StoredOpenAIAuthPool>("openai");
    expect(stored?.currentIndex).toBe(1);
    expect(stored?.tokens.accessToken).toBe("token-two");
    expect(listAccounts().map((account) => ({ email: account.email, current: account.current }))).toEqual([
      { email: "one@example.com", current: false },
      { email: "two@example.com", current: true },
    ]);
  });

  test("switches the current account by censored email label", () => {
    const accounts = [
      makeAuth("one@example.com", "acct_one", "token-one"),
      makeAuth("two@example.com", "acct_two", "token-two"),
    ];
    saveProviderAuth("openai", {
      ...accounts[0],
      multiAccountVersion: 1,
      accounts,
      currentIndex: 0,
    } satisfies StoredOpenAIAuthPool);

    expect(switchAccount("t**@example.com")).toMatchObject({
      email: "two@example.com",
      current: true,
    });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.currentIndex).toBe(1);
  });

  test("uses a switched account on the next request instead of rotating past it", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    const accounts = [
      makeAuth("one@example.com", "acct_one", "token-one"),
      makeAuth("two@example.com", "acct_two", "token-two"),
    ];
    saveProviderAuth("openai", {
      ...accounts[0],
      multiAccountVersion: 1,
      accounts,
      currentIndex: 0,
    } satisfies StoredOpenAIAuthPool);

    switchAccount("two@example.com");

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-two", accountId: "acct_two", accountKey: "acct_two" });
    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-two", accountId: "acct_two", accountKey: "acct_two" });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.currentIndex).toBe(1);
  });
});
