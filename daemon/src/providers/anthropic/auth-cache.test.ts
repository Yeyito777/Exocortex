import { afterEach, describe, expect, test } from "bun:test";
import {
  AUTH_FAILURE_BLOCK_MS,
  cachedClaudeAuthStatus,
  claudeAccountBlock,
  claudeAuthProbeCount,
  invalidateClaudeAuthStatus,
  noteClaudeAccountAuthFailure,
  noteClaudeAccountWorking,
  setClaudeAuthProbeForTests,
  SIGNED_IN_STATUS_TTL_MS,
  SIGNED_OUT_STATUS_TTL_MS,
} from "./auth-cache";
import type { ClaudeAuthStatus } from "./types";

const SIGNED_IN: ClaudeAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "a@example.com" };
const SIGNED_OUT: ClaudeAuthStatus = { loggedIn: false };

function fakeProbe(statuses: Record<string, ClaudeAuthStatus>) {
  const calls: string[] = [];
  setClaudeAuthProbeForTests(async (account) => {
    calls.push(account);
    return statuses[account] ?? SIGNED_OUT;
  });
  return calls;
}

afterEach(() => setClaudeAuthProbeForTests(null));

describe("claude auth status cache", () => {
  test("checks a signed-in account once per TTL, not before every turn", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    let now = 1_000_000;
    const clock = () => now;
    for (let turn = 0; turn < 5; turn++) expect(await cachedClaudeAuthStatus("main", { now: clock })).toEqual(SIGNED_IN);
    expect(calls).toEqual(["main"]);
    now += SIGNED_IN_STATUS_TTL_MS - 1;
    await cachedClaudeAuthStatus("main", { now: clock });
    expect(calls).toHaveLength(1);
    now += 2;
    await cachedClaudeAuthStatus("main", { now: clock });
    expect(calls).toHaveLength(2);
  });

  test("a working turn counts as a fresh check", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    let now = 1_000_000;
    const clock = () => now;
    await cachedClaudeAuthStatus("main", { now: clock });
    for (let i = 0; i < 4; i++) {
      now += SIGNED_IN_STATUS_TTL_MS - 1000;
      noteClaudeAccountWorking("main", now);
      await cachedClaudeAuthStatus("main", { now: clock });
    }
    expect(calls).toEqual(["main"]);
  });

  test("signed-out accounts are checked again sooner; each account has its own entry", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    let now = 1_000_000;
    const clock = () => now;
    expect((await cachedClaudeAuthStatus("max2", { now: clock })).loggedIn).toBe(false);
    await cachedClaudeAuthStatus("main", { now: clock });
    now += SIGNED_OUT_STATUS_TTL_MS + 1;
    await cachedClaudeAuthStatus("max2", { now: clock });
    await cachedClaudeAuthStatus("main", { now: clock });
    expect(calls).toEqual(["max2", "main", "max2"]);
  });

  test("concurrent turns share one probe; maxAgeMs 0 forces a check", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    await Promise.all([cachedClaudeAuthStatus("main"), cachedClaudeAuthStatus("main"), cachedClaudeAuthStatus("main")]);
    expect(claudeAuthProbeCount()).toBe(1);
    await cachedClaudeAuthStatus("main", { maxAgeMs: 0 });
    expect(calls).toHaveLength(2);
  });

  test("an authentication failure blocks the account until a fresh signed-in check", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    await cachedClaudeAuthStatus("main");
    noteClaudeAccountAuthFailure("main", "401", 5_000);
    expect(claudeAccountBlock("main", 5_001)?.reason).toBe("401");
    expect(claudeAccountBlock("main", 5_000 + AUTH_FAILURE_BLOCK_MS)).toBeNull();
    // The cached status was dropped: the next use checks again, and a good check clears the block.
    await cachedClaudeAuthStatus("main");
    expect(calls).toHaveLength(2);
    expect(claudeAccountBlock("main", 5_001)).toBeNull();
  });

  test("invalidation forces the next check", async () => {
    const calls = fakeProbe({ main: SIGNED_IN });
    await cachedClaudeAuthStatus("main");
    invalidateClaudeAuthStatus("main");
    await cachedClaudeAuthStatus("main");
    expect(calls).toHaveLength(2);
  });
});
