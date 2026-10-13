import { describe, expect, test } from "bun:test";
import { AuthError, ContextWindowProviderError, NonRetryableProviderError, classifyNetworkFailure, classifyNetworkFailureMessage } from "./errors";

function coded(message: string, code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...extra });
}

describe("classifyNetworkFailure", () => {
  test("Claude Code's connection errors are network failures", () => {
    // The exact Oct 13 outage error, and Claude Code's other no-connection wordings.
    for (const message of [
      "Claude Code: API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)",
      "Claude Code: API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
      "Claude Code: API Error: No internet route — check your connection or VPN (ENETUNREACH)",
      "Claude Code: API Error: Unable to connect to API. Check your internet connection",
      "Claude Code: API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)",
    ]) {
      expect(classifyNetworkFailure(new Error(message))).toBe("network");
    }
  });

  test("socket-level errors by code, message and cause chain", () => {
    expect(classifyNetworkFailure(coded("getaddrinfo EAI_AGAIN api.anthropic.com", "EAI_AGAIN"))).toBe("network");
    // Bun fetch: DNS failure and refused connection.
    expect(classifyNetworkFailure(coded("getaddrinfo ENOTFOUND chatgpt.com", "ENOTFOUND"))).toBe("network");
    expect(classifyNetworkFailure(coded("Unable to connect. Is the computer able to access the url?", "ConnectionRefused"))).toBe("network");
    // undici: TypeError("fetch failed") with the socket error as its cause.
    const fetchFailed = new TypeError("fetch failed", { cause: coded("connect ECONNREFUSED 1.2.3.4:443", "ECONNREFUSED") });
    expect(classifyNetworkFailure(fetchFailed)).toBe("network");
    const wrapped = new Error("OpenAI websocket request failed", { cause: coded("getaddrinfo EAI_AGAIN chatgpt.com", "EAI_AGAIN") });
    expect(classifyNetworkFailure(wrapped)).toBe("network");
    expect(classifyNetworkFailure(new AggregateError([coded("connect ENETUNREACH", "ENETUNREACH")], "all attempts failed"))).toBe("network");
  });

  test("broken or timed-out connections are only possibly an outage", () => {
    expect(classifyNetworkFailure(coded("read ECONNRESET", "ECONNRESET"))).toBe("maybe_network");
    expect(classifyNetworkFailure(coded("connect ETIMEDOUT 1.2.3.4:443", "ETIMEDOUT"))).toBe("maybe_network");
    expect(classifyNetworkFailure(new Error("socket hang up"))).toBe("maybe_network");
    expect(classifyNetworkFailure(new Error("Claude Code: API Error: Connection dropped (ECONNRESET)"))).toBe("maybe_network");
    expect(classifyNetworkFailure(new Error("Claude Code: API Error: Request timed out. Check your internet connection and proxy settings"))).toBe("maybe_network");
    expect(classifyNetworkFailure(new Error("OpenAI websocket connect timeout"))).toBe("maybe_network");
  });

  test("API errors are never network failures", () => {
    for (const error of [
      new Error("Claude Code: API Error: 529 Overloaded"),
      new Error("Claude Code: API Error: 429 rate_limit_error: This request would exceed your rate limit"),
      new Error("OpenRouter API error (503): upstream unavailable"),
      new Error("HTTP 502: bad gateway"),
      new Error("Claude Code: API Error: Unable to connect to API: SSL certificate has expired"),
      new Error("Claude Code: API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL)"),
      new Error("Claude Code: invalid_request: prompt is too long"),
      Object.assign(new Error("Service unavailable"), { status: 503, cause: coded("read ECONNRESET", "ECONNRESET") }),
      new AuthError("authentication failed (401)"),
      new NonRetryableProviderError("bad request ECONNRESET"),
      new ContextWindowProviderError("context window exceeded"),
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
      new Error("Timed out (stale stream) after 8 retries"),
      null,
      undefined,
      "plain string",
    ]) {
      expect(classifyNetworkFailure(error)).toBeNull();
    }
  });

  test("provider retry reports are classified by message", () => {
    expect(classifyNetworkFailureMessage("fetch failed")).toBe("network");
    expect(classifyNetworkFailureMessage("getaddrinfo EAI_AGAIN chatgpt.com")).toBe("network");
    expect(classifyNetworkFailureMessage("HTTP 503: overloaded")).toBeNull();
    expect(classifyNetworkFailureMessage("Timed out (stale stream)")).toBeNull();
    expect(classifyNetworkFailureMessage("")).toBeNull();
  });
});
