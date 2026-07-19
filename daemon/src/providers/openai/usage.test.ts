import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { dataDir, runtimeDir } from "@exocortex/shared/paths";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import {
  clearUsage,
  consumeUsageResetForSessionForTest,
  handleUsageHeaders,
  mergeRemoteUsageForTest,
  OPENAI_USAGE_ACCOUNT_KEY_HEADER,
  refreshUsage,
  setOpenAIUsageFetchForTest,
} from "./usage";
import type { UsageData } from "../../messages";
import type { StoredOpenAIAuthPool } from "./auth";
import type { StoredOpenAIAuth } from "./session";

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

function savePool(currentIndex: number): void {
  const accounts = [
    makeAuth("one@example.com", "acct_one", "token-one"),
    makeAuth("two@example.com", "acct_two", "token-two"),
  ];
  saveProviderAuth("openai", {
    ...accounts[currentIndex],
    multiAccountVersion: 1,
    accounts,
    currentIndex,
  } satisfies StoredOpenAIAuthPool);
}

function resetUsageStorage(): void {
  rmSync(runtimeDir(), { recursive: true, force: true });
  rmSync(dataDir(), { recursive: true, force: true });
  mkdirSync(runtimeDir(), { recursive: true });
  mkdirSync(dataDir(), { recursive: true });
}

afterEach(() => {
  setOpenAIUsageFetchForTest(null);
  clearUsage();
  clearProviderAuth("openai");
  resetUsageStorage();
});

