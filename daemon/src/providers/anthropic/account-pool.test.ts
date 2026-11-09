import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "./accounts";
import { onClaudeAccountsChanged } from "./account-events";
import {
  beginAccountTurn,
  claudeAccountsInfo,
  fableFallbackNotice,
  flushAssignments,
  getCombinedUsage,
  refreshClaudeAccountStatuses,
  routeClaudeTurn,
  setAssignmentsFileForTests,
  touchConversationAccount,
} from "./account-pool";
import { cachedClaudeAuthStatus, claudeAuthProbeCount, setClaudeAuthProbeForTests } from "./auth-cache";
import { applyPlanRateLimits, applyUsageHeaders, CLAUDE_ACCOUNT_HEADER, CLAUDE_RATE_LIMIT_HEADER, clearUsage } from "./usage";
import type { ClaudeAuthStatus } from "./types";
import { DEV_ROUTING_ENV } from "./routing-dev-overrides";
import { claudeTurnModel } from "./api";
import { configureProviderProxyHooks, resetProviderProxyRoutesForTest, setProviderProxyRoute } from "../../provider-proxy/route";
import { noteAccountFableRefusal } from "./usage";
import type { ClaudeAccountInfo } from "@exocortex/shared/protocol";

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

  describe("with no 5-hour limit on main", () => {
    const seven_day = { utilization: 11, resets_at: new Date(Date.now() + 120 * H * 1000).toISOString() };

    test("the 5-hour bar counts only the account that still has it", async () => {
      addClaudeAccount("pool-b", join(dir, "b"));
      applyPlanRateLimits("main", { five_hour: null, seven_day });
      report("pool-b", 1, 4 * H, 28, 110 * H);
      await routeClaudeTurn("conv-1", null);
      const combined = getCombinedUsage();
      expect(combined).toMatchObject({ capacity: 200, fiveHourCapacity: 100, fiveHour: { utilization: 1 }, sevenDay: { utilization: 39 } });
      expect(combined?.fiveHour?.resets).toHaveLength(1);
      expect(claudeAccountsInfo().combined?.fiveHourCapacity).toBe(100);
    });

    test("an account not checked yet after a start stays counted, so the row doesn't flash not applicable", async () => {
      addClaudeAccount("pool-b", join(dir, "b"));
      applyPlanRateLimits("main", { five_hour: null, seven_day });
      await cachedClaudeAuthStatus("main");
      // pool-b has no usage yet either: unknown, not crossed out.
      expect(getCombinedUsage()).toMatchObject({ capacity: 200, fiveHourCapacity: 100, fiveHour: null });
      report("pool-b", 1, 4 * H, 28, 110 * H);
      expect(getCombinedUsage()).toMatchObject({ capacity: 200, fiveHourCapacity: 100, fiveHour: { utilization: 1 } });

      // The check says it is signed out: it no longer counts, and main alone has no 5-hour limit.
      signedIn["pool-b"] = false;
      await refreshClaudeAccountStatuses();
      const alone = getCombinedUsage();
      expect(alone).toMatchObject({ fiveHour: null, noFiveHourLimit: true });
      expect(alone?.capacity).toBeUndefined();
    });

    test("no account without the limit: an unchecked account adds nothing, as before", async () => {
      addClaudeAccount("pool-b", join(dir, "b"));
      report("main", 30, 2 * H, 40, 48 * H);
      report("pool-b", 1, 4 * H, 28, 110 * H);
      await cachedClaudeAuthStatus("main");
      expect(getCombinedUsage()?.capacity).toBeUndefined();
      expect(getCombinedUsage()?.fiveHour?.utilization).toBe(30);
    });

    test("it is the account routing picks when the other is at its 5-hour limit", async () => {
      addClaudeAccount("pool-b", join(dir, "b"));
      applyPlanRateLimits("main", { five_hour: null, seven_day });
      report("pool-b", 100, 4 * H, 28, 110 * H);
      expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "main" });
    });
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

