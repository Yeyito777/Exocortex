import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { setClaudeAccountsFileForTests } from "./accounts";
import { apiCreditSwitchNotice, getCombinedUsage, refreshClaudeAccountStatuses, routeClaudeTurn, setAssignmentsFileForTests, touchConversationCredit } from "./account-pool";
import {
  API_CREDIT_CACHE_TTL_MS,
  apiCreditConfig,
  markApiCreditRejected,
  markApiCreditSpent,
  noteApiCreditFailure,
  pickApiCreditKey,
  refreshApiCreditSecrets,
  setApiCreditSecretsForTests,
  usableApiCreditKey,
} from "./api-credits";
import { setClaudeAuthProbeForTests } from "./auth-cache";
import { setCreditSyncForTests, syncConsoleCredits, type ConsoleFetcher } from "./credit-sync";
import { applyUsageHeaders, CLAUDE_RATE_LIMIT_HEADER, clearUsage } from "./usage";
import { resetApiKeyUsageForTest } from "../openai/api-key-usage";

const MAIN_KEY = "ANTHROPIC_API_KEY_MAIN_CREDITS";
const MAX2_KEY = "ANTHROPIC_API_KEY_MAX2_CREDITS";
const MAIN_ORG = "11111111-1111-4111-8111-111111111111";
const MAX2_ORG = "22222222-2222-4222-8222-222222222222";
const MIN = 60_000;
const H = 60 * MIN;

/** A Console `prepaid/credits` reply with these grants (dollars left, ISO expiry). */
function reply(grants: Array<[left: number, granted: number, expires: string]>) {
  return {
    status: 200,
    url: "https://platform.claude.com/api/organizations/x/prepaid/credits",
    body: JSON.stringify({
      tranches: [],
      promo_tranches: grants.map(([left, granted, expires]) => ({
        remaining_amount_minor_units: Math.round(left * 100), granted_amount_minor_units: granted * 100, expires_at: expires,
      })),
    }),
  };
}

// The owner's figures on Oct 30 2026: main's Max credit used up, the YC grant
// mostly left; max2's Max credit untouched and expiring in 18 days.
const OWNER = {
  [MAIN_ORG]: reply([[0, 200, "2026-11-11T00:00:00Z"], [422, 500, "2027-04-18T00:00:00Z"]]),
  [MAX2_ORG]: reply([[200, 200, "2026-11-18T00:00:00Z"]]),
};

let dir: string;
let replies: Record<string, ReturnType<typeof reply>>;
let storeNames: string[];

const fakeConsole: ConsoleFetcher = {
  async get(_context, path) {
    const found = replies[path.split("/")[3]];
    if (!found) throw new Error("vimbrowser is not running");
    return found;
  },
};

function configure(extra: Record<string, unknown> = {}): void {
  writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { enabled: true, ...extra, keys: [
    { secret: MAIN_KEY, label: "main", account: "main", console: { org: MAIN_ORG } },
    { secret: MAX2_KEY, label: "max2", account: "max2", console: { org: MAX2_ORG, browserContext: "claude-max2" } },
  ] } } } });
}

async function sync(at: number): Promise<void> {
  await syncConsoleCredits(apiCreditConfig().keys, { force: true, now: () => at });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "exo-credit-pick-"));
  storeNames = [MAIN_KEY, MAX2_KEY];
  setApiCreditSecretsForTests({ names: async () => storeNames, value: async () => null, helperCommand: name => `printenv ${name}` }, join(dir, "credit-state.json"));
  setCreditSyncForTests(fakeConsole, join(dir, "sync.json"));
  resetApiKeyUsageForTest();
  replies = { ...OWNER };
  configure();
  await refreshApiCreditSecrets({ force: true });
});

