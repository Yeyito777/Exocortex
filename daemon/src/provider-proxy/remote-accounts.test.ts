import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExocortexConfig } from "@exocortex/shared/config";
import type { ProviderProxyLinkEvent, ProviderProxyRemoteAccounts } from "@exocortex/shared/provider-proxy";
import type { SshProcess } from "@exocortex/shared/ssh-transport";
import type { ClaudeAccountInfo, ClaudeAccountsInfo, ErrorEvent } from "@exocortex/shared/protocol";
import type { UsageData } from "../messages";
import { DEFAULT_ROUTING_POLICY } from "../providers/anthropic/routing";
import { aggregateUsage, CLAUDE_RATE_LIMIT_HEADER } from "../providers/anthropic/usage";
import { getLastUsage, handleUsageHeaders } from "../usage";
import { ProviderProxyEndpoint } from "./endpoint";
import { ProviderProxyManager, setActiveProviderProxyManager } from "./manager";
import { mergeRemoteAccounts, type RemoteAccountsSource } from "./remote-accounts";
import { proxiedConversationName, resetProviderProxyRoutesForTest } from "./route";
import { claudeProcessOptions } from "../providers/anthropic/cli";
import { fakeSsh, loggedIn, stubAuth } from "./testing";

const HOUR = 3_600_000;
const now = Date.now();

function usage(fiveHour: number, weekly: number, fiveHourReset = now + 2 * HOUR, weeklyReset = now + 48 * HOUR): UsageData {
  return { fiveHour: { utilization: fiveHour, resetsAt: fiveHourReset }, sevenDay: { utilization: weekly, resetsAt: weeklyReset } };
}

function account(id: string, extra: Partial<ClaudeAccountInfo> = {}): ClaudeAccountInfo {
  return {
    id, email: `${id}@example.com`, plan: "max", configDir: `~/.claude-${id}`, state: "ready", stateDetail: null,
    limitedUntil: null, blockedUntil: null, usage: null, usageUpdatedAt: null, activeTurns: 0, conversations: [],
    loginCommand: null, ...extra,
  };
}

function pool(accounts: ClaudeAccountInfo[]): ProviderProxyRemoteAccounts {
  return {
    proxied: false,
    accounts,
    combined: aggregateUsage(accounts.filter(entry => entry.state === "ready" || entry.state === "limited").map(entry => entry.usage)),
    routing: { ...DEFAULT_ROUTING_POLICY },
    nextNewWork: { account: "max2", detail: "soonest weekly reset" },
  };
}

