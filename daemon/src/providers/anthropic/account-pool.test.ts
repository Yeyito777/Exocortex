import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "./accounts";
import { getCombinedUsage, routeClaudeTurn, setAssignmentsFileForTests, touchConversationAccount } from "./account-pool";
import { claudeAuthProbeCount, setClaudeAuthProbeForTests } from "./auth-cache";
import { applyUsageHeaders, CLAUDE_ACCOUNT_HEADER, CLAUDE_RATE_LIMIT_HEADER, clearUsage } from "./usage";
import type { ClaudeAuthStatus } from "./types";

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
