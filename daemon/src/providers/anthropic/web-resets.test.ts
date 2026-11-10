import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import { clearProviderAuth, saveProviderAuth } from "../../store";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "./accounts";
import { claudeAccountsInfo, getCombinedUsage, refreshCombinedUsage, setAssignmentsFileForTests } from "./account-pool";
import { onClaudeAccountsChanged } from "./account-events";
import { cachedClaudeAuthStatus, setClaudeAuthProbeForTests } from "./auth-cache";
import { applyPlanRateLimits, clearUsage } from "./usage";
import type { ClaudeAuthStatus } from "./types";
import {
  classifyWebUsage,
  curlArgs,
  refreshWebResets,
  setWebResetsDepsForTests,
  WEB_RESETS_POLL_MS,
  webResetCredits,
  webResetCreditsFromUsage,
  webResetsConfig,
  webSessionProblem,
  webSessionSecretName,
  withWebResets,
  type WebUsageResponse,
} from "./web-resets";

const MAIN_ORG = "00000000-0000-4000-8000-0000000000a1";
const MAX2_ORG = "00000000-0000-4000-8000-0000000000b2";
const NOW = Date.parse("2026-11-09T22:00:00Z");
const ENDS = Date.parse("2027-03-09T07:59:00Z");

// claude.ai's `usage?cedar_ember=1` answer on Nov 9 2026 (main), trimmed to what matters.
function grant(id: string, left: number, endsAt = "2027-03-09T07:59:00+00:00") {
  return {
    id, label: "New model launch", resets_total: 1, resets_left: left,
    starts_at: "2026-11-09T18:00:00+00:00", ends_at: endsAt,
    clears: ["seven_day_overage_included"], paused: false, usable_now: true, use_requires_limit: false,
    percent_used: { seven_day_overage_included: 21, seven_day: 49 }, blocking: [], arm: null, type: "full",
    unavailable_reason: null, gives_back_weekly: true,
  };
}
const USAGE_BODY = {
  five_hour: null,
  seven_day: { utilization: 49, resets_at: "2026-11-14T08:00:00+00:00" },
  cedar_ember: {
    eligible: true, ineligible_reason: null, at_limit: false, exhausted: [],
    grants: [grant("launch-2610-fable", 1), grant("launch-2610-fable-6mo", 1)],
    next_grant_id: "launch-2610-fable", weekly_resets_at: "2026-11-14T08:00:00+00:00", cooldown_until: null, paused_held: false,
  },
};
const json = (body: unknown, status = 200): WebUsageResponse => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const EXPIRED = json({ type: "error", error: { type: "permission_error", message: "Invalid authorization", details: { error_code: "account_session_invalid" } } }, 403);
const NOT_FOUND = json({ type: "error", error: { type: "not_found_error", message: "Not found." } }, 404);
const CHALLENGE: WebUsageResponse = { status: 403, contentType: "text/html; charset=UTF-8", body: "<!DOCTYPE html><title>Just a moment...</title>" };