/** A remote pool the test changes, as the remote's account events would. */
function fakeSource(initial: ProviderProxyRemoteAccounts | null) {
  let current = initial;
  const listeners = new Set<() => void>();
  const source: RemoteAccountsSource = {
    snapshot: () => current,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    source,
    listeners,
    set(next: ProviderProxyRemoteAccounts | null) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

const managers: ProviderProxyManager[] = [];
const dirs: string[] = [];

function makeManager(spawnProcess: (alias: string) => SshProcess) {
  const dir = mkdtempSync(join(tmpdir(), "exocortex-proxy-accounts-"));
  dirs.push(dir);
  let config: ExocortexConfig = {};
  let accountChanges = 0;
  const manager = new ProviderProxyManager({
    spawnProcess,
    readConfig: () => structuredClone(config),
    updateConfig: (mutator) => { const next = structuredClone(config); mutator(next); config = next; },
    forwarderStateFile: join(dir, "forwarder.json"),
    reconnectDelaysMs: [20],
    helloTimeoutMs: 2_000,
    onAccountsChange: () => { accountChanges += 1; },
  });
  managers.push(manager);
  setActiveProviderProxyManager(manager);
  manager.start();
  return { manager, accountChanges: () => accountChanges };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  setActiveProviderProxyManager(null);
  resetProviderProxyRoutesForTest();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the remote's Claude pool over /proxy", () => {
  test("is watched once Claude goes through the link: the bars combine it and follow its updates", async () => {
    const remote = fakeSource(pool([
      account("main", { usage: usage(88, 99) }),
      account("max2", { usage: usage(10, 20, now + 4 * HOUR, now + 96 * HOUR) }),
    ]));
    const ssh = fakeSsh({ deps: { auth: stubAuth(), accounts: remote.source } });
    const { manager, accountChanges } = makeManager(ssh.spawn);
    await manager.set("anthropic", "whale");
    await until(() => manager.remoteAccounts() !== null);
    expect(ssh.spawned[0].commands.find(command => command.type === "provider_proxy_accounts")).toMatchObject({ provider: "anthropic", watch: true });
    // The remote is asked to check its accounts' sign-ins and usage once the pool arrives.
    await until(() => ssh.spawned[0].commands.some(command => command.type === "provider_proxy_status" && command.refreshUsage === true));
    expect(manager.remoteAccounts()?.remote).toMatchObject({ alias: "whale", state: "connected" });
    expect(getLastUsage("anthropic")).toMatchObject({
      capacity: 200,
      fiveHour: { utilization: 98, resets: [now + 2 * HOUR, now + 4 * HOUR] },
      sevenDay: { utilization: 119 },
    });

    remote.set(pool([
      account("main", { usage: usage(88, 99), activeTurns: 1 }),
      account("max2", { usage: usage(30, 20, now + 4 * HOUR, now + 96 * HOUR) }),
    ]));
    await until(() => getLastUsage("anthropic")?.fiveHour?.utilization === 118);
    expect(accountChanges()).toBeGreaterThan(0);
    expect(manager.remoteAccounts()?.pool.accounts[0].activeTurns).toBe(1);

    // A proxied turn's own rate-limit event (its account unknown here) shows the pool's bars, not that account alone.
    const updates: Array<UsageData> = [];
    handleUsageHeaders("anthropic", new Headers({
      [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: (now + 2 * HOUR) / 1000 }, seven_day: { utilization: 0.995, resetsAt: (now + 48 * HOUR) / 1000 } },
      }),
    }), update => updates.push(update));
    expect(updates.at(-1)).toMatchObject({ capacity: 200, fiveHour: { utilization: 118 } });

    // Identical snapshots are not pushed again.
    const received = accountChanges();
    remote.set(remote.source.snapshot());
    await Bun.sleep(350);
    expect(accountChanges()).toBe(received);
  });

  test("keeps the last pool while the link is down, with the link's state, and watches again after reconnecting", async () => {
    const remote = fakeSource(pool([account("main", { usage: usage(50, 50) }), account("max2", { usage: usage(0, 0) })]));
    const ssh = fakeSsh({ deps: { auth: stubAuth(), accounts: remote.source } });
    const { manager } = makeManager(ssh.spawn);
    await manager.set("anthropic", "whale");
    await until(() => manager.remoteAccounts() !== null);
    ssh.spawned[0].kill();
    expect(manager.remoteAccounts()?.remote.state).not.toBe("connected");
    expect(manager.remoteAccounts()?.pool.accounts).toHaveLength(2);
    expect(getLastUsage("anthropic")?.capacity).toBe(200);
    await until(() => ssh.spawned.length === 2 && manager.remoteAccounts()?.remote.state === "connected");
    await until(() => ssh.spawned[1].commands.some(command => command.type === "provider_proxy_accounts"));
    expect(remote.listeners.size).toBe(1);

    manager.off("anthropic");
    expect(manager.remoteAccounts()).toBeNull();
  });

  test("Claude Code names its conversation to a remote that routes across its pool, and only to one", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth(), accounts: fakeSource(pool([account("main"), account("max2")])).source } });
    const { manager } = makeManager(ssh.spawn);
    await manager.set("anthropic", "whale");
    const env = claudeProcessOptions("/tmp", undefined, "conv-1").env as Record<string, string>;
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(`x-exocortex-proxy-conversation: ${proxiedConversationName("conv-1")}`);
    // Helper requests carry no conversation.
    expect((claudeProcessOptions("/tmp").env as Record<string, string>).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("an older remote without provider_proxy_accounts falls back to its main account's bars", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() }, unknownCommands: ["provider_proxy_accounts"], noFeatures: true });
    const { manager } = makeManager(ssh.spawn);
    await manager.set("anthropic", "whale");
    await until(() => ssh.spawned[0].commands.some(command => command.type === "provider_proxy_accounts"));
    await Bun.sleep(20);
    expect(manager.remoteAccounts()).toBeNull();
    expect(getLastUsage("anthropic")).toEqual(loggedIn.usage);
    expect(manager.list()[0]).toMatchObject({ state: "connected", remoteLoggedIn: true });
    // Nothing it would pass on to the upstream as an unknown header.
    expect((claudeProcessOptions("/tmp", undefined, "conv-1").env as Record<string, string>).ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
  });

  test("a remote that proxies Claude itself shares no pool", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth(), accounts: fakeSource(null).source } });
    const { manager } = makeManager(ssh.spawn);
    await manager.set("anthropic", "whale");
    await until(() => ssh.spawned[0].commands.some(command => command.type === "provider_proxy_accounts"));
    await Bun.sleep(20);
    expect(manager.remoteAccounts()).toBeNull();
    expect(getLastUsage("anthropic")).toEqual(loggedIn.usage);
  });
});

