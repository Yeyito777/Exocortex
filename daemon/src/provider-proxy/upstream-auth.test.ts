import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalUpstreamAuth, readClaudeCodeOAuth, UpstreamAuthError } from "./upstream-auth";
import { resetProviderProxyRoutesForTest, setProviderProxyRoute } from "./route";
import { setClaudeAccountToken, setClaudeAccountsFileForTests } from "../providers/anthropic/accounts";
import { claudeTokenRejection, setClaudeTokenDepsForTests } from "../providers/anthropic/account-token";

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

  test("a request signed with an API-credit key has the SDK's entrypoint back in its User-Agent", async () => {
    const auth = createLocalUpstreamAuth({ apiCreditKey: async () => "credit-key" });
    const apiCredit = { id: "KEY", label: "main", renewsOnDay: null };
    const clientHeaders = { "anthropic-beta": "claude-code-20250219,oauth-2025-04-20", "user-agent": "claude-cli/2.1.303 (external, exocortex, agent-sdk/0.3.294, client-app/exocortex-daemon)" };
    expect(await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", { afterRejection: false, clientHeaders, apiCredit })).toEqual({
      "x-api-key": "credit-key",
      "anthropic-beta": "claude-code-20250219",
      "user-agent": "claude-cli/2.1.303 (external, sdk-ts, agent-sdk/0.3.294, client-app/exocortex-daemon)",
    });
    expect(await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", { afterRejection: false, clientHeaders: {}, apiCredit })).toEqual({ "x-api-key": "credit-key", "anthropic-beta": "" });
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

  test("another Claude account's request carries that account's own login, refreshed by Claude Code for that account", async () => {
    claudeDir("main-token", Date.now() + 3_600_000);
    const max2 = mkdtempSync(join(tmpdir(), "exocortex-claude-max2-"));
    dirs.push(max2);
    writeCredentials(max2, "max2-old", Date.now() + 60_000);
    const accountsFile = join(max2, "accounts.json");
    writeFileSync(accountsFile, JSON.stringify({ accounts: [{ id: "max2", configDir: max2 }] }));
    setClaudeAccountsFileForTests(accountsFile);
    try {
      const refreshed: Array<string | undefined> = [];
      let logins = 0;
      const auth = createLocalUpstreamAuth({
        anthropicLogin: async () => { logins++; return { loggedIn: false, error: "main is signed out" }; },
        refreshClaudeLogin: async (account) => {
          refreshed.push(account);
          writeCredentials(max2, "max2-new", Date.now() + 3_600_000);
        },
      });
      const headers = await auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {}, account: "max2" });
      expect(headers.authorization).toBe("Bearer max2-new");
      expect(refreshed).toEqual(["max2"]);
      // The pool routes only to signed-in accounts; main's own login check does not gate max2.
      expect(logins).toBe(0);
      expect(readClaudeCodeOAuth("max2")?.accessToken).toBe("max2-new");
      expect(readClaudeCodeOAuth("nope")).toBeNull();
    } finally {
      setClaudeAccountsFileForTests(null);
    }
  });

  test("an account with a long-lived token signs with it; a 401 sets it aside and its own login takes over", async () => {
    claudeDir("login-token", Date.now() + 3_600_000);
    let token: string | null = "setup-token";
    const rejected: string[] = [];
    let refreshed = 0;
    const auth = createLocalUpstreamAuth({
      anthropicLogin: signedIn,
      refreshClaudeLogin: async () => { refreshed++; },
      claudeToken: async () => token,
      rejectClaudeToken: (_account, detail) => {
        if (token === null) return false;
        rejected.push(detail);
        token = null;
        return true;
      },
    });
    const first = await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", { afterRejection: false, clientHeaders: { "anthropic-beta": "claude-code-20250219" } });
    expect(first).toEqual({ authorization: "Bearer setup-token", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20" });
    // Anthropic answered 401: the retry is signed with the login, which is not blamed for the token's refusal.
    const retry = await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", { afterRejection: true, clientHeaders: {} });
    expect(retry.authorization).toBe("Bearer login-token");
    expect(rejected).toEqual(["HTTP 401 from Anthropic"]);
    expect(refreshed).toBe(0);
    // A later 401 is the login's own: refreshed as before, and refused when that changes nothing.
    await expect(auth.headers("anthropic", "u", { afterRejection: true, clientHeaders: {} })).rejects.toBeInstanceOf(UpstreamAuthError);
    expect(refreshed).toBe(1);
  });

  test("the token comes from the secrets store by the name in the accounts registry", async () => {
    const dir = claudeDir("login-token", Date.now() + 3_600_000);
    setClaudeAccountsFileForTests(join(dir, "accounts.json"));
    setClaudeTokenDepsForTests({ secret: async name => name === "CLAUDE_SETUP_TOKEN_MAIN" ? "stored-token" : null });
    try {
      const auth = createLocalUpstreamAuth({ anthropicLogin: signedIn, refreshClaudeLogin: async () => {} });
      // No token recorded: the login, as always.
      expect((await auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} })).authorization).toBe("Bearer login-token");
      setClaudeAccountToken("main", { secret: "CLAUDE_SETUP_TOKEN_MAIN", mintedAt: "2026-11-13T00:00:00Z" });
      expect((await auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} })).authorization).toBe("Bearer stored-token");
      // Two requests the token signed both come back 401: neither blames the login.
      expect((await auth.headers("anthropic", "u", { afterRejection: true, clientHeaders: {} })).authorization).toBe("Bearer login-token");
      expect((await auth.headers("anthropic", "u", { afterRejection: true, clientHeaders: {} })).authorization).toBe("Bearer login-token");
      expect(claudeTokenRejection("main")?.detail).toBe("HTTP 401 from Anthropic");
      expect((await auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} })).authorization).toBe("Bearer login-token");
    } finally {
      setClaudeTokenDepsForTests(null);
      setClaudeAccountsFileForTests(null);
    }
  });

  test("a refused token with no login behind it cannot sign: the pool moves the request on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-claude-nologin-"));
    dirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
    let token: string | null = "setup-token";
    const auth = createLocalUpstreamAuth({
      anthropicLogin: signedIn,
      refreshClaudeLogin: async () => {},
      claudeToken: async () => token,
      rejectClaudeToken: () => { const had = token !== null; token = null; return had; },
    });
    expect((await auth.headers("anthropic", "u", { afterRejection: false, clientHeaders: {} })).authorization).toBe("Bearer setup-token");
    await expect(auth.headers("anthropic", "u", { afterRejection: true, clientHeaders: {} })).rejects.toBeInstanceOf(UpstreamAuthError);
  });

  test("a remote whose main is signed out still serves Claude while another account of its pool can", async () => {
    claudeDir("token", Date.now() + 3_600_000);
    const auth = createLocalUpstreamAuth({ anthropicLogin: async () => ({ loggedIn: false, error: "signed out" }), claudePoolAvailable: () => true });
    expect((await auth.status("anthropic")).loggedIn).toBe(true);
    const alone = createLocalUpstreamAuth({ anthropicLogin: async () => ({ loggedIn: false, error: "signed out" }), claudePoolAvailable: () => false });
    expect(await alone.status("anthropic")).toMatchObject({ loggedIn: false, error: "signed out" });
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
