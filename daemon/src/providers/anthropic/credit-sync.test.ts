import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import { API_CREDIT_ACCOUNT_KEY_PREFIX, apiCreditAccountCredits, apiCreditConfig, apiCreditsUsage, refreshApiCreditSecrets, setApiCreditSecretsForTests } from "./api-credits";
import {
  CREDIT_SYNC_INTERVAL_MS,
  CREDIT_SYNC_MIN_GAP_MS,
  CREDIT_SYNC_STALE_MS,
  consoleOrgs,
  creditSyncDue,
  drawDown,
  parseConsoleCredits,
  setCreditSyncForTests,
  syncConsoleCredits,
  syncedBalance,
  vimbrowserConsoleFetcher,
  type ConsoleFetcher,
  type ConsoleResponse,
} from "./credit-sync";
import { recordApiKeyUsage, resetApiKeyUsageForTest } from "../openai/api-key-usage";

// The Console's `prepaid/credits` replies on Oct 29 2026, ids replaced.
const SCOPE = { kind: "scoped", applies_to: [{ product: "agent_sdk", model_family: null, model_version: null }, { product: "api", model_family: null, model_version: null }] };
const MAIN_REPLY = {
  amount: 70000, currency: "USD", balance: { money: null, credits: { amount_minor: 70000, exponent: 2 } }, balance_credits: 700,
  amount_without_scoped_credits: 50000, auto_reload_settings: null, tranches: [],
  promo_tranches: [
    {
      remaining_amount_minor_units: 19999, currency: "USD", expires_at: "2026-11-11T00:00:00Z", granted_amount_minor_units: 20000,
      granted_at: "2026-10-29T17:18:34.502000Z", remaining: { money: null, credits: { amount_minor: 19999, exponent: 2 } },
      granted: { money: null, credits: { amount_minor: 20000, exponent: 2 } }, program_id: "subscription_api_credit",
      name: "API credit (Max 20x)", id: "00000000-0000-4000-8000-000000000001", scope: SCOPE,
    },
    {
      remaining_amount_minor_units: 50000, currency: "USD", expires_at: "2027-04-18T00:00:00Z", granted_amount_minor_units: 50000,
      granted_at: "2026-10-20T22:09:24.149000Z", remaining: { money: null, credits: { amount_minor: 50000, exponent: 2 } },
      granted: { money: null, credits: { amount_minor: 50000, exponent: 2 } }, program_id: "credit_program_v2",
      name: null, id: "00000000-0000-4000-8000-000000000002", scope: { kind: "unscoped", applies_to: [] },
    },
  ],
  next_expires_at: "2026-11-11T00:00:00Z",
};
const MAX2_REPLY = {
  amount: 20000, currency: "USD", balance: { money: null, credits: { amount_minor: 20000, exponent: 2 } }, balance_credits: 200,
  amount_without_scoped_credits: 0, tranches: [],
  promo_tranches: [{
    remaining_amount_minor_units: 19999, currency: "USD", expires_at: "2026-11-18T00:00:00Z", granted_amount_minor_units: 20000,
    granted_at: "2026-10-29T17:22:33.166000Z", remaining: { money: null, credits: { amount_minor: 19999, exponent: 2 } },
    granted: { money: null, credits: { amount_minor: 20000, exponent: 2 } }, program_id: "subscription_api_credit",
    name: "API credit (Max 20x)", id: "00000000-0000-4000-8000-000000000003", scope: SCOPE,
  }],
  next_expires_at: "2026-11-18T00:00:00Z",
};

const MAIN_ORG = "11111111-1111-4111-8111-111111111111";
const MAX2_ORG = "22222222-2222-4222-8222-222222222222";
const MAIN_KEY = "ANTHROPIC_API_KEY_MAIN_CREDITS";
const MAX2_KEY = "ANTHROPIC_API_KEY_MAX2_CREDITS";
const NOV11 = Date.parse("2026-11-11T00:00:00Z");
const NOV18 = Date.parse("2026-11-18T00:00:00Z");
const APR18 = Date.parse("2027-04-18T00:00:00Z");
const OCT29 = new Date(2026, 9, 29, 14).getTime();
const H = 3_600_000;

let dir: string;
let replies: Map<string, ConsoleResponse | Error>;
let requests: Array<{ context: string | null; path: string }>;

