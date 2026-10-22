import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ExocortexConfig } from "@exocortex/shared/config";
import type { SshProcess } from "@exocortex/shared/ssh-transport";
import { createModelVisibleSystemNotice, REMOTE_HOST_NOTICE_KIND, type StoredMessage } from "../messages";
import { claudeProcessOptions } from "../providers/anthropic/cli";
import { requireSubscriptionAuth } from "../providers/anthropic/auth";
import { claudeSessionKey } from "../providers/anthropic/session";
import { getCurrentAccountKey, getVerifiedSession } from "../providers/openai/auth";
import { CHATGPT_BASE_URL, OPENAI_CODEX_RESPONSES_URL, OPENAI_CODEX_RESPONSES_WS_URL } from "../providers/openai/constants";
import { hostToolDefs } from "../providers/anthropic/host-tools";
import { exocortexToolName, isClaudeCodeHostTool } from "../tools/claude-code";
import { getConversationToolNames, getToolDefs } from "../tools/registry";
import { remoteBash } from "../tools/remote-bash";
import { pendingTurnNotices, type TurnNotice } from "../turn-notices";
import { getAuthInfo, hasConfiguredCredentials } from "../auth";
import { getLastUsage, handleUsageHeaders } from "../usage";
import { configuredProviderProxies, ProviderProxyManager, setActiveProviderProxyManager } from "./manager";
import { proxiedProviderUrl, providerProxyRoute, resetProviderProxyRoutesForTest } from "./route";
import { fakeSsh, loggedIn, stubAuth } from "./testing";

const managers: ProviderProxyManager[] = [];
const dirs: string[] = [];

function makeManager(spawnProcess: (alias: string) => SshProcess, config: ExocortexConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-proxy-manager-"));
  dirs.push(dir);
  const store = { config };
  const changes: string[] = [];
  const manager = new ProviderProxyManager({
    spawnProcess,
    readConfig: () => structuredClone(store.config),
    updateConfig: (mutator) => { const next = structuredClone(store.config); mutator(next); store.config = next; },
    forwarderStateFile: join(dir, "forwarder.json"),
    reconnectDelaysMs: [20],
    helloTimeoutMs: 2_000,
    onChange: () => changes.push("change"),
    onRouteChange: (provider) => changes.push(`route:${provider}`),
  });
  managers.push(manager);
  setActiveProviderProxyManager(manager);
  manager.start();
  return { manager, store, changes };
}

function unreachable(): SshProcess {
  const emitter = new EventEmitter();
  const process = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as SshProcess;
  setTimeout(() => {
    (process.stderr as PassThrough).write("ssh: Could not resolve hostname nowhere\n");
    emitter.emit("close", 255, null);
  }, 5);
  return process;
}