const SIGNED_IN = (orgId: string): ClaudeAuthStatus => ({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", orgId });

let replies: Map<string, WebUsageResponse>;
let requests: Array<{ secret: string; org: string }>;

function enable(accounts?: string[]): void {
  writeExocortexConfig({ providers: { anthropic: { webResets: { enabled: true, ...(accounts ? { accounts } : {}) } } } });
}

beforeEach(() => {
  replies = new Map([[MAIN_ORG, json(USAGE_BODY)]]);
  requests = [];
  setWebResetsDepsForTests({
    request: async (secret, org) => {
      requests.push({ secret, org });
      return replies.get(org) ?? { error: "network", detail: "curl: (6) Could not resolve host" };
    },
  });
});

afterEach(() => {
  writeExocortexConfig({});
  setWebResetsDepsForTests(null);
});

describe("claude.ai's usage answer", () => {
  test("the grants' resets left together, and the nearest end", () => {
    expect(webResetCreditsFromUsage(USAGE_BODY, NOW)).toEqual({ availableCount: 2, nextExpiresAt: ENDS });
    const mixed = { cedar_ember: { grants: [grant("a", 0), grant("b", 2, "2027-05-01T00:00:00Z"), grant("c", 1, "2026-11-01T00:00:00Z"), grant("d", 1, "2027-01-01T00:00:00Z")] } };
    // Used up and ended grants count for nothing.
    expect(webResetCreditsFromUsage(mixed, NOW)).toEqual({ availableCount: 3, nextExpiresAt: Date.parse("2027-01-01T00:00:00Z") });
    expect(webResetCreditsFromUsage({ cedar_ember: null }, NOW)).toBeNull();
    expect(webResetCreditsFromUsage({ cedar_ember: { grants: [] } }, NOW)).toBeNull();
    expect(webResetCreditsFromUsage("<html>", NOW)).toBeNull();
  });

  test("each kind of answer", () => {
    expect(classifyWebUsage(json(USAGE_BODY), NOW)).toEqual({ ok: true, credits: { availableCount: 2, nextExpiresAt: ENDS } });
    expect(classifyWebUsage(EXPIRED)).toMatchObject({ ok: false, failure: "expired" });
    expect(classifyWebUsage({ ...EXPIRED, status: 401 })).toMatchObject({ ok: false, failure: "expired" });
    expect(classifyWebUsage({ status: 302, contentType: "text/html", body: "" })).toMatchObject({ ok: false, failure: "expired" });
    expect(classifyWebUsage(NOT_FOUND)).toMatchObject({ ok: false, failure: "other_account" });
    expect(classifyWebUsage(CHALLENGE)).toMatchObject({ ok: false, failure: "blocked" });
    expect(classifyWebUsage({ status: 200, contentType: "text/html", body: "<html>" })).toMatchObject({ ok: false, failure: "blocked" });
    expect(classifyWebUsage({ status: 200, contentType: "application/json", body: "{oops" })).toMatchObject({ ok: false, failure: "blocked" });
    expect(classifyWebUsage(json({}, 500))).toMatchObject({ ok: false, failure: "http" });
    expect(classifyWebUsage(json({}, 429))).toMatchObject({ ok: false, failure: "http" });
    expect(classifyWebUsage({ error: "network", detail: "curl: (28) timed out" })).toMatchObject({ ok: false, failure: "network" });
    expect(classifyWebUsage({ error: "missing", detail: "not in the secrets store" })).toMatchObject({ ok: false, failure: "missing" });
  });

  test("one GET of the usage with the reset grants, the session read by curl from its environment", () => {
    const args = curlArgs("CLAUDE_WEB_SESSION_MAIN", MAIN_ORG);
    expect(args.at(-1)).toBe(`https://claude.ai/api/organizations/${MAIN_ORG}/usage?cedar_ember=1&skip_spend=1`);
    expect(args).toContain("Cookie: sessionKey={{CLAUDE_WEB_SESSION_MAIN}}");
    expect(args).not.toContain("-X");
    expect(args.join(" ")).not.toMatch(/POST|PUT|PATCH|DELETE|--data|-d /);
    expect(webSessionSecretName("main")).toBe("CLAUDE_WEB_SESSION_MAIN");
    expect(webSessionSecretName("max-2")).toBe("CLAUDE_WEB_SESSION_MAX_2");
  });
});

describe("polling", () => {
  const main = { id: "main", org: MAIN_ORG, ownResets: false };

  test("off by default: no request, and usage as it was", async () => {
    expect(webResetsConfig()).toEqual({ enabled: false, accounts: null });
    expect(await refreshWebResets([main], NOW)).toBe(false);
    expect(requests).toHaveLength(0);
    const usage = { fiveHour: null, sevenDay: { utilization: 49, resetsAt: NOW + 3_600_000 } };
    expect(withWebResets(usage, "main", NOW)).toBe(usage);
    expect(webSessionProblem("main")).toBeNull();

    // Turned off after a poll: what it read stops showing.
    enable();
    await refreshWebResets([main], NOW);
    expect(webResetCredits("main", NOW)).not.toBeNull();
    writeExocortexConfig({});
    expect(webResetCredits("main", NOW)).toBeNull();
    expect(withWebResets(usage, "main", NOW)).toBe(usage);
  });

  test("at most once per interval per account", async () => {
    enable();
    expect(await refreshWebResets([main], NOW)).toBe(true);
    expect(webResetCredits("main", NOW)).toEqual({ availableCount: 2, nextExpiresAt: ENDS });
    expect(await refreshWebResets([main], NOW + WEB_RESETS_POLL_MS - 1)).toBe(false);
    expect(requests).toHaveLength(1);
    expect(await refreshWebResets([main], NOW + WEB_RESETS_POLL_MS)).toBe(false);
    expect(requests).toEqual([{ secret: "CLAUDE_WEB_SESSION_MAIN", org: MAIN_ORG }, { secret: "CLAUDE_WEB_SESSION_MAIN", org: MAIN_ORG }]);
    // A failure waits the whole interval too.
    replies.set(MAIN_ORG, { error: "network", detail: "curl: (28) timed out" });
    await refreshWebResets([main], NOW + 2 * WEB_RESETS_POLL_MS);
    await refreshWebResets([main], NOW + 2 * WEB_RESETS_POLL_MS + 60_000);
    expect(requests).toHaveLength(3);
  });

  test("concurrent refreshes share one request", async () => {
    enable();
    await Promise.all([refreshWebResets([main], NOW), refreshWebResets([main], NOW)]);
    expect(requests).toHaveLength(1);
  });

  test("Claude Code's own report wins: not polled, and its resets show", async () => {
    enable();
    expect(await refreshWebResets([{ ...main, ownResets: true }], NOW)).toBe(false);
    expect(requests).toHaveLength(0);
    await refreshWebResets([main], NOW);
    const own = { fiveHour: null, sevenDay: null, resetCredits: { availableCount: 5, nextExpiresAt: null } };
    expect(withWebResets(own, "main", NOW)).toBe(own);
  });

  test("only the accounts it is on for, with a known organization", async () => {
    enable(["max2"]);
    await refreshWebResets([main, { id: "max2", org: undefined, ownResets: false }, { id: "max2b", org: MAX2_ORG, ownResets: false }], NOW);
    expect(requests).toHaveLength(0);
    enable();
    await refreshWebResets([{ id: "max2", org: "not-an-org", ownResets: false }], NOW);
    expect(requests).toHaveLength(0);
  });

  test("a failure shows no resets at once; the owner's kinds show as the account's problem", async () => {
    enable();
    await refreshWebResets([main], NOW);
    expect(webResetCredits("main", NOW)).not.toBeNull();
    const cases: Array<[WebUsageResponse, string | null]> = [
      [EXPIRED, "expired"],
      [NOT_FOUND, "other_account"],
      [{ error: "missing", detail: "not in the secrets store" }, "missing"],
      [CHALLENGE, null],
      [{ error: "network", detail: "curl: (28) timed out" }, null],
      [json({}, 503), null],
    ];
    let at = NOW;
    for (const [reply, problem] of cases) {
      replies.set(MAIN_ORG, json(USAGE_BODY));
      at += WEB_RESETS_POLL_MS;
      await refreshWebResets([main], at);
      expect(webResetCredits("main", at)).not.toBeNull();
      replies.set(MAIN_ORG, reply);
      at += WEB_RESETS_POLL_MS;
      expect(await refreshWebResets([main], at)).toBe(true);
      expect(webResetCredits("main", at)).toBeNull();
      expect(webSessionProblem("main")).toBe(problem as never);
    }
    // Back: the resets show and the problem goes.
    replies.set(MAIN_ORG, json(USAGE_BODY));
    await refreshWebResets([main], at + WEB_RESETS_POLL_MS);
    expect(webSessionProblem("main")).toBeNull();
    expect(webResetCredits("main", at + WEB_RESETS_POLL_MS)).toEqual({ availableCount: 2, nextExpiresAt: ENDS });
  });

  test("one warning per account per kind of failure until a poll works again", async () => {
    enable();
    const account = `warn-${Math.random().toString(36).slice(2, 8)}`;
    const target = { id: account, org: MAX2_ORG, ownResets: false };
    replies.set(MAX2_ORG, EXPIRED);
    let at = NOW;
    for (let i = 0; i < 3; i++) await refreshWebResets([target], at += WEB_RESETS_POLL_MS);
    replies.set(MAX2_ORG, CHALLENGE);
    await refreshWebResets([target], at += WEB_RESETS_POLL_MS);
    await refreshWebResets([target], at += WEB_RESETS_POLL_MS);
    replies.set(MAX2_ORG, json(USAGE_BODY));
    await refreshWebResets([target], at += WEB_RESETS_POLL_MS);
    replies.set(MAX2_ORG, EXPIRED);
    await refreshWebResets([target], at += WEB_RESETS_POLL_MS);

    const marker = `web-resets-test-${Math.random()}`;
    log("info", marker);
    const logFile = join(runtimeDir(), "exocortex.log");
    for (let i = 0; i < 200 && !(existsSync(logFile) && readFileSync(logFile, "utf-8").includes(marker)); i++) await Bun.sleep(10);
    const logged = readFileSync(logFile, "utf-8").split("\n").filter(line => line.includes(`"${account}"`));
    expect(logged.filter(line => line.includes("(expired)"))).toHaveLength(2);
    expect(logged.filter(line => line.includes("(blocked)"))).toHaveLength(1);
    expect(logged.filter(line => line.includes("readable again"))).toHaveLength(1);
    expect(logged.filter(line => line.includes("[WARN]"))).toHaveLength(3);
  });
});

describe("through secrets and curl", () => {
  const SESSION = "sk-ant-sid01-FAKESESSIONVALUEnotreal_0123456789";
  let dir: string;
  const saved = { bin: process.env.EXOCORTEX_SECRETS_BIN, curl: process.env.EXOCORTEX_CURL_BIN };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exo-web-resets-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "body.json"), JSON.stringify(USAGE_BODY));
    // `secrets run --allow NAME … -- cmd`: NAME in cmd's environment only.
    writeFileSync(join(dir, "bin", "secrets"), `#!/bin/bash
name="$3"
[ "$name" = CLAUDE_WEB_SESSION_GONE ] && { echo "Error: secret not found: $name" >&2; exit 1; }
while [ "$1" != "--" ]; do shift; done; shift
export "$name=${SESSION}"
exec "$@"
`);
    writeFileSync(join(dir, "bin", "curl"), `#!/bin/bash
printf '%s\\n' "$@" > "${dir}/argv"
env | grep -c FAKESESSIONVALUE > "${dir}/env-hits"
cat "${dir}/body.json"
printf '\\n200 application/json' >&2
`);
    chmodSync(join(dir, "bin", "secrets"), 0o755);
    chmodSync(join(dir, "bin", "curl"), 0o755);
    process.env.EXOCORTEX_SECRETS_BIN = join(dir, "bin", "secrets");
    process.env.EXOCORTEX_CURL_BIN = join(dir, "bin", "curl");
    setWebResetsDepsForTests(null);
    enable();
  });

  afterEach(() => {
    if (saved.bin === undefined) delete process.env.EXOCORTEX_SECRETS_BIN;
    else process.env.EXOCORTEX_SECRETS_BIN = saved.bin;
    if (saved.curl === undefined) delete process.env.EXOCORTEX_CURL_BIN;
    else process.env.EXOCORTEX_CURL_BIN = saved.curl;
    rmSync(dir, { recursive: true, force: true });
  });

  test("the session reaches curl's environment and nothing else", async () => {
    expect(await refreshWebResets([{ id: "main", org: MAIN_ORG, ownResets: false }], NOW)).toBe(true);
    expect(webResetCredits("main", NOW)).toEqual({ availableCount: 2, nextExpiresAt: ENDS });
    const argv = readFileSync(join(dir, "argv"), "utf-8");
    expect(argv).not.toContain("FAKESESSIONVALUE");
    expect(argv).toContain("Cookie: sessionKey={{CLAUDE_WEB_SESSION_MAIN}}");
    expect(readFileSync(join(dir, "env-hits"), "utf-8").trim()).toBe("1");

    await refreshWebResets([{ id: "gone", org: MAX2_ORG, ownResets: false }], NOW);
    expect(webSessionProblem("gone")).toBe("missing");
  });
});

