import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { secretsDir } from "@exocortex/shared/paths";
import { clearProviderAuth, loadProviderAuth, saveProviderAuth, setBorrowedCredentialsForTest } from "./store";
import { getVerifiedSession } from "./providers/openai/auth";

const CRED_FILE = join(secretsDir(), "credentials.json");
const originalFetch = globalThis.fetch;
afterEach(() => {
  setBorrowedCredentialsForTest(null);
  globalThis.fetch = originalFetch;
  clearProviderAuth("openrouter");
  clearProviderAuth("openai");
});

const key = (name: string) => ({ tokens: { accessToken: name, refreshToken: null, expiresAt: 4_102_444_800_000, scopes: [], subscriptionType: null, rateLimitTier: null }, profile: null, updatedAt: "2026-10-30T00:00:00.000Z" });

/** The owner's store as a test instance finds it; returns a check that it was never written. */
function ownerStore(providers: Record<string, unknown>): () => void {
  saveProviderAuth("openrouter", providers.openrouter);
  if (providers.openai) saveProviderAuth("openai", providers.openai);
  const bytes = readFileSync(CRED_FILE, "utf8");
  const mtime = statSync(CRED_FILE).mtimeMs;
  setBorrowedCredentialsForTest(true);
  return () => {
    expect(readFileSync(CRED_FILE, "utf8")).toBe(bytes);
    expect(statSync(CRED_FILE).mtimeMs).toBe(mtime);
  };
}

describe("a test instance borrowing the main credentials", () => {
  test("reads them, and keeps its own logins and logouts in memory, never in the store", () => {
    const untouched = ownerStore({ openrouter: key("owner-key") });
    expect(loadProviderAuth<{ tokens: { accessToken: string } }>("openrouter")?.tokens.accessToken).toBe("owner-key");
    // A login check that persists (the OpenRouter env key path) stays here.
    saveProviderAuth("openrouter", key("test-fake-key"));
    expect(loadProviderAuth<{ tokens: { accessToken: string } }>("openrouter")?.tokens.accessToken).toBe("test-fake-key");
    expect(clearProviderAuth("openrouter")).toBe(true);
    expect(loadProviderAuth("openrouter")).toBeNull();
    untouched();
    // The owner's store is untouched for a later instance too.
    setBorrowedCredentialsForTest(false);
    expect(loadProviderAuth<{ tokens: { accessToken: string } }>("openrouter")?.tokens.accessToken).toBe("owner-key");
  });

  test("follows the owner: a local change gives way once the owner changes that login", () => {
    ownerStore({ openrouter: key("owner-key") });
    saveProviderAuth("openrouter", key("local"));
    const file = JSON.parse(readFileSync(CRED_FILE, "utf8"));
    file.providers.openrouter = key("owner-rotated");
    writeFileSync(CRED_FILE, JSON.stringify(file));
    expect(loadProviderAuth<{ tokens: { accessToken: string } }>("openrouter")?.tokens.accessToken).toBe("owner-rotated");
  });

  test("never moves an unreadable owner's file aside", () => {
    ownerStore({ openrouter: key("owner-key") });
    writeFileSync(CRED_FILE, "{not json");
    expect(loadProviderAuth("openrouter")).toBeNull();
    expect(readFileSync(CRED_FILE, "utf8")).toBe("{not json");
    expect(readdirSync(secretsDir()).some(name => name.includes(".corrupt-"))).toBe(false);
    writeFileSync(CRED_FILE, JSON.stringify({ version: 2, providers: {} }));
  });

  test("never refreshes the owner's ChatGPT login (OpenAI rotates refresh tokens)", async () => {
    const expired = {
      tokens: { accessToken: "owner-access", refreshToken: "owner-refresh", expiresAt: Date.now() - 60_000, scopes: [], subscriptionType: "pro", rateLimitTier: null },
      profile: { accountUuid: "acct", email: "owner@example.com", displayName: null, organizationUuid: null, organizationName: null, organizationType: null, organizationRole: null, workspaceRole: null },
      updatedAt: "2026-10-30T00:00:00.000Z", source: "oauth", authMode: null, accountId: "acct", idToken: null,
    };
    const untouched = ownerStore({ openrouter: key("owner-key"), openai: expired });
    const calls: string[] = [];
    globalThis.fetch = mock((url: string | URL) => { calls.push(String(url)); return Promise.resolve(new Response("{}", { status: 200 })); }) as unknown as typeof fetch;
    await expect(getVerifiedSession({ chatgptOnly: true })).rejects.toThrow(/never refreshes/);
    expect(calls.filter(url => url.includes("token"))).toEqual([]);
    untouched();
  });
});

test("an instance with its own secrets keeps writing them", () => {
  setBorrowedCredentialsForTest(false);
  saveProviderAuth("openrouter", key("own"));
  expect(existsSync(CRED_FILE)).toBe(true);
  expect(JSON.parse(readFileSync(CRED_FILE, "utf8")).providers.openrouter.tokens.accessToken).toBe("own");
});