const told = (...notices: TurnNotice[]): StoredMessage[] => notices.map(notice => createModelVisibleSystemNotice(notice.text, "model", notice.kind, 1));

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  setActiveProviderProxyManager(null);
  resetProviderProxyRoutesForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("/proxy manager", () => {
  test("set verifies the remote, persists the alias and routes the provider through the forwarder", async () => {
    const { manager, store, changes } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    const message = await manager.set("anthropic", "whale");
    expect(message).toContain("Anthropic now goes through whale");
    expect(message).toContain("Conversations, tools and files stay on this machine");
    expect(store.config.providers).toEqual({ anthropic: { proxy: { ssh: "whale" } } });
    const route = providerProxyRoute("anthropic");
    expect(route?.alias).toBe("whale");
    expect(route?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/anthropic$/);
    expect(route?.token.length).toBeGreaterThanOrEqual(32);
    expect(manager.list()).toEqual([expect.objectContaining({ provider: "anthropic", alias: "whale", state: "connected", remoteLoggedIn: true })]);
    expect(changes).toContain("route:anthropic");
    expect(providerProxyRoute("openai")).toBeNull();
  });

  test("set fails clearly and saves nothing when the alias is unreachable", async () => {
    const { manager, store } = makeManager(unreachable);
    await expect(manager.set("openai", "nowhere")).rejects.toThrow(/Could not reach the Exocortex daemon on nowhere over SSH.*Could not resolve hostname nowhere/);
    expect(store.config.providers).toBeUndefined();
    expect(providerProxyRoute("openai")).toBeNull();
    expect(manager.list()).toEqual([]);
  });

  test("set fails when the remote is too old or not logged in", async () => {
    const old = makeManager(fakeSsh({ outdated: true }).spawn);
    await expect(old.manager.set("openai", "whale")).rejects.toThrow("does not support /proxy; update Exocortex there");
    old.manager.stop();

    const loggedOut = makeManager(fakeSsh({ deps: { auth: stubAuth({ status: async () => ({ loggedIn: false, error: "Claude Code is not signed in.", authInfo: null, accountScope: null, usage: null }) }) } }).spawn);
    await expect(loggedOut.manager.set("anthropic", "whale")).rejects.toThrow("whale cannot serve Anthropic: Claude Code is not signed in.");
    expect(loggedOut.store.config.providers).toBeUndefined();
  });

  test("validates the provider and alias", async () => {
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await expect(manager.set("deepseek", "whale")).rejects.toThrow("Only openai and anthropic can go through /proxy.");
    await expect(manager.set("openai", "-oProxyCommand=evil")).rejects.toThrow("SSH alias may contain only");
  });

  test("off removes the route and the saved setting", async () => {
    const { manager, store } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("openai", "whale");
    expect(manager.off("openai")).toBe("OpenAI no longer goes through whale; it uses this machine's own login again.");
    expect(store.config.providers).toBeUndefined();
    expect(providerProxyRoute("openai")).toBeNull();
    expect(manager.off("openai")).toBe("OpenAI is not proxied.");
  });

  test("a saved proxy is routed at start, before its link is up, so it never falls back to the direct API", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const config: ExocortexConfig = { providers: { openai: { proxy: { ssh: "whale" } } as never, anthropic: { proxy: { ssh: "bad alias!" } } as never } };
    expect([...configuredProviderProxies(config)]).toEqual([["openai", "whale"]]);
    const { manager } = makeManager(ssh.spawn, config);
    expect(providerProxyRoute("openai")?.alias).toBe("whale");
    expect(await manager.ready("openai")).toEqual(loggedIn);
  });

  test("ready() rejects with the reason a remote cannot serve the provider", async () => {
    let signedIn = true;
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth({ status: async () => signedIn ? loggedIn : { loggedIn: false, error: "OpenAI is not logged in on this machine.", authInfo: null, accountScope: null, usage: null } }) } }).spawn);
    await manager.set("openai", "whale");
    signedIn = false;
    manager.linkFor("openai")!.remote.openai = { ...loggedIn, loggedIn: false };
    await expect(manager.ready("openai")).rejects.toThrow("whale cannot serve OpenAI through /proxy: OpenAI is not logged in on this machine.");
  });
});