describe("the remote endpoint's provider_proxy_accounts", () => {
  test("answers, pushes changes while watched, and stops on unwatch or close", async () => {
    const sent: Array<ProviderProxyLinkEvent | ErrorEvent> = [];
    const remote = fakeSource(pool([account("main")]));
    const endpoint = new ProviderProxyEndpoint({ send: event => { sent.push(event); }, needsDrain: () => false, waitDrain: async () => {} }, { accounts: remote.source });
    endpoint.handle({ type: "provider_proxy_accounts", reqId: "a", provider: "anthropic", watch: true });
    expect(sent[0]).toMatchObject({ type: "provider_proxy_accounts_result", reqId: "a", accounts: { accounts: [{ id: "main" }] } });
    remote.set(pool([account("main"), account("max2")]));
    remote.set(pool([account("main"), account("max2", { activeTurns: 1 })]));
    await until(() => sent.length === 2);
    expect(sent[1]).toMatchObject({ type: "provider_proxy_accounts_update", accounts: { accounts: [{ id: "main" }, { id: "max2", activeTurns: 1 }] } });

    endpoint.handle({ type: "provider_proxy_accounts", reqId: "b", provider: "anthropic", watch: false });
    expect(remote.listeners.size).toBe(0);
    endpoint.handle({ type: "provider_proxy_accounts", reqId: "c", provider: "anthropic", watch: true });
    expect(remote.listeners.size).toBe(1);
    endpoint.close();
    expect(remote.listeners.size).toBe(0);

    const bare = new ProviderProxyEndpoint({ send: event => { sent.push(event); }, needsDrain: () => false, waitDrain: async () => {} });
    bare.handle({ type: "provider_proxy_accounts", reqId: "d", provider: "anthropic", watch: true });
    expect(sent.at(-1)).toMatchObject({ type: "provider_proxy_accounts_result", reqId: "d", accounts: null });
    bare.handle({ type: "provider_proxy_accounts", reqId: "e", provider: "openai" as "anthropic" });
    expect(sent.at(-1)).toMatchObject({ type: "error", reqId: "e" });
  });
});

describe("presenting the remote's pool here", () => {
  test("this machine's conversations are found by their name on the remote; the pool's routing is this machine's", () => {
    const local: ClaudeAccountsInfo = {
      proxied: true,
      accounts: [account("main", { activeTurns: 1, conversations: [{ convId: "local-1", lastUsedAt: now - 1_000, running: true, warm: true }] })],
      combined: null,
      routing: { ...DEFAULT_ROUTING_POLICY },
      nextNewWork: null,
      currentConversation: { convId: "local-1", account: "main", lastUsedAt: now - 1_000, warm: true },
    };
    const remotePool = pool([
      account("main", { activeTurns: 1, conversations: [{ convId: "remote-1", lastUsedAt: now - 5_000, running: false, warm: true }] }),
      account("max2", { activeTurns: 1, conversations: [{ convId: "proxy:macbook/local-1", lastUsedAt: now - 2_000, running: true, warm: true }] }),
    ]);
    const merged = mergeRemoteAccounts(local, remotePool, { alias: "whale", host: "yeyito@whale", state: "connected" }, "proxy:macbook/");
    expect(merged.proxied).toBe(false);
    expect(merged.remote).toEqual({ alias: "whale", host: "yeyito@whale", state: "connected" });
    expect(merged.accounts.map(entry => [entry.id, entry.activeTurns])).toEqual([["main", 1], ["max2", 1]]);
    expect(merged.accounts[0].conversations).toEqual([{ convId: "remote-1", lastUsedAt: now - 5_000, running: false, warm: true, remote: true }]);
    expect(merged.accounts[1].conversations).toEqual([{ convId: "local-1", lastUsedAt: now - 2_000, running: true, warm: true }]);
    expect(merged.nextNewWork).toEqual(remotePool.nextNewWork);
    expect(merged.currentConversation).toEqual({ convId: "local-1", account: "max2", lastUsedAt: now - 2_000, warm: true });

    // A conversation the remote has not seen (yet) runs on no known account.
    const fresh = mergeRemoteAccounts({ ...local, currentConversation: { convId: "local-9", account: "main", lastUsedAt: null, warm: false } }, remotePool, { alias: "whale", host: null, state: "connected" }, "proxy:macbook/");
    expect(fresh.currentConversation).toEqual({ convId: "local-9", account: null, lastUsedAt: null, warm: false });
  });
});
