import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import { isUsageLimitError } from "../../usage-limit-wait";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "./accounts";
import { apiCreditSwitchNotice, getCombinedUsage, refreshClaudeAccountStatuses, routeClaudeTurn, setAssignmentsFileForTests } from "./account-pool";
import {
  API_CREDIT_ACCOUNT_KEY_PREFIX,
  ApiCreditExhaustedError,
  ApiCreditStreamTap,
  ApiCreditUsageMeter,
  apiCreditCycleSpendUsd,
  apiCreditAccountCredits,
  apiCreditBalance,
  apiCreditConfig,
  apiCreditKeyValue,
  apiCreditResetAt,
  classifyApiCreditError,
  cycleStartDay,
  estimateClaudeRequestCostUsd,
  markApiCreditSpent,
  nextRenewal,
  noteApiCreditFailure,
  refreshApiCreditSecrets,
  setApiCreditSecretsForTests,
  usableApiCreditKey,
  type ApiCreditKey,
  type ApiCreditSecrets,
} from "./api-credits";
import { claudeUsageAvailability } from "./availability";
import { setClaudeAuthProbeForTests } from "./auth-cache";
import { claudeProcessOptions } from "./cli";
import { createClaudeStreamState, pushClaudeMessage } from "./stream";
import type { ClaudeAuthStatus } from "./types";
import { applyUsageHeaders, CLAUDE_ACCOUNT_HEADER, CLAUDE_RATE_LIMIT_HEADER, clearUsage } from "./usage";
import { apiKeyUsage, recordApiKeyUsage } from "../openai/api-key-usage";
import { createLocalUpstreamAuth } from "../../provider-proxy/upstream-auth";
import { createProxiedClaudeRouter } from "../../provider-proxy/claude-routing";

const SIGNED_IN: ClaudeAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
const KEY_VALUE = "sk-ant-api03-THIS-IS-THE-SECRET-VALUE-0123456789";
const MAIN_KEY = "ANTHROPIC_API_KEY_MAIN_CREDITS";
const MAX2_KEY = "ANTHROPIC_API_KEY_MAX2_CREDITS";
const H = 3_600;

let dir: string;
let storeNames: string[];
let signedIn: Record<string, boolean>;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

const fakeSecrets: ApiCreditSecrets = {
  names: async () => storeNames,
  value: async name => storeNames.includes(name) ? `${KEY_VALUE}-${name}` : null,
  helperCommand: name => `/opt/secrets run --allow ${name} --clean-env -- printenv ${name}`,
};

function configure(enabled = true, keys: Array<{ secret: string; label?: string; renewsOnDay?: number }> = [
  { secret: MAIN_KEY, label: "main", renewsOnDay: 11 },
  { secret: MAX2_KEY, label: "max2", renewsOnDay: 18 },
]): void {
  writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { enabled, keys } } } });
}

/** Report an account's usage windows as Claude Code's rate_limit_event would. */
function report(account: string, fiveHour: number, weekly: number): void {
  const now = Math.floor(Date.now() / 1000);
  applyUsageHeaders(new Headers({
    [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
      status: fiveHour >= 100 || weekly >= 100 ? "rejected" : "allowed",
      unifiedWindows: {
        five_hour: { utilization: fiveHour / 100, resetsAt: now + 2 * H },
        seven_day: { utilization: weekly / 100, resetsAt: now + 48 * H },
      },
    }),
    [CLAUDE_ACCOUNT_HEADER]: account,
  }));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "exo-api-credits-"));
  mkdirSync(join(dir, "main"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(dir, "main");
  setClaudeAccountsFileForTests(join(dir, "accounts.json"));
  setAssignmentsFileForTests(join(dir, "assignments.json"));
  signedIn = { main: true, max2: true };
  setClaudeAuthProbeForTests(async account => signedIn[account] ? SIGNED_IN : { loggedIn: false });
  storeNames = [MAIN_KEY, MAX2_KEY, "OTHER_SECRET"];
  setApiCreditSecretsForTests(fakeSecrets, join(dir, "credit-state.json"));
  clearUsage("main");
  clearUsage("max2");
  configure();
  await refreshApiCreditSecrets({ force: true });
  await refreshClaudeAccountStatuses({ force: true });
});