const fakeConsole: ConsoleFetcher = {
  async get(context, path) {
    requests.push({ context, path });
    const reply = replies.get(path.split("/")[3]);
    if (!reply) throw new Error("vimbrowser is not running");
    if (reply instanceof Error) throw reply;
    return reply;
  },
};

function ok(body: unknown): ConsoleResponse {
  return { status: 200, url: "https://platform.claude.com/api/organizations/x/prepaid/credits", body: JSON.stringify(body) };
}

function spend(key: string, usd: number, at: number): void {
  recordApiKeyUsage(API_CREDIT_ACCOUNT_KEY_PREFIX + key, { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, timestamp: at, estimatedCostUsd: usd });
}

function configure(): void {
  writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { enabled: true, keys: [
    { secret: MAIN_KEY, label: "main", account: "main", console: { org: MAIN_ORG },
      grants: [{ amountUsd: 200, expires: "2026-11-11", monthly: true }, { amountUsd: 500, expires: "2027-04-18" }] },
    { secret: MAX2_KEY, label: "max2", account: "max2", console: { org: MAX2_ORG, browserContext: "claude-max2" },
      grants: [{ amountUsd: 200, expires: "2026-11-18", since: "2026-10-29", monthly: true }] },
  ] } } } });
}

const keys = () => apiCreditConfig().keys;
const org = (id: string) => consoleOrgs(keys()).find(entry => entry.org === id)!;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-credit-sync-"));
  setApiCreditSecretsForTests({ names: async () => [MAIN_KEY, MAX2_KEY], value: async () => null, helperCommand: () => null }, join(dir, "credit-state.json"));
  setCreditSyncForTests(fakeConsole, join(dir, "sync.json"));
  resetApiKeyUsageForTest();
  replies = new Map([[MAIN_ORG, ok(MAIN_REPLY)], [MAX2_ORG, ok(MAX2_REPLY)]]);
  requests = [];
  configure();
});

