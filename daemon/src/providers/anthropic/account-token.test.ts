import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addClaudeAccount,
  CLAUDE_TOKEN_LIFETIME_MS,
  claudeAccountEnv,
  claudeTokenExpiresAt,
  claudeTokenSecretName,
  getClaudeAccount,
  listClaudeAccounts,
  removeClaudeAccount,
  setClaudeAccountToken,
  setClaudeAccountsFileForTests,
  type ClaudeAccountToken,
} from "./accounts";
import {
  claudeTokenDaysLeft,
  claudeTokenEnv,
  claudeTokenRejection,
  loadClaudeToken,
  noteClaudeTokenRejected,
  probeClaudeToken,
  setClaudeTokenDepsForTests,
  TOKEN_REJECTION_RECHECK_MS,
  usableClaudeToken,
} from "./account-token";
import { claudeAccountAuthStatus } from "./auth-cache";
import { claudeProcessOptions, isSubscriptionAuth } from "./cli";
import {
  clearUsage,
  getAccountLimitedUntil,
  getAccountUsage,
  probeTokenAccountUsage,
  refreshAccountUsage,
  setPlanReportForTests,
  TOKEN_FABLE_PROBE_INTERVAL_MS,
  TOKEN_USAGE_PROBE_INTERVAL_MS,
} from "./usage";
import type { ClaudeAuthStatus } from "./types";

const ORG = "3b095dd6-0000-4000-8000-000000000001";
const OTHER_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const MINTED = "2026-11-13T16:24:00.000Z";
const TOKEN: ClaudeAccountToken = { secret: "CLAUDE_SETUP_TOKEN_MAX2", mintedAt: MINTED, email: "max2@example.com", orgId: ORG, orgName: "Max Two", subscriptionType: "max" };
// Ahead of now: a limit whose reset has passed is no longer a limit.
const RESET = Math.floor(Date.now() / 1000) + 3 * 86_400;

let dir: string;
let mainDir: string;
let accountDir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

interface Sent { model: string; authorization: string; beta: string; system: string; maxTokens: number }
type Answer = Response | Error;