describe("provider wiring under /proxy", () => {
  test("Claude Code talks to the forwarder with its secret, and toggling needs a new process", async () => {
    const before = claudeProcessOptions("/tmp").env ?? {};
    expect(before.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(before.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("anthropic", "whale");
    const route = providerProxyRoute("anthropic")!;
    const env = claudeProcessOptions("/tmp").env ?? {};
    expect(env.ANTHROPIC_BASE_URL).toBe(route.baseUrl);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(route.token);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(claudeSessionKey("m", "high", "/tmp", "whale")).not.toBe(claudeSessionKey("m", "high", "/tmp"));
    expect(claudeSessionKey("m", "high", "/tmp", null)).toBe(JSON.stringify(["m", "high", "/tmp"]));
    expect(await requireSubscriptionAuth()).toMatchObject({ loggedIn: true, authMethod: "claude.ai" });
  });

  test("OpenAI requests go to the forwarder with its secret instead of a local login", async () => {
    expect(proxiedProviderUrl("openai", OPENAI_CODEX_RESPONSES_URL, CHATGPT_BASE_URL)).toBe(OPENAI_CODEX_RESPONSES_URL);
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("openai", "whale");
    const route = providerProxyRoute("openai")!;
    expect(proxiedProviderUrl("openai", OPENAI_CODEX_RESPONSES_URL, CHATGPT_BASE_URL)).toBe(`${route.baseUrl}/backend-api/codex/responses`);
    expect(proxiedProviderUrl("openai", OPENAI_CODEX_RESPONSES_WS_URL, CHATGPT_BASE_URL)).toBe(`${route.baseUrl.replace(/^http/, "ws")}/backend-api/codex/responses`);
    expect(proxiedProviderUrl("openai", "https://auth.openai.com/oauth/token", CHATGPT_BASE_URL)).toBe("https://auth.openai.com/oauth/token");
    const session = await getVerifiedSession();
    expect(session).toEqual({ kind: "chatgpt", accessToken: route.token, accountId: null, accountKey: "proxy:sha256:remote" });
    expect(getCurrentAccountKey()).toBe("proxy:sha256:remote");
    expect(hasConfiguredCredentials("openai")).toBe(true);
    expect(getAuthInfo("openai")).toMatchObject({ configured: true, authenticated: true, source: "proxy:whale" });
  });

  test("usage shown for a proxied provider is the remote account's", async () => {
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("openai", "whale");
    expect(getLastUsage("openai")?.fiveHour?.utilization).toBe(12);
    const updates: number[] = [];
    handleUsageHeaders("openai", new Headers({
      "x-exocortex-openai-account-key": "proxy:sha256:remote",
      "x-codex-primary-used-percent": "64",
      "x-codex-primary-window-minutes": "300",
    }), usage => updates.push(usage.fiveHour?.utilization ?? -1));
    expect(updates).toEqual([64]);
    expect(getLastUsage("openai")?.fiveHour?.utilization).toBe(64);
  });
});

describe("remote_bash", () => {
  test("is offered only to conversations whose provider goes through /proxy", async () => {
    expect(getConversationToolNames("anthropic")).not.toContain("remote_bash");
    expect(getConversationToolNames("openai")).not.toContain("remote_bash");
    expect(getToolDefs().map(tool => tool.name)).not.toContain("remote_bash");
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("anthropic", "whale");
    expect(getConversationToolNames("anthropic")).toContain("remote_bash");
    expect(getConversationToolNames("openai")).not.toContain("remote_bash");
    const defs = getToolDefs(getConversationToolNames("anthropic"), undefined, "anthropic");
    const def = defs.find(tool => tool.name === "remote_bash");
    expect(def?.description).toContain("Run a shell command on whale, the machine this conversation's model is proxied through with /proxy");
    manager.off("anthropic");
    expect(getConversationToolNames("anthropic")).not.toContain("remote_bash");
  });

  test("reaches Claude Code as mcp__exocortex__remote_bash", async () => {
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("anthropic", "whale");
    expect(isClaudeCodeHostTool("remote_bash")).toBe(true);
    expect(exocortexToolName("mcp__exocortex__remote_bash")).toBe("remote_bash");
    const hosted = hostToolDefs(getToolDefs(getConversationToolNames("anthropic"), undefined, "anthropic")).map(def => def.name);
    expect(hosted).toContain("remote_bash");
    expect(hostToolDefs(getToolDefs(getConversationToolNames("openai"), undefined, "openai")).map(def => def.name)).not.toContain("remote_bash");
  });

  test("runs on the proxy's machine, and fails clearly when not proxied or the link is down", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const { manager } = makeManager(ssh.spawn);
    const notProxied = await remoteBash.execute({ command: "echo hi" }, { provider: "openai" });
    expect(notProxied).toMatchObject({ isError: true, output: "Error: remote_bash works only while this conversation's provider goes through /proxy." });
    await manager.set("openai", "whale");
    const ran = await remoteBash.execute({ command: "echo remote; exit 3" }, { provider: "openai" });
    expect(ran.output).toContain("remote");
    expect(ran.output).toContain("(exit code 3)");
    expect(ran.isError).toBe(true);
    const timedOut = await remoteBash.execute({ command: "sleep 5", timeout_seconds: 0.2 }, { provider: "openai" });
    expect(timedOut.output).toMatch(/^Error: command timed out after 0.2s on whale \(/);
    ssh.spawned[0].kill();
    const down = await remoteBash.execute({ command: "echo hi" }, { provider: "openai" });
    expect(down.isError).toBe(true);
    expect(down.output).toMatch(/^Error: (The SSH connection to whale was lost|Still connecting to whale)/);
  });

  test("its availability is announced to the model and withdrawn when the proxy is turned off", async () => {
    const conv = (messages: StoredMessage[] = [], provider = "anthropic") => ({ id: "c1", provider, messages, subagentPolicy: null, goal: null });
    expect(pendingTurnNotices(conv())).toEqual([]);
    const { manager } = makeManager(fakeSsh({ deps: { auth: stubAuth() } }).spawn);
    await manager.set("anthropic", "whale");
    const [announced] = pendingTurnNotices(conv());
    expect(announced.kind).toBe(REMOTE_HOST_NOTICE_KIND);
    expect(announced.text).toContain("runs through /proxy on whale");
    expect(announced.text).toContain("remote_bash runs commands on whale via /proxy");
    expect(pendingTurnNotices(conv(told(announced)))).toEqual([]);
    expect(pendingTurnNotices({ ...conv(), subagentPolicy: { parentConversationId: "p", allowEdits: false, parentSystemInstructions: "" } })).toEqual([]);
    // Switching the conversation to a provider that is not proxied withdraws it.
    expect(pendingTurnNotices(conv(told(announced), "openai"))[0].text).toContain("remote_bash is no longer available");
    manager.off("anthropic");
    const [withdrawn] = pendingTurnNotices(conv(told(announced)));
    expect(withdrawn.text).toContain("remote_bash is no longer available");
    expect(pendingTurnNotices(conv(told(announced, withdrawn)))).toEqual([]);
  });
});
