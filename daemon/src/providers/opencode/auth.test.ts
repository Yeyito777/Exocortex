import { afterEach, describe, expect, mock, test } from "bun:test";
import { getAuthInfo } from "../../auth";
import { ensureAuthenticated, hasConfiguredCredentials, login, verifyAuth } from "./auth";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCode public auth", () => {
  test("is configured without a user API key", () => {
    expect(hasConfiguredCredentials()).toBe(true);
    expect(getAuthInfo("opencode")).toMatchObject({
      configured: true,
      authenticated: true,
      status: "logged_in",
      displayName: "Public preview",
      source: "public",
    });
  });

  test("checks public access through the models endpoint", async () => {
    let authorization = "";
    globalThis.fetch = mock((_input: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Promise.resolve(new Response(JSON.stringify({ object: "list", data: [{ id: "x-preview-f-free" }] }), { status: 200 }));
    }) as unknown as typeof fetch;

    expect(await ensureAuthenticated()).toEqual({ status: "already_authenticated", email: "Public preview" });
    expect((await login()).profile?.displayName).toBe("Public preview");
    expect(authorization).toBe("Bearer public");
    expect(await verifyAuth("public")).toBe(true);
  });

  test("reports when the limited-time model is withdrawn", async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }))) as unknown as typeof fetch;
    await expect(ensureAuthenticated()).rejects.toThrow("limited-time public preview may have ended");
  });
});
