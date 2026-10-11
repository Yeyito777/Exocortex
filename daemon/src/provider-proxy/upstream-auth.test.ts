import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUpstreamAuth, readClaudeCodeOAuth, UpstreamAuthError } from "./upstream-auth";
import { resetProviderProxyRoutesForTest, setProviderProxyRoute } from "./route";

const dirs: string[] = [];
const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
const originalOrigins = process.env.EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS;

function claudeDir(accessToken: string, expiresAt: number): string {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-claude-creds-"));
  dirs.push(dir);
  writeCredentials(dir, accessToken, expiresAt);
  process.env.CLAUDE_CONFIG_DIR = dir;
  return dir;
}

function writeCredentials(dir: string, accessToken: string, expiresAt: number): void {
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "r", expiresAt } }));
}

const signedIn = async () => ({ loggedIn: true, email: "remote@example.com", orgId: "org-1" });

afterEach(() => {
  if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
  if (originalOrigins === undefined) delete process.env.EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS;
  else process.env.EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS = originalOrigins;
  resetProviderProxyRoutesForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("remote credentials for /proxy", () => {
  test("Anthropic requests carry Claude Code's own token and the OAuth beta", async () => {
    claudeDir("claude-token", Date.now() + 3_600_000);
    expect(readClaudeCodeOAuth()?.accessToken).toBe("claude-token");
    let refreshed = 0;
    const auth = createLocalUpstreamAuth({ anthropicLogin: signedIn, refreshClaudeLogin: async () => { refreshed++; } });
    const headers = await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", { afterRejection: false, clientHeaders: { "anthropic-beta": "claude-code-20250219" } });
    expect(headers).toEqual({ authorization: "Bearer claude-token", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" });
    expect(refreshed).toBe(0);
  });

  test("an expiring token is refreshed by Claude Code before use, once for concurrent requests", async () => {
    const dir = claudeDir("old-token", Date.now() + 60_000);
    let refreshed = 0;
    const auth = createLocalUpstreamAuth({
      anthropicLogin: signedIn,
      refreshClaudeLogin: async () => {
        refreshed++;
        await Bun.sleep(10);
        writeCredentials(dir, "new-token", Date.now() + 3_600_000);
      },
    });
    const [a, b] = await Promise.all([
      auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} }),
      auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} }),
    ]);
    expect(a.authorization).toBe("Bearer new-token");
    expect(b.authorization).toBe("Bearer new-token");
    expect(refreshed).toBe(1);
  });

  test("a rejected token that refreshing does not change fails clearly instead of looping", async () => {
    claudeDir("same-token", Date.now() + 3_600_000);
    const auth = createLocalUpstreamAuth({ anthropicLogin: signedIn, refreshClaudeLogin: async () => {} });
    await expect(auth.headers("anthropic", "u", { afterRejection: true, clientHeaders: {} })).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test("a remote that is not signed in to Claude says so", async () => {
    claudeDir("token", Date.now() + 3_600_000);
    const auth = createLocalUpstreamAuth({ anthropicLogin: async () => ({ loggedIn: false, error: "Claude Code is not signed in. Run `claude auth login`." }) });
    await expect(auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} })).rejects.toThrow("Claude Code is not signed in.");
  });

  test("OpenAI requests carry this daemon's session, refreshed after a rejection", async () => {
    const calls: Array<{ forceRefresh?: boolean }> = [];
    const auth = createLocalUpstreamAuth({
      openaiSession: async (options) => {
        calls.push(options);
        return { accessToken: options.forceRefresh ? "fresh" : "cached", accountId: "acct-1" };
      },
    });
    expect(await auth.headers("openai", "https://chatgpt.com/backend-api/codex/responses", { afterRejection: false, clientHeaders: {} }))
      .toEqual({ authorization: "Bearer cached", "chatgpt-account-id": "acct-1" });
    expect((await auth.headers("openai", "https://chatgpt.com/backend-api/codex/responses", { afterRejection: true, clientHeaders: {} })).authorization).toBe("Bearer fresh");
    expect(calls).toEqual([{}, { forceRefresh: true }]);
  });

  test("a daemon that proxies a provider itself does not relay it", async () => {
    setProviderProxyRoute("openai", { provider: "openai", alias: "elsewhere", baseUrl: "http://127.0.0.1:1/openai", token: "t".repeat(32) });
    const auth = createLocalUpstreamAuth({ openaiSession: async () => ({ accessToken: "x", accountId: null }) });
    await expect(auth.headers("openai", "u", { afterRejection: false, clientHeaders: {} })).rejects.toThrow("sends openai through /proxy itself");
    expect(await auth.status("openai")).toMatchObject({ loggedIn: false, error: expect.stringContaining("through /proxy itself") });
  });

  test("upstream origins are the provider APIs; a mock origin is honored only in test processes", () => {
    process.env.EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS = JSON.stringify({ anthropic: "http://127.0.0.1:9/" });
    const auth = createLocalUpstreamAuth();
    expect(auth.origin("anthropic")).toBe("http://127.0.0.1:9");
    expect(auth.origin("openai")).toBe("https://chatgpt.com");
    const test = process.env.EXOCORTEX_TEST;
    delete process.env.EXOCORTEX_TEST;
    try {
      expect(auth.origin("anthropic")).toBe("https://api.anthropic.com");
    } finally {
      process.env.EXOCORTEX_TEST = test;
    }
  });
});