afterEach(() => {
  clearUsage("main");
  clearUsage("max2");
  writeExocortexConfig({});
  setApiCreditSecretsForTests(null);
  setClaudeAuthProbeForTests(null);
  setAssignmentsFileForTests(null);
  setClaudeAccountsFileForTests(null);
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("API-credit fallback routing", () => {
  test("only when every subscription account is at a limit", async () => {
    addClaudeAccount("max2", join(dir, "max2"));
    report("main", 100, 60);
    report("max2", 30, 40);
    expect(await routeClaudeTurn("conv-1", null)).toMatchObject({ account: "max2", apiCredit: null });
    report("max2", 50, 100);
    const route = await routeClaudeTurn("conv-1", null);
    expect(route.apiCredit).toMatchObject({ id: MAIN_KEY, label: "main" });
    // Helper requests (titles, summaries) fall back too.
    expect((await routeClaudeTurn(undefined, null)).apiCredit?.id).toBe(MAIN_KEY);
  });

  test("a single account at its limit falls back; under it, it does not", async () => {
    report("main", 40, 50);
    expect((await routeClaudeTurn("conv-1", null)).apiCredit).toBeNull();
    report("main", 100, 50);
    expect((await routeClaudeTurn("conv-1", null)).apiCredit?.id).toBe(MAIN_KEY);
  });

  test("not when it is off, and not to hide a sign-in problem", async () => {
    addClaudeAccount("max2", join(dir, "max2"));
    report("main", 100, 60);
    report("max2", 100, 60);
    configure(false);
    expect((await routeClaudeTurn("conv-1", null)).apiCredit).toBeNull();
    configure(true);
    signedIn.main = false;
    signedIn.max2 = false;
    await refreshClaudeAccountStatuses({ force: true });
    expect((await routeClaudeTurn("conv-1", null)).apiCredit).toBeNull();
    // One signed out, the other limited: that is a limit.
    signedIn.max2 = true;
    await refreshClaudeAccountStatuses({ force: true });
    expect((await routeClaudeTurn("conv-1", null)).apiCredit?.id).toBe(MAIN_KEY);
  });

  test("goes back to the subscription once an account recovers, with a notice each way", async () => {
    report("main", 100, 60);
    const onCredits = await routeClaudeTurn("conv-1", null);
    expect(onCredits.apiCredit?.id).toBe(MAIN_KEY);
    expect(apiCreditSwitchNotice("conv-1", onCredits)).toContain(`Running on Claude API credits ("main")`);
    expect(apiCreditSwitchNotice("conv-1", onCredits)).toBeNull();
    report("main", 10, 60);
    const back = await routeClaudeTurn("conv-1", null);
    expect(back.apiCredit).toBeNull();
    expect(apiCreditSwitchNotice("conv-1", back)).toContain("Back on the Claude subscription");
    // A conversation never on credits gets no notice.
    expect(apiCreditSwitchNotice("conv-2", back)).toBeNull();
  });

  test("a process with background tasks keeps how it bills", async () => {
    report("main", 100, 60);
    const live = { account: "main", open: true, backgroundWork: true, apiCredit: null };
    expect((await routeClaudeTurn("conv-1", live)).apiCredit).toBeNull();
  });

  test("availability waits only once no key is left", async () => {
    report("main", 100, 60);
    // Before the first look at the secrets store, the turn may try: its routing checks.
    setApiCreditSecretsForTests(fakeSecrets, join(dir, "credit-state.json"));
    expect(claudeUsageAvailability().ready).toBe(true);
    await refreshApiCreditSecrets({ force: true });
    storeNames = [];
    await refreshApiCreditSecrets({ force: true });
    expect(claudeUsageAvailability().ready).toBe(false);
    storeNames = [MAIN_KEY, MAX2_KEY];
    await refreshApiCreditSecrets({ force: true });
    expect(claudeUsageAvailability().ready).toBe(true);
    markApiCreditSpent({ id: MAIN_KEY, label: "main", renewsOnDay: 11 }, "credit balance is too low");
    expect(claudeUsageAvailability().ready).toBe(true);
    markApiCreditSpent({ id: MAX2_KEY, label: "max2", renewsOnDay: 18 }, "credit balance is too low");
    expect(claudeUsageAvailability().ready).toBe(false);
    expect((await routeClaudeTurn("conv-1", null)).apiCredit).toBeNull();
  });
});

describe("API-credit keys", () => {
  test("in config order, skipping keys missing from the secrets store", async () => {
    expect(usableApiCreditKey()?.id).toBe(MAIN_KEY);
    storeNames = [MAX2_KEY];
    await refreshApiCreditSecrets({ force: true });
    expect(usableApiCreditKey()?.id).toBe(MAX2_KEY);
    storeNames = [];
    await refreshApiCreditSecrets({ force: true });
    expect(usableApiCreditKey()).toBeNull();
    configure(true, [{ secret: MAX2_KEY }, { secret: MAIN_KEY }]);
    storeNames = [MAIN_KEY, MAX2_KEY];
    await refreshApiCreditSecrets({ force: true });
    expect(usableApiCreditKey()).toMatchObject({ id: MAX2_KEY, label: MAX2_KEY });
  });

  test("rotate when one runs out, is rejected or is rate-limited", () => {
    const main = usableApiCreditKey()!;
    expect(noteApiCreditFailure(main, new ApiCreditExhaustedError("Claude Code: Credit balance is too low"))).toBe("spent");
    expect(usableApiCreditKey()?.id).toBe(MAX2_KEY);
    const max2 = usableApiCreditKey()!;
    const now = Date.now();
    expect(noteApiCreditFailure(max2, new Error("Claude Code: API Error: 429 rate_limit_error"), now)).toBe("throttled");
    expect(usableApiCreditKey(now)).toBeNull();
    expect(apiCreditResetAt(now)).toBe(now + 60_000);
    expect(usableApiCreditKey(now + 61_000)?.id).toBe(MAX2_KEY);
    expect(classifyApiCreditError(new Error("Invalid API key · Please run /login"))).toBe("rejected");
    expect(classifyApiCreditError(new Error("Claude Code: something else broke"))).toBeNull();
  });

  test("a spent key waits for its renewal day, and stays spent across restarts", () => {
    const at = new Date(2026, 9, 29, 15, 0).getTime();
    expect(nextRenewal(18, at)).toBe(new Date(2026, 10, 18).getTime());
    expect(nextRenewal(31, new Date(2026, 10, 2).getTime())).toBe(new Date(2026, 10, 30).getTime());
    expect(cycleStartDay(18, at)).toBe("2026-10-18");
    expect(cycleStartDay(18, new Date(2026, 10, 3).getTime())).toBe("2026-10-18");
    expect(cycleStartDay(null, at)).toBe("2026-10-01");
    const max2: ApiCreditKey = { id: MAX2_KEY, label: "max2", renewsOnDay: 18 };
    markApiCreditSpent(max2, "credit balance is too low", at);
    setApiCreditSecretsForTests(fakeSecrets, join(dir, "credit-state.json"));
    storeNames = [MAX2_KEY];
    return refreshApiCreditSecrets({ force: true }).then(() => {
      expect(usableApiCreditKey(at + 1000)).toBeNull();
      expect(usableApiCreditKey(new Date(2026, 10, 18, 0, 1).getTime())?.id).toBe(MAX2_KEY);
      // Spent again on the renewal day itself: the grant may land later that day.
      const renewalDay = new Date(2026, 10, 18, 1, 0).getTime();
      markApiCreditSpent(max2, "credit balance is too low", renewalDay);
      expect(usableApiCreditKey(renewalDay + 3 * H * 1000 + 1)?.id).toBe(MAX2_KEY);
    });
  });

  test("an out-of-credits result ends a credit turn as a usage-limit wait", () => {
    const state = createClaudeStreamState({ onText() {}, onThinking() {} }, dir, null);
    state.apiCredit = true;
    let thrown: unknown;
    try {
      pushClaudeMessage(state, { type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiCreditExhaustedError);
    expect(isUsageLimitError(thrown)).toBe(true);
    // On the subscription the same words are an ordinary error.
    const subscription = createClaudeStreamState({ onText() {}, onThinking() {} }, dir, null);
    expect(() => pushClaudeMessage(subscription, { type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" }))
      .toThrow(/Credit balance/);
  });
});

describe("API-credit key handling never exposes the key", () => {
  test("Claude Code reads it through an apiKeyHelper command, not the environment", () => {
    const key = usableApiCreditKey()!;
    const options = claudeProcessOptions(dir, "main", "conv-1", key);
    expect(options.settings).toEqual({ apiKeyHelper: fakeSecrets.helperCommand(MAIN_KEY)! });
    const serialized = JSON.stringify(options);
    expect(serialized).not.toContain(KEY_VALUE);
    expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeProcessOptions(dir, "main", "conv-1").settings).toBeUndefined();
  });

  test("state, usage and logs carry the key's name only", async () => {
    const key = usableApiCreditKey()!;
    expect(await apiCreditKeyValue(key)).toBe(`${KEY_VALUE}-${MAIN_KEY}`);
    noteApiCreditFailure(key, new ApiCreditExhaustedError("Claude Code: Credit balance is too low"));
    report("main", 100, 60);
    const marker = `api-credits-test-${Math.random()}`;
    log("warn", marker);
    const logFile = join(runtimeDir(), "exocortex.log");
    for (let i = 0; i < 200 && !(existsSync(logFile) && readFileSync(logFile, "utf-8").includes(marker)); i++) await Bun.sleep(10);
    const logged = readFileSync(logFile, "utf-8");
    expect(logged).toContain(`API-credit key "main" is out of credits`);
    expect(logged).not.toContain(KEY_VALUE);
    expect(readFileSync(join(dir, "credit-state.json"), "utf-8")).not.toContain(KEY_VALUE);
    expect(JSON.stringify(getCombinedUsage())).not.toContain(KEY_VALUE);
  });

  test("a /proxy request is signed with the key, without the OAuth beta", async () => {
    const auth = createLocalUpstreamAuth({ apiCreditKey: async (key) => `${KEY_VALUE}-${key.id}` });
    const headers = await auth.headers("anthropic", "https://api.anthropic.com/v1/messages", {
      afterRejection: false,
      clientHeaders: { "anthropic-beta": "oauth-2025-04-20,claude-code-20250219" },
      apiCredit: usableApiCreditKey(),
    });
    expect(headers).toEqual({ "x-api-key": `${KEY_VALUE}-${MAIN_KEY}`, "anthropic-beta": "claude-code-20250219" });
  });
});

describe("API-credit spend", () => {
  test("priced at the Claude API list rates, 5-minute and 1-hour cache writes apart", () => {
    // Opus 5.5: $4 in, $20 out, $5 / $8 cache writes, $0.20 cache hits per million.
    expect(estimateClaudeRequestCostUsd("claude-opus-5-5", {
      inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000, outputTokens: 1_000_000,
    })).toBeCloseTo(4 + 0.2 + 5 + 8 + 20, 6);
    // Haiku 5.5 as Claude Code priced a real request.
    expect(estimateClaudeRequestCostUsd("claude-haiku-5-5", {
      inputTokens: 2, cacheReadTokens: 11_352, cacheWrite5mTokens: 5_987, cacheWrite1hTokens: 0, outputTokens: 4,
    })).toBeCloseTo(0.000864095, 9);
    expect(estimateClaudeRequestCostUsd("claude-unknown-9", { inputTokens: 1, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1 })).toBeNull();
  });

  test("counted per request from stream events and from /proxy streams, into this cycle's spend", () => {
    const key = usableApiCreditKey()!;
    const meter = new ApiCreditUsageMeter(key);
    meter.observe({ type: "message_start", message: { model: "claude-opus-5-5", usage: {
      input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 2_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 1_000 }, output_tokens: 1,
    } } });
    meter.observe({ type: "message_delta", usage: { input_tokens: 1_000, cache_creation_input_tokens: 2_000, output_tokens: 500 } });
    const expected = (1_000 * 4 + 1_000 * 5 + 1_000 * 8 + 500 * 20) / 1_000_000;
    expect(apiCreditCycleSpendUsd(key)).toBeCloseTo(expected, 9);

    const tap = new ApiCreditStreamTap(new ApiCreditUsageMeter(key), "text/event-stream; charset=utf-8");
    const sse = `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":10,"output_tokens":1}}}\n\n`
      + `event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20}}\n\n`;
    const bytes = new TextEncoder().encode(sse);
    tap.push(bytes.slice(0, 37));
    tap.push(bytes.slice(37));
    tap.end();
    expect(apiCreditCycleSpendUsd(key)).toBeCloseTo(expected + (10 * 0.1 + 20 * 0.5) / 1_000_000, 9);
    expect(apiKeyUsage(API_CREDIT_ACCOUNT_KEY_PREFIX + key.id, "main").today.requests).toBe(2);
  });

  test("the usage block data says when turns run on credits", async () => {
    report("main", 30, 40);
    expect(getCombinedUsage()?.apiCredits).toMatchObject({ active: false, ready: true, label: "main" });
    report("main", 100, 40);
    expect(getCombinedUsage()?.apiCredits).toMatchObject({ active: true, ready: true, label: "main" });
    configure(false);
    expect(getCombinedUsage()?.apiCredits).toBeUndefined();
  });
});

describe("API credits over /proxy", () => {
  const routeAllLimited = async () => ({ account: "main", reason: "new" as const, detail: "test", apiCredit: usableApiCreditKey() });

  test("a Messages request is leased to the key; an out-of-credits answer sets it aside", async () => {
    const router = createProxiedClaudeRouter({ route: routeAllLimited });
    const lease = await router.lease("proxy:mac/conv-1", undefined, { apiCredits: true });
    expect(lease.apiCredit?.id).toBe(MAIN_KEY);
    expect(lease.observe(200, new Headers())).toBe(false);
    expect(lease.observe(400, new Headers(), `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`)).toBe(true);
    lease.release();
    const next = await router.lease("proxy:mac/conv-1", undefined, { apiCredits: true });
    expect(next.apiCredit?.id).toBe(MAX2_KEY);
    expect(next.observe(429, new Headers())).toBe(true);
    next.release();
    // Claude Code's account endpoints keep the subscription login.
    const other = await router.lease("proxy:mac/conv-1", undefined, { apiCredits: false });
    expect(other.apiCredit).toBeNull();
    other.release();
  });
});

describe("API-credit balances for the Accounts screen", () => {
  const spend = (id: string, usd: number, day: Date) => recordApiKeyUsage(API_CREDIT_ACCOUNT_KEY_PREFIX + id, {
    model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, timestamp: day.getTime(), estimatedCostUsd: usd,
  });

  test("grants less the counted spend, soonest-expiring first; a monthly grant renews on its day", () => {
    const key: ApiCreditKey = {
      id: "BALANCE_KEY_A", label: "main", renewsOnDay: null, account: "main",
      grants: [
        { amountUsd: 500, expires: "2027-04-18", since: null, monthly: false, label: "YC" },
        { amountUsd: 200, expires: "2026-11-11", since: null, monthly: true, label: "Max" },
      ],
    };
    const oct29 = new Date(2026, 9, 29, 12).getTime();
    spend(key.id, 150, new Date(2026, 9, 20, 12));
    spend(key.id, 80, new Date(2026, 9, 28, 12));
    // $230 against this month's $200 Max grant first, the rest from YC.
    expect(apiCreditBalance(key, oct29)).toEqual({
      balanceUsd: 470, grantedUsd: 700,
      expiresAt: [new Date(2026, 10, 12).getTime(), new Date(2027, 3, 19).getTime()],
      grants: [
        { leftUsd: 0, grantedUsd: 200, expiresAt: new Date(2026, 10, 12).getTime() },
        { leftUsd: 470, grantedUsd: 500, expiresAt: new Date(2027, 3, 19).getTime() },
      ],
    });
    // Renewed on Nov 11's end: a fresh $200, expiring Dec 11; YC keeps what it lost.
    expect(apiCreditBalance(key, new Date(2026, 10, 15).getTime())).toEqual({
      balanceUsd: 670, grantedUsd: 700,
      expiresAt: [new Date(2026, 11, 12).getTime(), new Date(2027, 3, 19).getTime()],
      grants: [
        { leftUsd: 200, grantedUsd: 200, expiresAt: new Date(2026, 11, 12).getTime() },
        { leftUsd: 470, grantedUsd: 500, expiresAt: new Date(2027, 3, 19).getTime() },
      ],
    });
    // After YC expires only the Max grant is left.
    expect(apiCreditBalance(key, new Date(2027, 3, 20).getTime())?.expiresAt).toEqual([new Date(2027, 4, 12).getTime()]);
  });

  test("config ties keys to accounts; a running credit turn marks them active; no grants, no column", async () => {
    configure(true, [
      { secret: MAIN_KEY, label: "main", account: "main", grants: [{ amountUsd: 200, expires: "2099-01-11", monthly: true }] },
      { secret: MAX2_KEY, label: "max2", account: "max2" },
    ] as never);
    const [main, max2] = apiCreditConfig().keys;
    expect(main).toMatchObject({ account: "main", renewsOnDay: 11, grants: [{ amountUsd: 200, monthly: true }] });
    expect(max2.grants).toEqual([]);
    // (Earlier tests in this file counted a few cents on this key.)
    const credits = apiCreditAccountCredits("main", new Set([MAIN_KEY]))!;
    expect(credits).toMatchObject({ grantedUsd: 200, active: true });
    expect(credits.balanceUsd).toBeGreaterThan(199);
    expect(credits.balanceUsd).toBeLessThanOrEqual(200);
    expect(apiCreditAccountCredits("main", new Set())?.active).toBe(false);
    expect(apiCreditAccountCredits("max2", new Set())).toBeNull();
  });
});