describe("a Fable conversation when Fable allowance runs out", () => {
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";

  /** Plan usage with room, and the Fable allowance at `percent`, resetting in `resetIn` seconds. */
  function reportFable(account: string, weekly: number, percent: number, resetIn = 48 * H, extra: Record<string, unknown> = {}): void {
    const now = Math.floor(Date.now() / 1000);
    applyUsageHeaders(new Headers({
      [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.1, resetsAt: now + 2 * H },
          seven_day: { utilization: weekly / 100, resetsAt: now + resetIn },
          seven_day_overage_included: { utilization: percent / 100, resetsAt: now + resetIn },
        },
        ...extra,
      }),
      [CLAUDE_ACCOUNT_HEADER]: account,
    }));
  }

  /** The refusal Claude Code reports for a Fable request past the allowance, with extra usage off. */
  function refuseFable(account: string, resetIn = 48 * H): void {
    const now = Math.floor(Date.now() / 1000);
    reportFable(account, 40, 100, resetIn, {
      status: "rejected", rateLimitType: "seven_day_overage_included", resetsAt: now + resetIn,
      overageStatus: "rejected", overageDisabledReason: "out_of_credits", isUsingOverage: false,
    });
  }

  const turn = (convId: string | undefined, model: string, live: Parameters<typeof routeClaudeTurn>[1] = null) =>
    routeClaudeTurn(convId, live, undefined, null, convId, model);

  test("another account that still has allowance takes the turn; other models stay where they are", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    reportFable("main", 40, 30);
    reportFable("pool-b", 40, 30);
    touchConversationAccount("fable-conv", "main");
    touchConversationAccount("opus-conv", "main");
    expect(await turn("fable-conv", FABLE)).toMatchObject({ account: "main", reason: "cache-warm" });
    refuseFable("main");
    const moved = await turn("fable-conv", FABLE);
    expect(moved).toMatchObject({ account: "pool-b", movedFrom: "main", reason: "account-limited", detail: "\"main\" is out of Fable allowance", apiCredit: null });
    expect(moved.fableFallback).toBeUndefined();
    expect(claudeTurnModel(FABLE as never, moved)).toBe(FABLE);
    // The account is not at a usage limit: an Opus conversation keeps running on it.
    expect(await turn("opus-conv", OPUS)).toMatchObject({ account: "main", reason: "cache-warm" });
    expect(claudeAccountsInfo().accounts.find(account => account.id === "main")?.state).toBe("ready");
    // New Fable work goes to the account with allowance too.
    expect(await turn("fable-new", FABLE)).toMatchObject({ account: "pool-b", reason: "new" });
  });

  test("with no allowance left anywhere the turn runs on Opus where it would run anyway, says so once, and returns to Fable", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    reportFable("main", 40, 30);
    reportFable("pool-b", 40, 30);
    touchConversationAccount("fable-conv", "main");
    refuseFable("main", 50 * H);
    refuseFable("pool-b", 36 * H);
    const out = await turn("fable-conv", FABLE);
    // Its own account, cache and all: nothing moves, only the model.
    expect(out).toMatchObject({ account: "main", reason: "cache-warm", apiCredit: null });
    expect(out.movedFrom).toBeUndefined();
    expect(out.fableFallback?.reason).toBe("allowance");
    // The soonest any account has allowance again.
    expect(Math.abs(out.fableFallback!.resetAt! - (Date.now() + 36 * H * 1000))).toBeLessThan(5_000);
    expect(claudeTurnModel(FABLE as never, out)).toBe(OPUS);
    expect(fableFallbackNotice("fable-conv", out, FABLE, "Opus 5.5")).toBe(
      "Fable's allowance has run out on every Claude account: this conversation runs on Opus 5.5 until it resets, in 1.5 days.");
    // Later turns and a daemon restart say nothing more.
    expect(fableFallbackNotice("fable-conv", await turn("fable-conv", FABLE), FABLE, "Opus 5.5")).toBeNull();
    flushAssignments();
    setAssignmentsFileForTests(join(dir, "assignments.json"));
    expect(fableFallbackNotice("fable-conv", await turn("fable-conv", FABLE), FABLE, "Opus 5.5")).toBeNull();
    // Another model's conversation is untouched, and gets no notice.
    const opus = await turn("opus-conv", OPUS);
    expect(opus.fableFallback).toBeUndefined();
    expect(fableFallbackNotice("opus-conv", opus, OPUS, "Opus 5.5")).toBeNull();

    // pool-b's allowance resets: a full report shows it, and the conversation is back on Fable there.
    applyPlanRateLimits("pool-b", {
      seven_day: { utilization: 2, resets_at: new Date(Date.now() + 160 * H * 1000).toISOString() },
      limits: [{ kind: "weekly_scoped", percent: 0, resets_at: new Date(Date.now() + 160 * H * 1000).toISOString(), scope: { model: { display_name: "Fable" } } }],
    });
    const back = await turn("fable-conv", FABLE);
    expect(back).toMatchObject({ account: "pool-b", movedFrom: "main" });
    expect(back.fableFallback).toBeUndefined();
    expect(claudeTurnModel(FABLE as never, back)).toBe(FABLE);
    expect(fableFallbackNotice("fable-conv", back, FABLE, "Opus 5.5")).toBe("Back on Fable: its allowance is available again.");
    expect(fableFallbackNotice("fable-conv", back, FABLE, "Opus 5.5")).toBeNull();
  });

  test("an allowance that reads full is enough: no refusal has to happen first", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    reportFable("main", 40, 100);
    reportFable("pool-b", 40, 100);
    const out = await turn("fable-conv", FABLE);
    expect(out.fableFallback?.reason).toBe("allowance");
    // Past the reset the allowance starts over without any report.
    clearUsage("pool-b");
    reportFable("pool-b", 40, 100, -60);
    expect((await turn("fable-conv", FABLE)).fableFallback).toBeUndefined();
  });

  test("a process with background tasks does not pin a Fable turn to an account that cannot run it", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    reportFable("main", 40, 30);
    reportFable("pool-b", 40, 30);
    touchConversationAccount("fable-conv", "main");
    refuseFable("main");
    const live = { account: "main", open: true, backgroundWork: true };
    expect(await turn("fable-conv", FABLE, live)).toMatchObject({ account: "pool-b", movedFrom: "main" });
    refuseFable("pool-b");
    // Nowhere to run Fable: it stays with its tasks' account, on Opus.
    const out = await turn("fable-conv", FABLE, live);
    expect(out).toMatchObject({ account: "main", reason: "background-tasks" });
    expect(out.fableFallback?.reason).toBe("allowance");
  });

  test("an account at its plan limit is no place for Fable, and plan limits alone are not Fable's fallback", async () => {
    addClaudeAccount("pool-b", join(dir, "b"));
    reportFable("main", 40, 30);
    reportFable("pool-b", 40, 30);
    touchConversationAccount("fable-conv", "main");
    // pool-b has allowance but is at its weekly limit; main is out of Fable only: Opus on main.
    refuseFable("main");
    report("pool-b", 10, 2 * H, 100, 20 * H, { status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(Date.now() / 1000) + 20 * H });
    const out = await turn("fable-conv", FABLE);
    expect(out).toMatchObject({ account: "main" });
    expect(out.fableFallback?.reason).toBe("allowance");
    // Every account at a plan limit, Fable allowance or not: that is the usual wait, not a model switch.
    clearUsage("main");
    report("main", 10, 2 * H, 100, 20 * H, { status: "rejected", rateLimitType: "seven_day", resetsAt: Math.floor(Date.now() / 1000) + 20 * H });
    expect((await turn("fable-conv", FABLE)).fableFallback).toBeUndefined();
  });

  test("one account: out of Fable allowance it runs Opus, and helper requests follow without a notice", async () => {
    reportFable("main", 40, 30);
    expect((await turn("fable-conv", FABLE)).fableFallback).toBeUndefined();
    refuseFable("main", 5 * H);
    const out = await turn("fable-conv", FABLE);
    expect(out).toMatchObject({ account: "main", apiCredit: null });
    expect(out.fableFallback?.reason).toBe("allowance");
    expect(fableFallbackNotice("fable-conv", out, FABLE, "Opus 5.5")).toBe("Fable's allowance has run out: this conversation runs on Opus 5.5 until it resets, in 5 hours.");
    const helper = await turn(undefined, FABLE);
    expect(helper.fableFallback?.reason).toBe("allowance");
    expect(fableFallbackNotice(undefined, helper, FABLE, "Opus 5.5")).toBeNull();
    expect((await turn("opus-conv", OPUS)).fableFallback).toBeUndefined();
  });

  test("a conversation its user moved off Fable while on the fallback is not announced as back", async () => {
    refuseFable("main");
    expect(fableFallbackNotice("fable-conv", await turn("fable-conv", FABLE), FABLE, "Opus 5.5")).toStartWith("Fable's allowance has run out");
    expect(fableFallbackNotice("fable-conv", await turn("fable-conv", OPUS), OPUS, "Opus 5.5")).toBeNull();
    // Back on Fable later with the allowance still out: said again.
    expect(fableFallbackNotice("fable-conv", await turn("fable-conv", FABLE), FABLE, "Opus 5.5")).toStartWith("Fable's allowance has run out");
  });
});