describe("in the account pool", () => {
  let dir: string;
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const SECRET = "sk-ant-sid01-NEVERSHOWNANYWHERE";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "exo-web-resets-pool-"));
    mkdirSync(join(dir, "main"), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(dir, "main");
    setClaudeAccountsFileForTests(join(dir, "accounts.json"));
    setAssignmentsFileForTests(join(dir, "assignments.json"));
    setClaudeAuthProbeForTests(async account => SIGNED_IN(account === "main" ? MAIN_ORG : MAX2_ORG));
    clearUsage();
    replies.set(MAX2_ORG, EXPIRED);
  });

  afterEach(() => {
    clearUsage();
    setClaudeAuthProbeForTests(null);
    setAssignmentsFileForTests(null);
    setClaudeAccountsFileForTests(null);
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    rmSync(dir, { recursive: true, force: true });
  });

  const report = { five_hour: null, seven_day: { utilization: 49, resets_at: "2026-11-14T08:00:00Z" }, cedar_ember: null };

  test("a lone account's organization comes from a sign-in check made for it", async () => {
    // Signed in as far as Exocortex last saw (no check yet), as after a start.
    saveProviderAuth("anthropic", { source: "claude-code" });
    applyPlanRateLimits("main", report);
    enable();
    await refreshCombinedUsage();
    clearProviderAuth("anthropic");
    expect(requests).toEqual([{ secret: "CLAUDE_WEB_SESSION_MAIN", org: MAIN_ORG }]);
    expect(getCombinedUsage()?.resetCredits).toEqual({ availableCount: 2, nextExpiresAt: ENDS });
  });

  test("the resets show per account and combined; the expired one says so; nothing secret goes out", async () => {
    addClaudeAccount("max2", join(dir, "max2"));
    await cachedClaudeAuthStatus("main");
    await cachedClaudeAuthStatus("max2");
    applyPlanRateLimits("main", report);
    applyPlanRateLimits("max2", report);
    let changes = 0;
    const stop = onClaudeAccountsChanged(() => { changes += 1; });

    // Off: exactly as before.
    await refreshCombinedUsage();
    expect(requests).toHaveLength(0);
    const before = claudeAccountsInfo();
    expect(before.accounts.every(account => !("webSession" in account) && !account.usage?.resetCredits)).toBe(true);
    expect(getCombinedUsage()?.resetCredits).toBeUndefined();

    enable();
    changes = 0;
    await refreshCombinedUsage();
    stop();
    expect(changes).toBeGreaterThan(0);
    expect(requests.map(request => request.org).sort()).toEqual([MAIN_ORG, MAX2_ORG]);
    const info = claudeAccountsInfo();
    const main = info.accounts.find(account => account.id === "main")!;
    const max2 = info.accounts.find(account => account.id === "max2")!;
    expect(main.usage?.resetCredits?.availableCount).toBe(2);
    expect(main.webSession).toBeUndefined();
    expect(max2.usage?.resetCredits).toBeUndefined();
    expect(max2.webSession).toBe("expired");
    expect(info.combined?.resetCredits?.availableCount).toBe(2);
    expect(JSON.stringify(info)).not.toContain(SECRET);

    // Claude Code's report with grants of its own: that one shows, and claude.ai is not asked.
    applyPlanRateLimits("main", { ...report, cedar_ember: { grants: [grant("own", 3)] } });
    const asked = requests.length;
    await refreshWebResets([{ id: "main", org: MAIN_ORG, ownResets: true }], Date.now() + WEB_RESETS_POLL_MS);
    expect(requests).toHaveLength(asked);
    expect(claudeAccountsInfo().accounts.find(account => account.id === "main")!.usage?.resetCredits?.availableCount).toBe(3);
  });
});