afterEach(() => {
  writeExocortexConfig({});
  setCreditSyncForTests(null);
  setApiCreditSecretsForTests(null);
  resetApiKeyUsageForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("the Console's prepaid/credits reply", () => {
  test("one grant per tranche, in dollars, with its expiry", () => {
    expect(parseConsoleCredits(MAIN_REPLY)).toEqual([
      { name: "API credit (Max 20x)", programId: "subscription_api_credit", remainingUsd: 199.99, grantedUsd: 200, expiresAt: NOV11 },
      { name: null, programId: "credit_program_v2", remainingUsd: 500, grantedUsd: 500, expiresAt: APR18 },
    ]);
    expect(parseConsoleCredits(MAX2_REPLY)).toEqual([
      { name: "API credit (Max 20x)", programId: "subscription_api_credit", remainingUsd: 199.99, grantedUsd: 200, expiresAt: NOV18 },
    ]);
  });

  test("a bought balance without tranches never expires; anything else is not a reply", () => {
    expect(parseConsoleCredits({ amount: 1234, tranches: [], promo_tranches: [] })).toEqual([
      { name: null, programId: null, remainingUsd: 12.34, grantedUsd: 12.34, expiresAt: null },
    ]);
    expect(parseConsoleCredits({ type: "error", error: { message: "unauthorized" } })).toBeNull();
    expect(parseConsoleCredits("<html>")).toBeNull();
    expect(parseConsoleCredits({ promo_tranches: [] })).toEqual([]);
  });

  test("config names each key's organization and browser context", () => {
    expect(keys().map(key => key.console)).toEqual([{ org: MAIN_ORG, browserContext: null }, { org: MAX2_ORG, browserContext: "claude-max2" }]);
    expect(consoleOrgs(keys())).toEqual([
      { org: MAIN_ORG, browserContext: null, keyIds: [MAIN_KEY], label: "main" },
      { org: MAX2_ORG, browserContext: "claude-max2", keyIds: [MAX2_KEY], label: "max2" },
    ]);
  });
});

describe("balances from the last sync", () => {
  test("the Console's figures, less what Exocortex counted after the sync, from the grant expiring soonest", async () => {
    // Counted before the sync: already in the Console's figures.
    spend(MAIN_KEY, 3, OCT29 - H);
    expect(await syncConsoleCredits(keys(), { now: () => OCT29 })).toEqual(new Map([[MAIN_ORG, "synced"], [MAX2_ORG, "synced"]]));
    expect(requests).toEqual([
      { context: null, path: `/api/organizations/${MAIN_ORG}/prepaid/credits` },
      { context: "claude-max2", path: `/api/organizations/${MAX2_ORG}/prepaid/credits` },
    ]);
    expect(apiCreditAccountCredits("max2", new Set(), OCT29)).toEqual({
      balanceUsd: 199.99, grantedUsd: 200, expiresAt: [NOV18], approximate: false, signInNeeded: false, active: false,
    });
    expect(apiCreditAccountCredits("main", new Set(), OCT29)!.balanceUsd).toBeCloseTo(699.99);

    // $250 after it: the $199.99 Max grant first, then $50.01 of the $500.
    spend(MAIN_KEY, 250, OCT29 + H);
    const main = apiCreditAccountCredits("main", new Set([MAIN_KEY]), OCT29 + 2 * H)!;
    expect(main).toMatchObject({ grantedUsd: 700, expiresAt: [NOV11, APR18], approximate: false, active: true });
    expect(main.balanceUsd).toBeCloseTo(449.99);
    // Past midnight too.
    spend(MAIN_KEY, 9.99, new Date(2026, 9, 30, 9).getTime());
    expect(apiCreditAccountCredits("main", new Set(), new Date(2026, 9, 30, 10).getTime())!.balanceUsd).toBeCloseTo(440);

    // The next sync starts over from the Console's figures.
    replies.set(MAIN_ORG, ok({ ...MAIN_REPLY, promo_tranches: [{ ...MAIN_REPLY.promo_tranches[1], remaining_amount_minor_units: 44000, remaining: undefined }] }));
    await syncConsoleCredits(keys(), { force: true, now: () => new Date(2026, 9, 30, 11).getTime() });
    expect(apiCreditAccountCredits("main", new Set(), new Date(2026, 9, 30, 12).getTime())).toMatchObject({ balanceUsd: 440, grantedUsd: 500, expiresAt: [APR18] });
  });

  test("an estimate (≈) hours after the last sync, and before the first, from the configured grants", async () => {
    expect(apiCreditAccountCredits("max2", new Set(), OCT29)).toMatchObject({ balanceUsd: 200, approximate: true, signInNeeded: false });
    await syncConsoleCredits(keys(), { now: () => OCT29 });
    expect(apiCreditAccountCredits("max2", new Set(), OCT29 + CREDIT_SYNC_STALE_MS)?.approximate).toBe(false);
    expect(apiCreditAccountCredits("max2", new Set(), OCT29 + CREDIT_SYNC_STALE_MS + 60_000)).toMatchObject({ balanceUsd: 199.99, approximate: true });
    // Kept across a restart.
    setCreditSyncForTests(fakeConsole, join(dir, "sync.json"));
    expect(apiCreditAccountCredits("max2", new Set(), OCT29 + H)).toMatchObject({ balanceUsd: 199.99, approximate: false });
  });

  test("a grant past its expiry is gone at once; a renewal shows at the next sync", async () => {
    await syncConsoleCredits(keys(), { now: () => OCT29 });
    const afterExpiry = NOV11 + 60_000;
    expect(syncedBalance(org(MAIN_ORG), afterExpiry)).toMatchObject({ balanceUsd: 500, grantedUsd: 500, expiresAt: [APR18], approximate: true });
    // Spend after it expired comes out of what is left.
    spend(MAIN_KEY, 20, afterExpiry);
    expect(syncedBalance(org(MAIN_ORG), afterExpiry + 1)!.balanceUsd).toBe(480);
    const DEC11 = Date.parse("2026-12-11T00:00:00Z");
    replies.set(MAIN_ORG, ok({ ...MAIN_REPLY, promo_tranches: [
      { ...MAIN_REPLY.promo_tranches[0], remaining_amount_minor_units: 20000, remaining: undefined, expires_at: "2026-12-11T00:00:00Z" },
      { ...MAIN_REPLY.promo_tranches[1], remaining_amount_minor_units: 48000, remaining: undefined },
    ] }));
    await syncConsoleCredits(keys(), { force: true, now: () => afterExpiry + 2 });
    expect(apiCreditAccountCredits("main", new Set(), afterExpiry + 3)).toMatchObject({ balanceUsd: 680, grantedUsd: 700, expiresAt: [DEC11, APR18], approximate: false });
  });

  test("drawn soonest-expiring first; grants that never expire last", () => {
    const tranches = [
      { name: null, programId: null, remainingUsd: 10, grantedUsd: 10, expiresAt: null },
      { name: null, programId: null, remainingUsd: 5, grantedUsd: 5, expiresAt: 2_000 },
      { name: null, programId: null, remainingUsd: 5, grantedUsd: 5, expiresAt: 1_000 },
    ];
    expect(drawDown(tranches, 7, 0)).toEqual({ balanceUsd: 13, grantedUsd: 20, expiresAt: [1_000, 2_000] });
    expect(drawDown(tranches, 100, 0).balanceUsd).toBe(0);
    expect(drawDown(tranches, 0, 1_500)).toEqual({ balanceUsd: 15, grantedUsd: 15, expiresAt: [2_000] });
  });

  test("the usage block gets the balance of the key in use", async () => {
    await refreshApiCreditSecrets({ force: true });
    await syncConsoleCredits(keys(), { now: () => OCT29 });
    expect(apiCreditsUsage(true, OCT29)).toMatchObject({ label: "main", balanceUsd: 699.99, grantedUsd: 700, approximate: false });
  });
});

describe("failed syncs", () => {
  test("a signed-out session: the last figures as an estimate, and sign-in needed", async () => {
    await syncConsoleCredits(keys(), { now: () => OCT29 });
    replies.set(MAX2_ORG, { status: 401, url: "https://platform.claude.com/api/organizations/x/prepaid/credits", body: "{}" });
    const later = OCT29 + CREDIT_SYNC_INTERVAL_MS;
    expect((await syncConsoleCredits(keys(), { now: () => later })).get(MAX2_ORG)).toBe("sign-in");
    expect(apiCreditAccountCredits("max2", new Set(), later)).toMatchObject({ balanceUsd: 199.99, approximate: false, signInNeeded: true });
    expect(apiCreditAccountCredits("max2", new Set(), OCT29 + CREDIT_SYNC_STALE_MS + 1)?.approximate).toBe(true);
    // A redirect to a sign-in page says the same; so does it before any sync, over the configured grants.
    setCreditSyncForTests(fakeConsole, join(dir, "fresh.json"));
    replies.set(MAX2_ORG, { status: 200, url: "https://platform.claude.com/login?returnTo=%2F", body: "<html>" });
    await syncConsoleCredits(keys(), { now: () => OCT29 });
    expect(apiCreditAccountCredits("max2", new Set(), OCT29)).toMatchObject({ balanceUsd: 200, approximate: true, signInNeeded: true });
    // Signing in clears it at the next sync.
    replies.set(MAX2_ORG, ok(MAX2_REPLY));
    await syncConsoleCredits(keys(), { force: true, now: () => OCT29 + 1 });
    expect(apiCreditAccountCredits("max2", new Set(), OCT29 + 1)).toMatchObject({ balanceUsd: 199.99, approximate: false, signInNeeded: false });
  });

  test("one log line per streak, retried hourly however often events ask", async () => {
    // An account name of its own: log lines of other tests (written asynchronously) cannot count.
    const account = `streak${Math.random().toString(36).slice(2, 8)}`;
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { enabled: true, keys: [
      { secret: MAX2_KEY, label: "max2", account, console: { org: MAX2_ORG, browserContext: "claude-max2" } },
    ] } } } });
    replies.delete(MAX2_ORG);
    let at = OCT29;
    const now = () => at;
    expect((await syncConsoleCredits(keys(), { now })).get(MAX2_ORG)).toBe("failed");
    // No grants configured and never synced: nothing to show.
    expect(apiCreditAccountCredits(account, new Set(), at)).toBeNull();
    at += CREDIT_SYNC_MIN_GAP_MS * 2;
    expect((await syncConsoleCredits(keys(), { event: true, now })).get(MAX2_ORG)).toBe("skipped");
    expect(creditSyncDue(MAX2_ORG, true, OCT29 + CREDIT_SYNC_INTERVAL_MS)).toBe(true);
    at = OCT29 + CREDIT_SYNC_INTERVAL_MS;
    expect((await syncConsoleCredits(keys(), { now })).get(MAX2_ORG)).toBe("failed");
    expect(requests.filter(request => request.context === "claude-max2")).toHaveLength(2);
    replies.set(MAX2_ORG, ok(MAX2_REPLY));
    at += CREDIT_SYNC_INTERVAL_MS;
    expect((await syncConsoleCredits(keys(), { now })).get(MAX2_ORG)).toBe("synced");
    // Working: an event may sync again after a few minutes, not sooner.
    expect(creditSyncDue(MAX2_ORG, true, at + CREDIT_SYNC_MIN_GAP_MS - 1)).toBe(false);
    expect(creditSyncDue(MAX2_ORG, true, at + CREDIT_SYNC_MIN_GAP_MS)).toBe(true);
    expect(creditSyncDue(MAX2_ORG, false, at + CREDIT_SYNC_MIN_GAP_MS)).toBe(false);

    const marker = `credit-sync-test-${Math.random()}`;
    log("info", marker);
    const logFile = join(runtimeDir(), "exocortex.log");
    for (let i = 0; i < 200 && !(existsSync(logFile) && readFileSync(logFile, "utf-8").includes(marker)); i++) await Bun.sleep(10);
    for (let i = 0; i < 200 && !readFileSync(logFile, "utf-8").includes(`${account} from the Claude Console works again`); i++) await Bun.sleep(10);
    const logged = readFileSync(logFile, "utf-8");
    expect(logged.split(`reading API credits for ${account} from the Claude Console failed`)).toHaveLength(2);
    expect(logged).toContain(`reading API credits for ${account} from the Claude Console works again`);
  });
});

