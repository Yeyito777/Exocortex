import { afterEach, describe, expect, mock, test } from "bun:test";
import { loadProviderAuth } from "../../store";
import { clearAuth, ensureAuthenticated, hasConfiguredCredentials } from "./auth";
import type { StoredDeepSeekAuth } from "./types";

const originalFetch = globalThis.fetch;
const originalEnvKey = process.env.DEEPSEEK_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAuth();
  if (originalEnvKey == null) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalEnvKey;
});

describe("DeepSeek API-key auth", () => {
  test("instructs users to provide an API key when none is configured", async () => {
    delete process.env.DEEPSEEK_API_KEY;

    await expect(ensureAuthenticated()).rejects.toThrow("/login deepseek <api-key>");
  });

  test("verifies and stores an explicitly supplied API key", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      object: "list",
      data: [{ id: "deepseek-v4-pro" }],
    }), { status: 200 }))) as unknown as typeof fetch;

    const result = await ensureAuthenticated(undefined, { apiKey: "sk-test-deepseek" });

    expect(result.status).toBe("logged_in");
    expect(hasConfiguredCredentials()).toBe(true);
    const stored = loadProviderAuth<StoredDeepSeekAuth>("deepseek");
    expect(stored?.source).toBe("api_key");
    expect(stored?.tokens.accessToken).toBe("sk-test-deepseek");
    expect(stored?.apiKeyLabel).toContain("sk-test");
  });
});
