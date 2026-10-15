import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "./accounts";
import { onClaudeAccountsChanged } from "./account-events";
import {
  beginAccountTurn,
  claudeAccountsInfo,
  getCombinedUsage,
  refreshClaudeAccountStatuses,
  routeClaudeTurn,
  setAssignmentsFileForTests,
  touchConversationAccount,
} from "./account-pool";
import { claudeAuthProbeCount, setClaudeAuthProbeForTests } from "./auth-cache";
import { applyUsageHeaders, CLAUDE_ACCOUNT_HEADER, CLAUDE_RATE_LIMIT_HEADER, clearUsage } from "./usage";
import type { ClaudeAuthStatus } from "./types";
import { DEV_ROUTING_ENV } from "./routing-dev-overrides";

const SIGNED_IN: ClaudeAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
const H = 3_600;

let dir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
let signedIn: Record<string, boolean>;

function report(account: string, fiveHour: number, fiveHourResetIn: number, weekly: number, weeklyResetIn: number, extra: Record<string, unknown> = {}): void {
  const now = Math.floor(Date.now() / 1000);
  const headers = new Headers({
    [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: fiveHour / 100, resetsAt: now + fiveHourResetIn },
        seven_day: { utilization: weekly / 100, resetsAt: now + weeklyResetIn },
      },
      ...extra,
    }),
    [CLAUDE_ACCOUNT_HEADER]: account,
  });
  applyUsageHeaders(headers);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-claude-pool-"));
  mkdirSync(join(dir, "main"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(dir, "main");
  setClaudeAccountsFileForTests(join(dir, "accounts.json"));
  setAssignmentsFileForTests(join(dir, "assignments.json"));
  signedIn = { main: true, "pool-b": true };
  setClaudeAuthProbeForTests(async account => signedIn[account] ? SIGNED_IN : { loggedIn: false });
  clearUsage("main");
  clearUsage("pool-b");
});

afterEach(() => {
  clearUsage("main");
  clearUsage("pool-b");
  setClaudeAuthProbeForTests(null);
  setAssignmentsFileForTests(null);
  setClaudeAccountsFileForTests(null);
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("account pool", () => {
  test("with one account every turn runs on main without checking anything", async () => {
    expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "main" });
    expect(claudeAuthProbeCount()).toBe(0);
  });

  test("a signed-out account takes no work and adds no capacity", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    signedIn["pool-b"] = false;
    report("main", 30, 2 * H, 40, 48 * H);
    report("pool-b", 0, 5 * H, 0, 24 * H);
    expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "main", reason: "new" });
    expect(getCombinedUsage()?.capacity).toBeUndefined();
    expect(getCombinedUsage()?.fiveHour?.utilization).toBe(30);
  });

  test("new work goes to the soonest weekly reset; the conversation then stays while warm", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    report("main", 10, 2 * H, 30, 120 * H);
    report("pool-b", 10, 2 * H, 30, 20 * H);
    await routeClaudeTurn("warmup", null);
    const first = await routeClaudeTurn("conv-1", null);
    expect(first).toMatchObject({ account: "pool-b", reason: "new" });
    touchConversationAccount("conv-1", first.account);
    // pool-b now looks worse for new work, but conv-1's cache is warm there.
    report("pool-b", 80, 2 * H, 92, 20 * H);
    expect(await routeClaudeTurn("conv-2", null)).toMatchObject({ account: "main" });
    expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "pool-b", reason: "cache-warm" });
  });

  test("dev routing overrides steer routing only, and only while the env var is set", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    report("main", 10, 2 * H, 30, 20 * H);
    report("pool-b", 10, 2 * H, 30, 120 * H);
    const file = join(dir, "dev-routing.json");
    writeFileSync(file, JSON.stringify({ policy: { cacheTtlMs: 1 }, accounts: { main: { usage: { sevenDay: { utilization: 95, resetsInMs: 20 * H * 1000 } } } } }));
    const saved = process.env[DEV_ROUTING_ENV];
    process.env[DEV_ROUTING_ENV] = file;
    try {
      expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "pool-b", reason: "new", detail: "\"main\" is below the weekly floor" });
      // The usage bars still show the real usage.
      expect(getCombinedUsage()?.sevenDay?.utilization).toBe(60);
      touchConversationAccount("conv-1", "main", Date.now() - 10);
      expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "pool-b", reason: "cold-move", movedFrom: "main" });
    } finally {
      if (saved === undefined) delete process.env[DEV_ROUTING_ENV];
      else process.env[DEV_ROUTING_ENV] = saved;
    }
    expect(await routeClaudeTurn("conv-2", null)).toMatchObject({ account: "main", reason: "new" });
  });

  test("a rejected request moves the conversation, with the old account named", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    report("main", 10, 2 * H, 30, 120 * H);
    report("pool-b", 10, 2 * H, 30, 20 * H);
    touchConversationAccount("conv-1", "pool-b");
    report("pool-b", 100, 2 * H, 50, 20 * H, { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + 2 * H });
    expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "main", movedFrom: "pool-b", reason: "account-limited" });
    // Background tasks still pin it.
    expect(await routeClaudeTurn("conv-1", { account: "pool-b", open: true, backgroundWork: true })).toMatchObject({ account: "pool-b" });
  });

  test("a conversation this daemon has no record of stays with the account that wrote its session", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    report("main", 10, 2 * H, 30, 100 * H);
    report("pool-b", 10, 2 * H, 30, 97 * H);
    expect(await routeClaudeTurn("legacy", null, undefined, "main")).toMatchObject({ account: "main", reason: "sticky" });
  });

  test("the bars combine both accounts on a 0-200% scale with both reset times", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    report("main", 30, 3 * H, 50, 120 * H);
    report("pool-b", 80, 1 * H, 20, 72 * H);
    await routeClaudeTurn("conv-1", null);
    const combined = getCombinedUsage();
    expect(combined?.capacity).toBe(200);
    expect(combined?.fiveHour?.utilization).toBe(110);
    expect(combined?.sevenDay?.utilization).toBe(70);
    expect(combined?.fiveHour?.resets).toHaveLength(2);
    expect(combined!.fiveHour!.resets![0]).toBeLessThan(combined!.fiveHour!.resets![1]);
  });
});