describe("through vimbrowser", () => {
  const savedBin = process.env.EXOCORTEX_VIMBROWSER_CLI_BIN;

  afterEach(() => {
    if (savedBin === undefined) delete process.env.EXOCORTEX_VIMBROWSER_CLI_BIN;
    else process.env.EXOCORTEX_VIMBROWSER_CLI_BIN = savedBin;
  });

  /** A vimbrowser-cli stand-in: tabs in a file; `js` answers the start and the collection of one request. */
  function fakeVimbrowser(reply: { status: number; url: string; body: string }, startUrl = "https://platform.claude.com/settings/billing"): { calls: () => string[] } {
    const state = join(dir, "vb.json");
    writeFileSync(state, JSON.stringify({ tabs: [{ id: 5, url: "https://example.com/", context: null, loading: false }], calls: [] }));
    const script = join(dir, "vimbrowser-cli");
    writeFileSync(script, `#!/usr/bin/env bun
const fs = require("fs");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf-8"));
const [command, ...args] = process.argv.slice(2);
state.calls.push([command, ...args].join(" "));
let out = "";
if (command === "tabs") out = JSON.stringify(state.tabs);
else if (command === "open-context" || command === "open") {
  const context = command === "open" ? null : args[0];
  state.tabs.push({ id: 100 + state.tabs.length, url: ${JSON.stringify(startUrl)}, context, loading: false });
  out = "{}";
} else if (command === "js") {
  const code = fs.readFileSync(0, "utf-8");
  if (!code.includes("/prepaid/credits") && !code.includes("delete slots")) throw new Error("unexpected script");
  out = JSON.stringify({ ok: true, type: "string", result: code.includes("fetch(") ? "started" : JSON.stringify(${JSON.stringify(reply)}) });
}
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
process.stdout.write(out);
`);
    chmodSync(script, 0o755);
    process.env.EXOCORTEX_VIMBROWSER_CLI_BIN = script;
    return { calls: () => JSON.parse(readFileSync(state, "utf-8")).calls };
  }

  test("a GET run by the page in its own background tab of the right context, reused after", async () => {
    const vb = fakeVimbrowser({ status: 200, url: `https://platform.claude.com/api/organizations/${MAX2_ORG}/prepaid/credits`, body: JSON.stringify(MAX2_REPLY) });
    const path = `/api/organizations/${MAX2_ORG}/prepaid/credits`;
    expect(await vimbrowserConsoleFetcher.get("claude-max2", path)).toMatchObject({ status: 200 });
    expect(await vimbrowserConsoleFetcher.get("claude-max2", path)).toMatchObject({ status: 200 });
    const calls = vb.calls();
    expect(calls.filter(call => call.startsWith("open-context"))).toEqual(["open-context claude-max2 https://platform.claude.com/settings/billing"]);
    expect(calls.filter(call => call.startsWith("js")).every(call => call.startsWith("js 101 "))).toBe(true);
    expect(calls.some(call => /cookie/i.test(call))).toBe(false);
  });

  test("a tab sent to another site's sign-in page is a signed-out session", async () => {
    fakeVimbrowser({ status: 200, url: "", body: "" }, "https://claude.ai/login");
    setCreditSyncForTests(vimbrowserConsoleFetcher, join(dir, "sync.json"));
    expect((await syncConsoleCredits(keys(), { now: () => OCT29 })).get(MAX2_ORG)).toBe("sign-in");
  });
});
