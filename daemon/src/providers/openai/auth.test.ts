import { afterEach, describe, expect, mock, test } from "bun:test";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth } from "../../store";
import { getVerifiedSession, listAccounts, switchAccount, type StoredOpenAIAuthPool } from "./auth";
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
  clearProviderAuth("openai");
});

describe("OpenAI multi-account auth", () => {
  test("selects connected accounts in round-table order", async () => {
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

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-two", accountId: "acct_two" });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.tokens.accessToken).toBe("token-two");
    expect(listAccounts().map((account) => ({ email: account.email, current: account.current }))).toEqual([
      { email: "one@example.com", current: false },
      { email: "two@example.com", current: true },
    ]);

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-one", accountId: "acct_one" });
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

    await expect(getVerifiedSession()).resolves.toEqual({ accessToken: "token-two", accountId: "acct_two" });
    expect(loadProviderAuth<StoredOpenAIAuthPool>("openai")?.nextIndexOverride).toBeNull();
  });
});