describe("Accounts screen data", () => {
  test("each account's state, own usage, running turns and warm conversations", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    signedIn["pool-b"] = false;
    await refreshClaudeAccountStatuses({ force: true });
    report("main", 30, 2 * H, 40, 48 * H);
    const now = Date.now();
    touchConversationAccount("warm-conv", "main", now - 10 * 60_000);
    touchConversationAccount("cold-conv", "main", now - 2 * 60 * 60_000);
    touchConversationAccount("running-conv", "main", now - 90 * 60_000);
    const endTurn = beginAccountTurn("main", "running-conv");

    const info = claudeAccountsInfo("cold-conv", now);
    expect(info.proxied).toBe(false);
    expect(info.accounts.map(account => account.id)).toEqual(["main", "pool-b"]);
    const [main, b] = info.accounts;
    expect(main).toMatchObject({ state: "ready", activeTurns: 1, loginCommand: null });
    expect(main.usage?.fiveHour?.utilization).toBe(30);
    // Running first, then the warm one; the cold one is not "on" the account any more.
    expect(main.conversations.map(conv => [conv.convId, conv.running, conv.warm])).toEqual([
      ["running-conv", true, false],
      ["warm-conv", false, true],
    ]);
    expect(b).toMatchObject({ state: "signed_out", activeTurns: 0, conversations: [] });
    expect(b.loginCommand).toContain("command claude auth login --claudeai");
    expect(b.loginCommand).toContain("CLAUDE_CONFIG_DIR=");
    expect(info.currentConversation).toEqual({ convId: "cold-conv", account: "main", lastUsedAt: now - 2 * 60 * 60_000, warm: false });
    expect(info.nextNewWork?.account).toBe("main");
    expect(info.routing.cacheTtlMs).toBe(60 * 60_000);
    // One usable account: the bars are main's own numbers.
    expect(info.combined?.fiveHour?.utilization).toBe(30);

    endTurn();
    expect(claudeAccountsInfo(null).accounts[0].activeTurns).toBe(0);
    expect(claudeAccountsInfo(null).currentConversation).toBeUndefined();
  });

  test("limits and turns tell the watchers", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    await refreshClaudeAccountStatuses({ force: true });
    let changes = 0;
    const stop = onClaudeAccountsChanged(() => { changes += 1; });
    try {
      report("pool-b", 100, H, 50, 24 * H, { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + H });
      expect(changes).toBeGreaterThan(0);
      const info = claudeAccountsInfo(null);
      expect(info.accounts[1].state).toBe("limited");
      expect(info.accounts[1].limitedUntil).toBeGreaterThan(Date.now());
      expect(info.combined?.capacity).toBe(200);
      const before = changes;
      beginAccountTurn("main")();
      expect(changes).toBe(before + 2);
    } finally {
      stop();
    }
  });
});