/** A fake secrets store and Anthropic: every request is recorded and answered by `answer`. */
function fakeAnthropic(secrets: Record<string, string | null>, answer: (sent: Sent) => Answer): { sent: Sent[]; secrets: Record<string, string | null> } {
  const sent: Sent[] = [];
  setClaudeTokenDepsForTests({
    secret: async name => secrets[name] ?? null,
    claudeVersion: async () => "2.1.321",
    fetch: async (_url, init) => {
      const headers = init.headers as Record<string, string>;
      const body = JSON.parse(String(init.body)) as { model: string; max_tokens: number; system: Array<{ text: string }> };
      const request = { model: body.model, authorization: headers.authorization!, beta: headers["anthropic-beta"]!, system: body.system[0]!.text, maxTokens: body.max_tokens };
      sent.push(request);
      const result = answer(request);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { sent, secrets };
}

function taken(extra: Record<string, string> = {}, status = 200, org = ORG): Response {
  return new Response("{}", {
    status,
    headers: {
      "anthropic-organization-id": org,
      "anthropic-ratelimit-unified-status": status === 429 ? "rejected" : "allowed",
      "anthropic-ratelimit-unified-reset": String(RESET),
      "anthropic-ratelimit-unified-representative-claim": "seven_day",
      "anthropic-ratelimit-unified-7d-utilization": status === 429 ? "1" : "0.9",
      "anthropic-ratelimit-unified-7d-reset": String(RESET),
      "anthropic-ratelimit-unified-7d-status": status === 429 ? "rejected" : "allowed",
      ...extra,
    },
  });
}

function refused(status = 401, type = "authentication_error"): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message: "OAuth token has expired" } }), { status, headers: { "anthropic-organization-id": ORG } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-claude-token-"));
  mainDir = join(dir, "main-claude");
  accountDir = join(dir, "claude-max2");
  mkdirSync(join(mainDir, "projects"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = mainDir;
  setClaudeAccountsFileForTests(join(dir, "accounts.json"));
  addClaudeAccount("max2", accountDir);
  clearUsage();
});

afterEach(() => {
  setClaudeTokenDepsForTests(null);
  setPlanReportForTests(null);
  setClaudeAccountsFileForTests(null);
  clearUsage();
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("a Claude account's long-lived token in the registry", () => {
  test("any account, main included, can name a token; the others stay as they were", () => {
    setClaudeAccountToken("max2", TOKEN);
    setClaudeAccountToken("main", { secret: "CLAUDE_SETUP_TOKEN_MAIN", mintedAt: MINTED });
    expect(listClaudeAccounts()).toEqual([
      { id: "main", configDir: mainDir, token: { secret: "CLAUDE_SETUP_TOKEN_MAIN", mintedAt: MINTED } },
      expect.objectContaining({ id: "max2", configDir: accountDir, token: TOKEN }),
    ]);
    // The file holds the secret's name, never a value.
    expect(readFileSync(join(dir, "accounts.json"), "utf-8")).not.toContain("sk-ant");
    // The token changes nothing about which directory the account's processes start in.
    expect(claudeAccountEnv("max2")).toEqual({ CLAUDE_CONFIG_DIR: accountDir });
    expect(claudeAccountEnv("main")).toEqual({});
    expect(claudeTokenSecretName("max-2")).toBe("CLAUDE_SETUP_TOKEN_MAX_2");
    expect(claudeTokenExpiresAt(TOKEN)).toBe(Date.parse(MINTED) + CLAUDE_TOKEN_LIFETIME_MS);
  });

  test("adding and removing accounts keeps the other tokens; a removed account's goes with it", () => {
    setClaudeAccountToken("max2", TOKEN);
    setClaudeAccountToken("main", { secret: "CLAUDE_SETUP_TOKEN_MAIN", mintedAt: MINTED });
    addClaudeAccount("max3", join(dir, "claude-max3"));
    expect(getClaudeAccount("max2")?.token).toEqual(TOKEN);
    removeClaudeAccount("max2");
    expect(getClaudeAccount("main")?.token?.secret).toBe("CLAUDE_SETUP_TOKEN_MAIN");
    addClaudeAccount("max2", accountDir);
    expect(getClaudeAccount("max2")?.token).toBeUndefined();
  });

  test("a token can be taken away again, and needs a secret name and a mint date", () => {
    setClaudeAccountToken("max2", TOKEN);
    setClaudeAccountToken("max2", null);
    expect(getClaudeAccount("max2")?.token).toBeUndefined();
    expect(() => setClaudeAccountToken("max2", { secret: "not a name", mintedAt: MINTED })).toThrow();
    expect(() => setClaudeAccountToken("max2", { secret: "OK_NAME", mintedAt: "soon" })).toThrow();
    expect(() => setClaudeAccountToken("nobody", TOKEN)).toThrow("Unknown Claude account");
  });

  test("the owner is told in the last month of the token's year", () => {
    setClaudeAccountToken("max2", TOKEN);
    const end = claudeTokenExpiresAt(TOKEN);
    expect(claudeTokenDaysLeft("max2", end - 200 * 86_400_000)).toBeNull();
    expect(claudeTokenDaysLeft("max2", end - 12 * 86_400_000 - 1)).toBe(12);
    expect(claudeTokenDaysLeft("max2", end + 86_400_000)).toBe(-1);
    expect(claudeTokenDaysLeft("main")).toBeNull();
  });
});

describe("asking Anthropic about a token", () => {
  test("one 1-token request that opens as Claude Code does, signed with the token", async () => {
    setClaudeAccountToken("max2", TOKEN);
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    const probe = await probeClaudeToken("max2");
    expect(probe).toMatchObject({ outcome: "ok", status: 200, orgId: ORG });
    expect(sent).toEqual([{ model: "claude-haiku-5-5", authorization: "Bearer tok-max2", beta: "oauth-2025-04-20", system: "You are Claude Code, Anthropic's official CLI for Claude.", maxTokens: 1 }]);
    expect((await probeClaudeToken("max2", { fable: true })).outcome).toBe("ok");
    expect(sent[1]!.model).toBe("claude-fable-5-2");
  });

  test("a refused token is set aside and not asked about again until the secret changes or a while passes", async () => {
    setClaudeAccountToken("max2", TOKEN);
    const { sent, secrets } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-old" }, request => request.authorization === "Bearer tok-old" ? refused() : taken());
    const now = 1_800_000_000_000;
    expect(await probeClaudeToken("max2", { now })).toEqual({ outcome: "rejected", detail: "HTTP 401 OAuth token has expired" });
    expect(await probeClaudeToken("max2", { now: now + 60_000 })).toMatchObject({ outcome: "rejected" });
    expect(sent).toHaveLength(1);
    expect(usableClaudeToken("max2", now + 60_000)).toBeNull();
    expect(await loadClaudeToken("max2", { now: now + 60_000 })).toBeNull();
    expect(claudeTokenRejection("max2", now + 60_000)?.detail).toContain("401");
    // The same token is asked about again after the recheck time.
    expect((await probeClaudeToken("max2", { now: now + TOKEN_REJECTION_RECHECK_MS + 1 })).outcome).toBe("rejected");
    expect(sent).toHaveLength(2);
    // A new token in the secret is tried at once.
    secrets.CLAUDE_SETUP_TOKEN_MAX2 = "tok-new";
    expect((await probeClaudeToken("max2", { now: now + TOKEN_REJECTION_RECHECK_MS + 2 })).outcome).toBe("ok");
    expect(sent.at(-1)!.authorization).toBe("Bearer tok-new");
    expect(usableClaudeToken("max2", now + TOKEN_REJECTION_RECHECK_MS + 3)).toBe("tok-new");
  });

  test("a token of another organization than the account's is refused here", async () => {
    setClaudeAccountToken("max2", TOKEN);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-main" }, () => taken({}, 200, OTHER_ORG));
    expect(await probeClaudeToken("max2")).toEqual({ outcome: "rejected", detail: "it belongs to another organization than the account's" });
    expect(usableClaudeToken("max2")).toBeNull();
  });

  test("no answer either way leaves the token in use; a request the plan refuses was still let in", async () => {
    setClaudeAccountToken("max2", TOKEN);
    let answer: Answer = new Error("network down");
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => answer);
    expect(await probeClaudeToken("max2")).toEqual({ outcome: "unknown", detail: "network down" });
    answer = new Response("overloaded", { status: 529 });
    expect((await probeClaudeToken("max2")).outcome).toBe("unknown");
    // Anthropic answers a request that does not open as Claude Code with a bare 429: not a refusal of the token.
    answer = new Response("{}", { status: 429 });
    expect((await probeClaudeToken("max2")).outcome).toBe("unknown");
    expect(usableClaudeToken("max2")).toBe("tok-max2");
    answer = taken({}, 429);
    expect(await probeClaudeToken("max2")).toMatchObject({ outcome: "ok", status: 429 });
    // A scope refusal names the token.
    answer = refused(403, "permission_error");
    expect((await probeClaudeToken("max2")).outcome).toBe("rejected");
  });

  test("without a readable secret, or without a token, nothing is sent", async () => {
    const { sent } = fakeAnthropic({}, () => taken());
    expect((await probeClaudeToken("max2")).outcome).toBe("no_token");
    setClaudeAccountToken("max2", TOKEN);
    expect(await probeClaudeToken("max2")).toEqual({ outcome: "no_token", detail: "CLAUDE_SETUP_TOKEN_MAX2 is not in the secrets store" });
    expect(sent).toHaveLength(0);
    expect(claudeTokenEnv("max2")).toEqual({});
  });
});

describe("Claude Code processes of a token account", () => {
  test("run on the token, in the account's directory; other accounts and other billing never get it", async () => {
    setClaudeAccountToken("max2", TOKEN);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    expect(await loadClaudeToken("max2")).toBe("tok-max2");
    const env = claudeProcessOptions(dir, "max2").env!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-max2");
    expect(env.CLAUDE_CONFIG_DIR).toBe(accountDir);
    expect(claudeProcessOptions(dir, "main").env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // The plan's usage report is the login's to read.
    const login = claudeProcessOptions(dir, "max2", undefined, null, { token: false }).env!;
    expect(login.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(login.CLAUDE_CONFIG_DIR).toBe(accountDir);
  });

  test("go back to the account's own login once the token is refused", async () => {
    setClaudeAccountToken("max2", TOKEN);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    await loadClaudeToken("max2");
    noteClaudeTokenRejected("max2", "HTTP 401 from Anthropic");
    const env = claudeProcessOptions(dir, "max2").env!;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(accountDir);
  });
});

describe("the sign-in check of a token account", () => {
  const LOGIN: ClaudeAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "max2@example.com", orgId: ORG, subscriptionType: "max" };
  const loginProbe = (status: ClaudeAuthStatus) => {
    const calls: string[] = [];
    return { calls, probe: async (account: string) => { calls.push(account); return status; } };
  };

  test("a token Anthropic takes is a subscription sign-in, with the owner recorded with it", async () => {
    setClaudeAccountToken("max2", TOKEN);
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    const login = loginProbe({ loggedIn: false });
    const status = await claudeAccountAuthStatus("max2", undefined, login.probe);
    expect(status).toEqual({ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", email: "max2@example.com", orgId: ORG, orgName: "Max Two", subscriptionType: "max" });
    expect(isSubscriptionAuth(status)).toBe(true);
    // The login in the directory is not consulted, and the check's answer filled in the account's usage.
    expect(login.calls).toEqual([]);
    expect(getAccountUsage("max2")?.sevenDay).toEqual({ utilization: 90, resetsAt: RESET * 1000 });
    // The Fable allowance is asked for too, without the check waiting for it.
    for (let tries = 0; tries < 50 && sent.length < 2; tries += 1) await Bun.sleep(1);
    expect(sent.map(request => request.model)).toEqual(["claude-haiku-5-5", "claude-fable-5-2"]);
  });

  test("a refused token leaves the account on its own login, or signed out without one", async () => {
    setClaudeAccountToken("max2", TOKEN);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => refused());
    const alive = await claudeAccountAuthStatus("max2", undefined, loginProbe(LOGIN).probe);
    expect(alive).toEqual({ ...LOGIN, tokenProblem: "HTTP 401 OAuth token has expired" });
    expect(isSubscriptionAuth(alive)).toBe(true);
    const ended = await claudeAccountAuthStatus("max2", undefined, loginProbe({ loggedIn: false, authMethod: "none" }).probe);
    expect(ended.loggedIn).toBe(false);
    expect(isSubscriptionAuth(ended)).toBe(false);
  });

  test("an account without a token is checked by its login alone, as before", async () => {
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    const login = loginProbe(LOGIN);
    expect(await claudeAccountAuthStatus("max2", undefined, login.probe)).toEqual(LOGIN);
    expect(login.calls).toEqual(["max2"]);
    expect(sent).toHaveLength(0);
  });

  test("network trouble does not sign a token account out", async () => {
    setClaudeAccountToken("max2", TOKEN);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => new Error("network down"));
    const status = await claudeAccountAuthStatus("max2", undefined, loginProbe({ loggedIn: false }).probe);
    expect(status).toMatchObject({ loggedIn: true, authMethod: "oauth_token", orgId: ORG });
  });
});

describe("the usage of a token account", () => {
  const withLogin = (endsAt: number) => {
    mkdirSync(accountDir, { recursive: true });
    writeFileSync(join(accountDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: endsAt } }));
  };

  test("without a login to report it, comes from the headers of a 1-token request, the Fable allowance from one on Fable", async () => {
    setClaudeAccountToken("max2", TOKEN);
    const reports: string[] = [];
    setPlanReportForTests(async (account) => { reports.push(account); return null; });
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, request => request.model === "claude-fable-5-2"
      ? taken({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.66", "anthropic-ratelimit-unified-7d_oi-reset": String(RESET), "anthropic-ratelimit-unified-7d_oi-status": "allowed" })
      : taken({ "anthropic-ratelimit-unified-5h-utilization": "0.12", "anthropic-ratelimit-unified-5h-reset": String(RESET - 86_400) }));
    const usage = await refreshAccountUsage("max2");
    expect(usage?.sevenDay).toEqual({ utilization: 90, resetsAt: RESET * 1000 });
    expect(usage?.fiveHour).toEqual({ utilization: 12, resetsAt: (RESET - 86_400) * 1000 });
    expect(usage?.fable).toMatchObject({ utilization: 66, resetsAt: RESET * 1000 });
    // No login file in the directory: the login is not asked at all.
    expect(reports).toEqual([]);
    expect(sent.map(request => request.model)).toEqual(["claude-haiku-5-5", "claude-fable-5-2"]);
    // Asked again only after the interval, and the Fable allowance less often.
    await refreshAccountUsage("max2");
    expect(sent).toHaveLength(2);
    const later = Date.now() + TOKEN_USAGE_PROBE_INTERVAL_MS + 1;
    await probeTokenAccountUsage("max2", { now: later });
    expect(sent.map(request => request.model)).toEqual(["claude-haiku-5-5", "claude-fable-5-2", "claude-haiku-5-5"]);
    await probeTokenAccountUsage("max2", { now: later + TOKEN_FABLE_PROBE_INTERVAL_MS });
    expect(sent.slice(3).map(request => request.model)).toEqual(["claude-haiku-5-5", "claude-fable-5-2"]);
  });

  test("while its login lasts, is the login's full report, and no request is sent", async () => {
    setClaudeAccountToken("max2", TOKEN);
    withLogin(Date.now() + 86_400_000);
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    setPlanReportForTests(async () => ({ five_hour: null, seven_day: { utilization: 41, resets_at: "2026-11-14T03:00:00+00:00" } }));
    const usage = await refreshAccountUsage("max2");
    expect(usage).toMatchObject({ sevenDay: { utilization: 41 }, noFiveHourLimit: true });
    expect(sent).toHaveLength(0);
  });

  test("falls back to the token once the login reports nothing or has ended", async () => {
    setClaudeAccountToken("max2", TOKEN);
    withLogin(Date.now() + 86_400_000);
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    let reports = 0;
    setPlanReportForTests(async () => { reports += 1; return null; });
    expect((await refreshAccountUsage("max2"))?.sevenDay?.utilization).toBe(90);
    expect(reports).toBe(1);
    expect(sent.length).toBeGreaterThan(0);
    // The login that gave nothing is not asked again right away.
    await refreshAccountUsage("max2");
    expect(reports).toBe(1);

    setPlanReportForTests(async () => { reports += 1; return null; });
    withLogin(Date.now() - 1000);
    await refreshAccountUsage("max2");
    expect(reports).toBe(1);
  });

  test("a request the plan refuses puts the account at its usage limit", async () => {
    setClaudeAccountToken("max2", TOKEN);
    setPlanReportForTests(async () => null);
    fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken({}, 429));
    await refreshAccountUsage("max2");
    expect(getAccountUsage("max2")?.sevenDay?.utilization).toBe(100);
    expect(getAccountLimitedUntil("max2")).toBe(RESET * 1000);
  });

  test("an account without a token asks its login only", async () => {
    const { sent } = fakeAnthropic({ CLAUDE_SETUP_TOKEN_MAX2: "tok-max2" }, () => taken());
    setPlanReportForTests(async () => ({ five_hour: null, seven_day: { utilization: 7, resets_at: "2026-11-14T03:00:00+00:00" } }));
    expect((await refreshAccountUsage("max2"))?.sevenDay?.utilization).toBe(7);
    expect(sent).toHaveLength(0);
  });
});
