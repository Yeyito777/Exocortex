import { describe, expect, test } from "bun:test";
import { matchProviderProxyRoute, providerProxyRequestHeaders, providerProxyResponseHeaders } from "./provider-proxy";

describe("provider proxy allowlist", () => {
  test("allows exactly the provider's model endpoints", () => {
    expect(matchProviderProxyRoute("anthropic", "http", "POST", "/v1/messages?beta=true")).toEqual({ path: "/v1/messages", search: "?beta=true" });
    expect(matchProviderProxyRoute("anthropic", "http", "post", "/v1/messages/count_tokens")).toEqual({ path: "/v1/messages/count_tokens", search: "" });
    expect(matchProviderProxyRoute("openai", "websocket", "GET", "/backend-api/codex/responses")).toEqual({ path: "/backend-api/codex/responses", search: "" });
    expect(matchProviderProxyRoute("openai", "http", "POST", "/backend-api/codex/responses")).toEqual({ path: "/backend-api/codex/responses", search: "" });
    expect(matchProviderProxyRoute("openai", "http", "GET", "/backend-api/codex/models?client_version=1")).toEqual({ path: "/backend-api/codex/models", search: "?client_version=1" });
  });

  test("refuses other paths, methods, kinds and providers' routes", () => {
    const refused = [
      matchProviderProxyRoute("anthropic", "http", "GET", "/v1/messages"),
      matchProviderProxyRoute("anthropic", "http", "POST", "/v1/models"),
      matchProviderProxyRoute("anthropic", "http", "POST", "/api/oauth/usage"),
      matchProviderProxyRoute("anthropic", "websocket", "GET", "/v1/messages"),
      matchProviderProxyRoute("anthropic", "http", "POST", "/backend-api/codex/responses"),
      matchProviderProxyRoute("openai", "http", "POST", "/backend-api/wham/rate-limit-reset-credits/consume"),
      matchProviderProxyRoute("openai", "http", "GET", "/backend-api/accounts"),
      matchProviderProxyRoute("openai", "http", "POST", "/v1/messages"),
    ];
    for (const result of refused) expect("error" in result).toBe(true);
  });

  test("refuses targets that could escape the exact path", () => {
    for (const target of [
      "/v1/messages/../models", "/v1/./messages", "/v1/messages%2f..", "//evil.example/v1/messages",
      "https://evil.example/v1/messages", "v1/messages", "/v1/messages#frag", "/v1\\messages", "/v1/messages?x=1 y",
    ]) {
      expect("error" in matchProviderProxyRoute("anthropic", "http", "POST", target)).toBe(true);
    }
  });

  test("request headers never carry credentials, cookies or transport framing", () => {
    const headers = providerProxyRequestHeaders(Object.entries({
      Authorization: "Bearer local-secret",
      "x-api-key": "sk-local",
      Cookie: "a=b",
      "ChatGPT-Account-ID": "local-account",
      Host: "127.0.0.1:1234",
      "Content-Length": "12",
      "Proxy-Authorization": "x",
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "User-Agent": "claude-cli/2",
      "x-bad": "a\r\nInjected: 1",
    }));
    expect(headers).toEqual({
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2",
    });
  });

  test("response headers never return cookies or auth challenges", () => {
    const headers = providerProxyResponseHeaders(new Headers([
      ["content-type", "text/event-stream"],
      ["set-cookie", "__cf_bm=1"],
      ["www-authenticate", "Bearer"],
      ["content-encoding", "gzip"],
      ["content-length", "10"],
      ["x-codex-primary-used-percent", "42"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.3"],
    ]).entries());
    expect(headers).toEqual({
      "content-type": "text/event-stream",
      "x-codex-primary-used-percent": "42",
      "anthropic-ratelimit-unified-5h-utilization": "0.3",
    });
  });
});