describe("a proxied Fable conversation when the remote's Fable allowance runs out", () => {
  const FABLE = "claude-fable-5-2";
  const DAY = 86_400_000;
  let pool: ClaudeAccountInfo[] | null;

  /** A remote account as its daemon shares it: plan usage with room, the Fable allowance as given. */
  function remoteAccount(id: string, fable: NonNullable<ClaudeAccountInfo["usage"]>["fable"]): ClaudeAccountInfo {
    return {
      id, email: null, plan: "max", configDir: `~/.claude-${id}`, state: "ready", stateDetail: null, limitedUntil: null, blockedUntil: null,
      usage: { fiveHour: null, sevenDay: { utilization: 40, resetsAt: Date.now() + 3 * DAY }, ...(fable !== undefined ? { fable } : {}) },
      usageUpdatedAt: Date.now(), activeTurns: 0, conversations: [], loginCommand: null,
    } as ClaudeAccountInfo;
  }

  beforeEach(() => {
    pool = null;
    setProviderProxyRoute("anthropic", { provider: "anthropic", alias: "whale", baseUrl: "http://127.0.0.1:1/anthropic", token: "t" } as never);
    configureProviderProxyHooks({
      remoteAccounts: () => pool ? { pool: { accounts: pool, combined: null, routing: {}, nextNewWork: null }, remote: { alias: "whale", host: null, state: "connected" } } : null,
    } as never);
  });
  afterEach(() => resetProviderProxyRoutesForTest());

  const turn = (convId: string, model = FABLE) => routeClaudeTurn(convId, null, undefined, null, convId, model);

  test("it runs Opus while the remote's pool shows no account with Fable left, and Fable again once one has", async () => {
    pool = [remoteAccount("main", { utilization: 40, resetsAt: Date.now() + 3 * DAY }), remoteAccount("max2", { utilization: 20, resetsAt: Date.now() + 2 * DAY })];
    expect((await turn("conv-1")).fableFallback).toBeUndefined();
    // One out: the remote routes the request to the other.
    pool[0] = remoteAccount("main", { utilization: 100, resetsAt: Date.now() + 3 * DAY, limitedUntil: Date.now() + 3 * DAY });
    expect((await turn("conv-1")).fableFallback).toBeUndefined();
    pool[1] = remoteAccount("max2", { utilization: 100, resetsAt: Date.now() + 2 * DAY });
    const out = await turn("conv-1");
    expect(out).toMatchObject({ account: "main", apiCredit: null });
    expect(out.fableFallback?.reason).toBe("allowance");
    expect(Math.abs(out.fableFallback!.resetAt! - (Date.now() + 2 * DAY))).toBeLessThan(5_000);
    expect(fableFallbackNotice("conv-1", out, FABLE, "Opus 5.5")).toBe("Fable's allowance has run out on every Claude account: this conversation runs on Opus 5.5 until it resets, in 2 days.");
    expect((await turn("conv-1", "claude-opus-5-5")).fableFallback).toBeUndefined();
    pool[1] = remoteAccount("max2", { utilization: 0, resetsAt: Date.now() + 9 * DAY });
    const back = await turn("conv-1");
    expect(back.fableFallback).toBeUndefined();
    expect(fableFallbackNotice("conv-1", back, FABLE, "Opus 5.5")).toBe("Back on Fable: its allowance is available again.");
  });

  test("a Fable refusal that reached this machine holds Opus for a while even when the pool has not caught up or says nothing of Fable", async () => {
    // A remote from before the Fable allowance shares no reading of it: Fable is tried.
    pool = [remoteAccount("main", undefined), remoteAccount("max2", undefined)];
    expect((await turn("conv-1")).fableFallback).toBeUndefined();
    // The request came back refused (the remote had no other account for it): api.ts holds it here, capped.
    noteAccountFableRefusal("main", Date.now() + 3 * DAY, Date.now(), 15 * 60_000);
    expect((await turn("conv-1")).fableFallback).toMatchObject({ reason: "allowance" });
    // A pool that still shows allowance does not undo it: the refusal is newer.
    pool = [remoteAccount("main", { utilization: 40, resetsAt: Date.now() + 3 * DAY }), remoteAccount("max2", { utilization: 20, resetsAt: Date.now() + 2 * DAY })];
    expect((await turn("conv-1")).fableFallback?.reason).toBe("allowance");
    // Once the hold has passed a turn tries Fable again.
    clearUsage("main");
    noteAccountFableRefusal("main", null, Date.now() - 16 * 60_000, 15 * 60_000);
    expect((await turn("conv-1")).fableFallback).toBeUndefined();
  });

  test("while the remote's turns run on its API credits, a Fable conversation runs Opus", async () => {
    pool = [remoteAccount("main", { utilization: 40, resetsAt: Date.now() + 3 * DAY })];
    configureProviderProxyHooks({
      remoteAccounts: () => ({ pool: { accounts: pool!, combined: { fiveHour: null, sevenDay: null, apiCredits: { active: true, ready: true, label: "max2" } }, routing: {}, nextNewWork: null }, remote: { alias: "whale", host: null, state: "connected" } }),
    } as never);
    expect((await turn("conv-1")).fableFallback).toEqual({ reason: "api-credits", resetAt: null });
  });
});