afterEach(() => {
  writeExocortexConfig({});
  setCreditSyncForTests(null);
  setApiCreditSecretsForTests(null);
  resetApiKeyUsageForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("which API-credit key a turn takes", () => {
  test("the one whose credit expires soonest, used up grants left out", async () => {
    const now = Date.now();
    await sync(now);
    const pick = pickApiCreditKey(null, now)!;
    expect(pick).toMatchObject({ key: { id: MAX2_KEY }, reason: "expiry", movedFrom: null });
    expect(pick.detail).toMatch(/^its credit expires soonest: \$200 in \d+d, vs "main" \d+d$/);
    expect(usableApiCreditKey(now)?.id).toBe(MAX2_KEY);
    // With money left on main's Max credit, which expires a week before max2's, main goes first.
    replies[MAIN_ORG] = reply([[150, 200, "2026-11-11T00:00:00Z"], [422, 500, "2027-04-18T00:00:00Z"]]);
    await sync(now);
    expect(pickApiCreditKey(null, now)?.key.id).toBe(now < Date.parse("2026-11-11T00:00:00Z") ? MAIN_KEY : MAX2_KEY);
  });

  test("a nearly empty key only when every key is", async () => {
    const now = Date.now();
    replies[MAX2_ORG] = reply([[1.5, 200, "2026-11-18T00:00:00Z"]]);
    await sync(now);
    const pick = pickApiCreditKey(null, now)!;
    expect(pick.key.id).toBe(MAIN_KEY);
    expect(pick.detail).toEndWith(`; "max2" under $2.00`);
    replies[MAIN_ORG] = reply([[1, 500, "2027-04-18T00:00:00Z"]]);
    await sync(now);
    // Both nearly empty: still a key (the API's own refusal catches the end), soonest expiry first.
    expect(pickApiCreditKey(null, now)).toMatchObject({ key: { id: MAX2_KEY } });
    expect(pickApiCreditKey(null, now)!.detail).toContain("every key has under $2.00 left");
    configure({ minBalanceUsd: 0.5 });
    expect(pickApiCreditKey(null, now)?.key.id).toBe(MAX2_KEY);
    expect(pickApiCreditKey(null, now)!.detail).not.toContain("under");
  });

  test("a conversation stays on its key while its cache there is warm, and is placed afresh once it is cold", async () => {
    const now = Date.now();
    await sync(now);
    const warm = pickApiCreditKey({ key: MAIN_KEY, lastUsedAt: now - 2 * MIN }, now)!;
    expect(warm).toMatchObject({ key: { id: MAIN_KEY }, reason: "warm", movedFrom: null });
    expect(warm.detail).toBe("its prompt cache on this key is warm, last request 2m ago");
    const cold = pickApiCreditKey({ key: MAIN_KEY, lastUsedAt: now - API_CREDIT_CACHE_TTL_MS - 1 }, now)!;
    expect(cold).toMatchObject({ key: { id: MAX2_KEY }, reason: "expiry", movedFrom: { id: MAIN_KEY } });
    expect(cold.detail).toStartWith(`its cache on "main" is cold; its credit expires soonest`);
    // Last on a subscription: nothing to keep warm.
    expect(pickApiCreditKey({ key: null, lastUsedAt: now }, now)).toMatchObject({ key: { id: MAX2_KEY }, movedFrom: null });
    // A warm key that has nearly run out is left while another has credit.
    replies[MAIN_ORG] = reply([[1, 500, "2027-04-18T00:00:00Z"]]);
    replies[MAX2_ORG] = reply([[100, 200, "2026-11-18T00:00:00Z"]]);
    await sync(now);
    expect(pickApiCreditKey({ key: MAIN_KEY, lastUsedAt: now - MIN }, now)).toMatchObject({ key: { id: MAX2_KEY }, movedFrom: { id: MAIN_KEY } });
  });

  test("a key that refuses (out of credits, rejected, rate-limited) gives way, warm or not", async () => {
    const now = Date.now();
    await sync(now);
    const [main, max2] = apiCreditConfig().keys;
    expect(noteApiCreditFailure(max2, new Error("Claude Code: API Error: 429 rate_limit_error"), now)).toBe("throttled");
    const throttled = pickApiCreditKey({ key: MAX2_KEY, lastUsedAt: now - MIN }, now)!;
    expect(throttled).toMatchObject({ key: { id: MAIN_KEY }, movedFrom: { id: MAX2_KEY } });
    expect(throttled.detail).toStartWith(`"max2" cannot take it now; the only key that can take it`);
    // Back after its minute.
    expect(pickApiCreditKey(null, now + 61_000)?.key.id).toBe(MAX2_KEY);
    markApiCreditSpent(max2, "credit balance is too low", now + 61_000);
    expect(pickApiCreditKey({ key: MAX2_KEY, lastUsedAt: now }, now + 62_000)?.key.id).toBe(MAIN_KEY);
    markApiCreditRejected(main, "invalid x-api-key", now + 62_000);
    expect(pickApiCreditKey(null, now + 63_000)).toBeNull();
  });

  test("config order without recent Console figures for every key, or with strategy \"order\"", async () => {
    const now = Date.now();
    // Never synced: nothing known about either key's grants.
    expect(pickApiCreditKey(null, now)).toMatchObject({ key: { id: MAIN_KEY }, reason: "order" });
    expect(pickApiCreditKey(null, now)!.detail).toBe(`config order, no recent Console balance for "main", "max2"`);
    // Only max2 synced: main is unknown, so no ranking.
    delete replies[MAIN_ORG];
    await sync(now);
    expect(pickApiCreditKey(null, now)!.detail).toBe(`config order, no recent Console balance for "main"`);
    // Both synced, but hours ago.
    replies = { ...OWNER };
    await sync(now);
    expect(pickApiCreditKey(null, now)?.key.id).toBe(MAX2_KEY);
    expect(pickApiCreditKey(null, now + 4 * H)).toMatchObject({ key: { id: MAIN_KEY }, reason: "order" });
    configure({ strategy: "order" });
    expect(pickApiCreditKey(null, now)).toMatchObject({ key: { id: MAIN_KEY }, reason: "order", detail: "config order" });
    // Order still keeps a warm conversation where it is, and skips a missing key.
    expect(pickApiCreditKey({ key: MAX2_KEY, lastUsedAt: now - MIN }, now)?.key.id).toBe(MAX2_KEY);
    storeNames = [MAX2_KEY];
    await refreshApiCreditSecrets({ force: true });
    expect(pickApiCreditKey(null, now)?.key.id).toBe(MAX2_KEY);
  });
});

describe("credit routing for conversations", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    mkdirSync(join(dir, "main"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "main");
    setClaudeAccountsFileForTests(join(dir, "accounts.json"));
    setAssignmentsFileForTests(join(dir, "assignments.json"));
    setClaudeAuthProbeForTests(async () => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
    clearUsage("main");
    await refreshClaudeAccountStatuses({ force: true });
    // The only subscription account at its weekly limit: turns run on credits.
    const at = Math.floor(Date.now() / 1000);
    applyUsageHeaders(new Headers({
      [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
        status: "rejected",
        unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: at + 7200 }, seven_day: { utilization: 1, resetsAt: at + 86_400 } },
      }),
    }));
    await sync(Date.now());
  });

  afterEach(() => {
    clearUsage("main");
    setClaudeAuthProbeForTests(null);
    setAssignmentsFileForTests(null);
    setClaudeAccountsFileForTests(null);
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  test("new conversations take the soonest-expiring key; one warm on another key stays; a refusal moves it", async () => {
    const fresh = await routeClaudeTurn("conv-new", null);
    expect(fresh).toMatchObject({ apiCredit: { id: MAX2_KEY }, apiCreditMovedFrom: null });
    expect(fresh.apiCreditDetail).toStartWith("its credit expires soonest");

    // A conversation that was running on main a minute ago keeps its cache there.
    touchConversationCredit("conv-old", MAIN_KEY, Date.now() - MIN);
    const sticky = await routeClaudeTurn("conv-old", null);
    expect(sticky.apiCredit?.id).toBe(MAIN_KEY);
    expect(sticky.apiCreditDetail).toStartWith("its prompt cache on this key is warm");
    expect(apiCreditSwitchNotice("conv-old", sticky)).toBeNull();

    // main rate-limits it: the conversation moves to max2, with a (hidden) notice that says why.
    noteApiCreditFailure(apiCreditConfig().keys[0], new Error("API Error: 429 Too Many Requests"));
    const moved = await routeClaudeTurn("conv-old", null);
    expect(moved).toMatchObject({ apiCredit: { id: MAX2_KEY }, apiCreditMovedFrom: { id: MAIN_KEY } });
    expect(apiCreditSwitchNotice("conv-old", moved)).toBe(`Claude API credits: now on "max2" instead of "main" ("main" cannot take it now; the only key that can take it).`);

    // A subscription turn ends the record only where there is one.
    touchConversationCredit("conv-sub", null);
    touchConversationCredit("conv-old", null);
    expect((await routeClaudeTurn("conv-old", null)).apiCreditMovedFrom).toBeNull();
  });

  test("the usage data names the key new credit turns take and why", async () => {
    const credits = getCombinedUsage()?.apiCredits;
    expect(credits).toMatchObject({ active: true, ready: true, label: "max2" });
    expect(credits?.labelReason).toStartWith("its credit expires soonest: $200 in");
  });
});
