import { afterEach, expect, mock, test } from "bun:test";
import { loadProviderAuth } from "../../store";
import { clearAuth, ensureAuthenticated, verifyAuth, hasConfiguredCredentials } from "./auth";
import type { StoredOpenRouterAuth } from "./types";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAuth();
  if (originalKey == null) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

test("requires an OpenRouter key", async () => {
  clearAuth();
  await expect(ensureAuthenticated()).rejects.toThrow("/login openrouter <api-key>");
});

test("verifies against authenticated /key, never public /models", async () => {
  clearAuth();
  const requests: string[] = [];
  globalThis.fetch = mock(async (url: any, init: any) => {
    requests.push(String(url));
    expect(init.headers.Authorization).toBe("Bearer sk-or-v1-test-secret");
    return Response.json({ data: { label: "test", is_free_tier: false } });
  }) as unknown as typeof fetch;
  expect((await ensureAuthenticated(undefined, { apiKey: "  sk-or-v1-test-secret  " })).status).toBe("logged_in");
  expect(requests[0]).toEndWith("/key");
  expect(hasConfiguredCredentials()).toBe(true);
  const stored = loadProviderAuth<StoredOpenRouterAuth>("openrouter");
  expect(stored?.tokens.accessToken).toBe("sk-or-v1-test-secret");
  expect(stored?.apiKeyLabel).not.toContain("test-secret");
});

test("rejects failed or malformed auth responses without saving the key", async () => {
  clearAuth();
  globalThis.fetch = mock(async () => new Response("secret-bearing upstream error", { status: 401 })) as unknown as typeof fetch;
  await expect(ensureAuthenticated(undefined, { apiKey: "invalid" })).rejects.toThrow("verification failed (401)");
  expect(hasConfiguredCredentials()).toBe(false);
  globalThis.fetch = mock(async () => Response.json({ data: [] })) as unknown as typeof fetch;
  expect(await verifyAuth("invalid")).toBe(false);
});

test("supports environment login and logout", async () => {
  clearAuth();
  process.env.OPENROUTER_API_KEY = "sk-or-v1-environment-test";
  globalThis.fetch = mock(async () => Response.json({ data: { label: "env" } })) as unknown as typeof fetch;
  expect((await ensureAuthenticated()).status).toBe("logged_in");
  expect(loadProviderAuth<StoredOpenRouterAuth>("openrouter")?.source).toBe("env");
  expect(clearAuth()).toBe(true);
  expect(hasConfiguredCredentials()).toBe(false);
});