describe("OpenAI usage header parsing", () => {
  test("merges reset-credit details with remotely fetched rate-limit windows", () => {
    const now = 1_700_000_000_000;
    const usage = mergeRemoteUsageForTest(
      null,
      {
        rate_limit: {
          primary_window: {
            used_percent: 12.5,
            limit_window_seconds: 5 * 60 * 60,
            reset_at: 1_700_018_000,
          },
          secondary_window: {
            used_percent: 40,
            limit_window_seconds: 7 * 24 * 60 * 60,
            reset_after_seconds: 3600,
          },
        },
        rate_limit_reset_credits: { available_count: 4 },
      },
      {
        available_count: 3,
        credits: [
          { status: "redeemed", expires_at: "2026-07-01T00:00:00Z" },
          { status: "available", expires_at: "2026-07-20T00:00:00Z" },
          { status: "available", expires_at: "2026-07-18T00:00:00Z" },
          { status: "available", expires_at: null },
        ],
      },
      now,
    );

    expect(usage).toEqual({
      fiveHour: { utilization: 12.5, resetsAt: 1_700_018_000_000 },
      sevenDay: { utilization: 40, resetsAt: now + 3_600_000 },
      resetCredits: {
        availableCount: 3,
        nextExpiresAt: Date.parse("2026-07-18T00:00:00Z"),
      },
    });
  });

  test("uses the usage summary count when reset-credit details are unavailable", () => {
    const previous: UsageData = {
      fiveHour: null,
      sevenDay: null,
      resetCredits: { availableCount: 2, nextExpiresAt: 1_800_000_000_000 },
    };

    expect(mergeRemoteUsageForTest(
      previous,
      { rate_limit_reset_credits: { available_count: 2 } },
      null,
      1_700_000_000_000,
    ).resetCredits).toEqual(previous.resetCredits);

    expect(mergeRemoteUsageForTest(
      previous,
      { rate_limit_reset_credits: { available_count: 1 } },
      null,
      1_700_000_000_000,
    ).resetCredits).toEqual({ availableCount: 1, nextExpiresAt: null });
  });

  test("uses the Codex WHAM reset endpoints and redeem request contract", async () => {
    resetUsageStorage();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    setOpenAIUsageFetchForTest(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/rate-limit-reset-credits/consume")) {
        return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
      }
      if (url.endsWith("/rate-limit-reset-credits")) {
        return new Response(JSON.stringify({
          available_count: 1,
          credits: [{ status: "available", expires_at: "2026-07-20T00:00:00Z" }],
        }), { status: 200 });
      }
      if (url.endsWith("/wham/usage")) {
        return new Response(JSON.stringify({
          rate_limit_reset_credits: { available_count: 1 },
        }), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const result = await consumeUsageResetForSessionForTest({
      accessToken: "test-token",
      accountId: "account-123",
      accountKey: "account-123",
    }, "redeem-123");

    expect(result).toEqual({ outcome: "reset", windowsReset: 2, remainingResets: 1 });
    const consume = requests.find((request) => request.url.endsWith("/rate-limit-reset-credits/consume"));
    expect(consume?.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    expect(consume?.init?.method).toBe("POST");
    expect(JSON.parse(String(consume?.init?.body))).toEqual({ redeem_request_id: "redeem-123" });
    const headers = new Headers(consume?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("chatgpt-account-id")).toBe("account-123");
    expect(requests.map((request) => request.url)).toContain("https://chatgpt.com/backend-api/wham/usage");
    expect(requests.map((request) => request.url)).toContain("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
  });

  test("uses standard codex used-percent headers for the statusline windows", () => {
    resetUsageStorage();

    const headers = new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-secondary-used-percent": "40",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1704069000",
      "x-codex-secondary-reset-at": "1704074400",
    });

    let usage: UsageData | null = null;
    handleUsageHeaders(headers, (next) => {
      usage = next;
    });

    expect(usage).not.toBeNull();
    if (usage === null) throw new Error("expected usage update");
    const actual: UsageData = usage;

    expect(actual).toEqual({
      fiveHour: {
        utilization: 12.5,
        resetsAt: 1704069000 * 1000,
      },
      sevenDay: {
        utilization: 40,
        resetsAt: 1704074400 * 1000,
      },
    });
  });

  test("maps a lone seven-day primary window and clears the cached five-hour limit", () => {
    resetUsageStorage();

    handleUsageHeaders(new Headers({
      "x-codex-primary-used-percent": "12",
      "x-codex-secondary-used-percent": "34",
    }), () => {});

    let usage: UsageData | null = null;
    handleUsageHeaders(new Headers({
      "x-codex-primary-used-percent": "53",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1784499577",
    }), (next) => {
      usage = next;
    });

    expect(usage).not.toBeNull();
    if (usage === null) throw new Error("expected usage update");
    const actual: UsageData = usage;
    expect(actual).toEqual({
      fiveHour: null,
      sevenDay: {
        utilization: 53,
        resetsAt: 1784499577 * 1000,
      },
    });
  });

  test("reads the active non-default codex limit family and normalizes underscores to dashed header prefixes", () => {
    resetUsageStorage();

    const headers = new Headers({
      "x-codex-active-limit": "codex_other",
      "x-codex-other-primary-used-percent": "77",
      "x-codex-other-secondary-used-percent": "88",
      "x-codex-other-primary-reset-at": "1705000000",
      "x-codex-other-secondary-reset-at": "1706000000",
    });

    let usage: UsageData | null = null;
    handleUsageHeaders(headers, (next) => {
      usage = next;
    });

    expect(usage).not.toBeNull();
    if (usage === null) throw new Error("expected usage update");
    const actual: UsageData = usage;

    expect(actual).toEqual({
      fiveHour: {
        utilization: 77,
        resetsAt: 1705000000 * 1000,
      },
      sevenDay: {
        utilization: 88,
        resetsAt: 1706000000 * 1000,
      },
    });
  });

  test("refreshUsage immediately emits cached usage for the current account and null when unknown", () => {
    resetUsageStorage();
    savePool(0);

    handleUsageHeaders(new Headers({
      "x-codex-primary-used-percent": "12",
      "x-codex-secondary-used-percent": "34",
    }), () => {});

    let refreshed: UsageData | null | undefined;
    refreshUsage((usage) => {
      refreshed = usage;
    });
    expect(refreshed).toEqual({
      fiveHour: { utilization: 12, resetsAt: null },
      sevenDay: { utilization: 34, resetsAt: null },
    });

    savePool(1);
    refreshed = undefined;
    refreshUsage((usage) => {
      refreshed = usage;
    });
    expect(refreshed).toBeNull();
  });

  test("keeps provider-observed usage across a reset boundary until the provider sends a new value", () => {
    resetUsageStorage();
    savePool(0);

    const realDateNow = Date.now;
    const realSetTimeout = globalThis.setTimeout;
    const resetAt = 1_700_000_001_000;
    let now = resetAt - 1_000;
    let scheduledCallback: (() => void) | null = null;
    const updates: UsageData[] = [];
    const initialUsage: UsageData = {
      fiveHour: { utilization: 97, resetsAt: resetAt },
      sevenDay: { utilization: 27, resetsAt: resetAt + 7 * 24 * 60 * 60_000 },
    };

    try {
      Date.now = () => now;
      globalThis.setTimeout = ((callback: TimerHandler, _delay?: number, ...args: unknown[]) => {
        if (typeof callback === "function") scheduledCallback = () => callback(...args);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout;

      handleUsageHeaders(new Headers({
        "x-codex-primary-used-percent": "97",
        "x-codex-secondary-used-percent": "27",
        "x-codex-primary-reset-at": String(resetAt),
        "x-codex-secondary-reset-at": String(resetAt + 7 * 24 * 60 * 60_000),
      }), (usage) => {
        updates.push(usage);
      });

      now = resetAt + 5_000;
      (scheduledCallback as (() => void) | null)?.();

      let refreshed: UsageData | null | undefined;
      refreshUsage((usage) => {
        refreshed = usage;
      });
      expect(refreshed).toEqual(initialUsage);
      expect(updates).toEqual([initialUsage]);

      handleUsageHeaders(new Headers({
        "x-codex-primary-used-percent": "1",
        "x-codex-primary-reset-at": String(resetAt + 5 * 60 * 60_000),
      }), (usage) => {
        updates.push(usage);
      });

      expect(updates[1]?.fiveHour).toEqual({
        utilization: 1,
        resetsAt: resetAt + 5 * 60 * 60_000,
      });
    } finally {
      Date.now = realDateNow;
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test("usage headers for a non-current scoped account are cached without changing the displayed usage", () => {
    resetUsageStorage();
    savePool(1);

    const headers = new Headers({
      "x-codex-primary-used-percent": "12",
      "x-codex-secondary-used-percent": "34",
      [OPENAI_USAGE_ACCOUNT_KEY_HEADER]: "acct_one",
    });

    let displayed: UsageData | null | undefined;
    handleUsageHeaders(headers, (usage) => {
      displayed = usage;
    });
    expect(displayed).toBeUndefined();

    refreshUsage((usage) => {
      displayed = usage;
    });
    expect(displayed).toBeNull();

    savePool(0);
    refreshUsage((usage) => {
      displayed = usage;
    });
    expect(displayed).toEqual({
      fiveHour: { utilization: 12, resetsAt: null },
      sevenDay: { utilization: 34, resetsAt: null },
    });
  });
});
