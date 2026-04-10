import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildStoredAuth, enrichStoredAuth, type StoredOpenAIAuth } from "./session";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI stored auth", () => {
  test("stores the ChatGPT account id from account-check responses", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/userinfo")) {
        return Promise.resolve(new Response(JSON.stringify({
          sub: "google-oauth2|subject",
          email: "user@example.com",
          name: "Example User",
        }), { status: 200 }));
      }

      if (url.includes("/backend-api/accounts/check/")) {
        return Promise.resolve(new Response(JSON.stringify({
          accounts: {
            "acct_personal": {
              account: {
                account_id: "acct_personal",
                name: "Personal",
                structure: "personal",
                plan_type: "pro",
                account_user_role: "account-owner",
                workspace_type: null,
                is_deactivated: false,
              },
            },
          },
        }), { status: 200 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const auth = await buildStoredAuth({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      scope: "openid profile email offline_access",
    }, "oauth");

    expect(auth.accountId).toBe("acct_personal");
    expect(auth.profile?.accountUuid).toBe("acct_personal");
    expect(auth.profile?.email).toBe("user@example.com");
    expect(auth.profile?.organizationName).toBe("Personal");
    expect(auth.profile?.organizationType).toBe("personal");
    expect(auth.profile?.organizationRole).toBe("account-owner");
    expect(auth.tokens.subscriptionType).toBe("pro");
  });

  test("backfills a missing account id from the accounts list", async () => {
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/backend-api/accounts/check/")) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }

      if (url.endsWith("/backend-api/accounts")) {
        return Promise.resolve(new Response(JSON.stringify({
          items: [
            {
              id: "acct_personal",
              name: "Personal",
              structure: "personal",
              current_user_role: "account-owner",
              is_deactivated: false,
            },
          ],
        }), { status: 200 }));
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const stored: StoredOpenAIAuth = {
      tokens: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: Date.now() + 60_000,
        scopes: [],
        subscriptionType: null,
        rateLimitTier: null,
      },
      profile: {
        accountUuid: "google-oauth2|subject",
        email: "user@example.com",
        displayName: "Example User",
        organizationUuid: null,
        organizationName: null,
        organizationType: null,
        organizationRole: null,
        workspaceRole: null,
      },
      updatedAt: new Date().toISOString(),
      source: "oauth",
      authMode: null,
      accountId: null,
      idToken: null,
    };

    const enriched = await enrichStoredAuth(stored);

    expect(enriched.accountId).toBe("acct_personal");
    expect(enriched.profile?.accountUuid).toBe("acct_personal");
    expect(enriched.profile?.organizationName).toBe("Personal");
    expect(enriched.profile?.organizationType).toBe("personal");
    expect(enriched.profile?.workspaceRole).toBe("account-owner");
  });
});
