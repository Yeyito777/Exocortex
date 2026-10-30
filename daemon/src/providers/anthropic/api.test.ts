import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dataDir } from "@exocortex/shared/paths";
import type { ConversationRouteNotice } from "@exocortex/shared/protocol";
import type { StreamOptions } from "../types";
import { emitProxiedClaudeApiCredits, resetProviderProxyRoutesForTest, setProviderProxyRoute } from "../../provider-proxy/route";
import { conversationOnApiCredits, flushAssignments, setAssignmentsFileForTests, type ClaudeTurnRoute } from "./account-pool";
import { agentTurnOptions, creditSwitchNotices, prunedSessionAlias } from "./api";
import { CLAUDE_SESSION_ALIASES_FILE, claudeProjectDirName, writeClaudeSessionAliases } from "./session-prune";

describe("Claude Code turn options", () => {
  test("disallow Claude Code's own subagent tool and schedulers, leaving delegation to exo and chrono", () => {
    const options = agentTurnOptions(
      "claude-opus-5-5" as never,
      { system: "" } as StreamOptions,
      "/work",
      { pending: [] } as never,
      () => {},
      async () => { throw new Error("unused"); },
      "main",
    );
    expect(options.disallowedTools).toEqual(expect.arrayContaining(["Agent", "Task", "AskUserQuestion", "ScheduleWakeup"]));
  });
});

describe("resuming a pruned session", () => {
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let scratch = "";
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    rmSync(join(dataDir(), CLAUDE_SESSION_ALIASES_FILE), { force: true });
  });

  test("resumes the kept session its alias names, only once its own file is gone", () => {
    scratch = mkdtempSync(join(tmpdir(), "claude-alias-"));
    process.env.CLAUDE_CONFIG_DIR = scratch;
    const cwd = "/work/conversation";
    const dir = join(scratch, "projects", claudeProjectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    mkdirSync(dataDir(), { recursive: true });
    writeClaudeSessionAliases(join(dataDir(), CLAUDE_SESSION_ALIASES_FILE), { old: "kept", gone: "missing" });
    writeFileSync(join(dir, "kept.jsonl"), "");
    const resume = (sessionId: string) => ({ sessionId, resumeAt: "u1", cwd });
    expect(prunedSessionAlias(resume("old"), "main")).toBe("kept");
    // Its alias's file is gone too: nothing to resume from, as before.
    expect(prunedSessionAlias(resume("gone"), "main")).toBeNull();
    // Still on disk: resumed as recorded.
    writeFileSync(join(dir, "old.jsonl"), "");
    expect(prunedSessionAlias(resume("old"), "main")).toBeNull();
  });
});

describe("API-credit switch notices", () => {
  let scratch = "";
  let notices: Array<[string, ConversationRouteNotice | undefined]> = [];
  let billing: string[] = [];
  const callbacks = {
    onProviderNotice: (text: string, route?: ConversationRouteNotice) => { notices.push([text, route]); },
    onBilling: (kind: string) => { billing.push(kind); },
  };
  const subscription: ClaudeTurnRoute = { account: "main", reason: "new", detail: "single account", apiCredit: null };
  const credits: ClaudeTurnRoute = { ...subscription, apiCredit: { id: "KEY_MAIN", label: "main", renewsOnDay: null } };
  /** A daemon restart: what is kept in memory goes, what was saved stays. */
  const restart = () => {
    flushAssignments();
    setAssignmentsFileForTests(join(scratch, "assignments.json"));
  };
  /** One proxied turn whose requests the remote reports as billed so (a label: its API credits; null: a subscription). */
  const proxiedTurn = (convId: string, reports: Array<string | null>) => {
    const stop = creditSwitchNotices(convId, subscription, callbacks);
    for (const label of reports) emitProxiedClaudeApiCredits(convId, label);
    stop();
  };

  afterEach(() => {
    resetProviderProxyRoutesForTest();
    setAssignmentsFileForTests(null);
    notices = [];
    billing = [];
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });
  const setup = (proxied: boolean) => {
    scratch = mkdtempSync(join(tmpdir(), "claude-credit-notices-"));
    setAssignmentsFileForTests(join(scratch, "assignments.json"));
    if (proxied) setProviderProxyRoute("anthropic", { provider: "anthropic", alias: "whale", baseUrl: "http://127.0.0.1:1/anthropic", token: "t" } as never);
  };
  const texts = () => notices.map(([text]) => text);

  test("under /proxy follow the remote's reports, not the local route, so turns on its credits don't flip", () => {
    setup(true);
    proxiedTurn("conv-1", ["main"]);
    expect(texts()).toEqual([`Running on Claude API credits ("main"): every Claude subscription account is at a usage limit.`]);
    expect(notices[0][1]).toEqual({ kind: "api_credits", account: "main", creditKey: "main" });
    expect(billing).toEqual(["api-credits"]);
    // Every later turn routes locally to `main` with no credits, then the remote bills it to its credits again.
    proxiedTurn("conv-1", ["main", "main"]);
    proxiedTurn("conv-1", []);
    proxiedTurn("conv-1", ["main"]);
    expect(texts()).toHaveLength(1);
    expect(conversationOnApiCredits("conv-1")).toBe(true);
  });

  test("under /proxy a report arriving after a short turn ended changes nothing, and the next turn starts quiet", () => {
    setup(true);
    proxiedTurn("conv-1", ["main"]);
    // A request the conversation's process sends after its turn returned (nothing listens any more).
    emitProxiedClaudeApiCredits("conv-1", null);
    emitProxiedClaudeApiCredits("conv-1", "main");
    proxiedTurn("conv-1", []);
    expect(texts()).toHaveLength(1);
  });

  test("under /proxy go back to the subscription once the remote serves the conversation on one", () => {
    setup(true);
    proxiedTurn("conv-1", ["main"]);
    proxiedTurn("conv-1", [null, null]);
    proxiedTurn("conv-1", [null]);
    expect(texts()).toEqual([
      `Running on Claude API credits ("main"): every Claude subscription account is at a usage limit.`,
      `Back on the Claude subscription (account "main"): it has usage again.`,
    ]);
    expect(notices[1][1]).toEqual({ kind: "subscription", account: "main" });
    expect(conversationOnApiCredits("conv-1")).toBe(false);
    // A conversation only ever served on a subscription gets no notice.
    proxiedTurn("conv-2", [null]);
    expect(texts()).toHaveLength(2);
  });

  test("a daemon restart is no switch, under /proxy or not", () => {
    setup(true);
    proxiedTurn("conv-1", ["main"]);
    proxiedTurn("conv-2", [null]);
    restart();
    expect(conversationOnApiCredits("conv-1")).toBe(true);
    proxiedTurn("conv-1", ["main"]);
    proxiedTurn("conv-2", [null]);
    expect(texts()).toHaveLength(1);
    // A real switch across the restart is still told.
    restart();
    proxiedTurn("conv-2", ["main"]);
    expect(texts()).toHaveLength(2);

    resetProviderProxyRoutesForTest();
    notices = [];
    creditSwitchNotices("conv-3", credits, callbacks)();
    restart();
    creditSwitchNotices("conv-3", credits, callbacks)();
    expect(texts()).toEqual([`Running on Claude API credits ("main"): every Claude subscription account is at a usage limit.`]);
    restart();
    creditSwitchNotices("conv-3", subscription, callbacks)();
    expect(texts()).toHaveLength(2);
    expect(texts()[1]).toContain("Back on the Claude subscription");
  });
});
