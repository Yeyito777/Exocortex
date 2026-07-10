import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { dataDir, runtimeDir } from "@exocortex/shared/paths";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import { clearUsage, handleUsageHeaders, OPENAI_USAGE_ACCOUNT_KEY_HEADER, refreshUsage } from "./usage";
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
  clearUsage();
  clearProviderAuth("openai");
  resetUsageStorage();
});

describe("OpenAI usage header parsing", () => {
  test("uses standard codex used-percent headers for the statusline windows", () => {
    resetUsageStorage();

    const headers = new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-secondary-used-percent": "40",
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
