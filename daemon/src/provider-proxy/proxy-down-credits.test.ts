import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// First: reached later through another import, the registry is read before its tools are defined.
import "../tools/registry";
import type { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeExocortexConfig } from "@exocortex/shared/config";
import type { ProviderProxyRemoteStatus } from "@exocortex/shared/provider-proxy";
import type { SshProcess } from "@exocortex/shared/ssh-transport";
import { registerAppConversation, removeAppConversationRecord } from "../app-registry";
import { getLastUsage } from "../usage";
import { apiCreditSwitchNotice, beginApiCreditTurn, conversationOnApiCredits, routeClaudeTurn, setAssignmentsFileForTests } from "../providers/anthropic/account-pool";
import { refreshApiCreditSecrets, setApiCreditSecretsForTests, apiCreditConfig } from "../providers/anthropic/api-credits";
import { claudeProxyFallbackInMs, claudeUsageAvailability } from "../providers/anthropic/availability";
import { claudeProcessOptions } from "../providers/anthropic/cli";
import { claudeSessionKey } from "../providers/anthropic/session";
import { ProviderProxyManager } from "./manager";
import { providerProxyRoute, resetProviderProxyRoutesForTest, setProxiedUsage } from "./route";
import { fakeSsh, loggedIn, stubAuth } from "./testing";

/** A fake ssh whose connection fails right after it starts, unless `up()`. */
function failingSsh(stderr = "", code = 255, up: () => boolean = () => false): () => SshProcess {
  const ssh = fakeSsh({ deps: { auth: stubAuth() } });
  return () => {
    const process = ssh.spawn();
    if (!up()) {
      queueMicrotask(() => {
        if (stderr) (process.stderr as unknown as NodeJS.WritableStream).write(`${stderr}\n`);
        (process as unknown as EventEmitter).emit("close", code, null);
      });
    }
    return process;
  };
}

const KEY = "ANTHROPIC_API_KEY_VM_ONE";
const KEY_VALUE = "not-a-real-key-value";
const fallback = (whenProxyDown?: { afterSeconds?: number }) => ({
  enabled: true, keys: [{ secret: KEY, label: "vm one" }], ...(whenProxyDown ? { whenProxyDown } : {}),
});

let dir = "";
const managers: ProviderProxyManager[] = [];

function makeManager(spawnProcess: () => SshProcess): ProviderProxyManager {
  const manager = new ProviderProxyManager({
    spawnProcess,
    readConfig: () => ({ providers: { anthropic: { proxy: { ssh: "whale" } } } }),
    updateConfig: () => {},
    forwarderStateFile: join(dir, "forwarder.json"),
    reconnectDelaysMs: [10],
    helloTimeoutMs: 2_000,
    remoteRecheckMs: 20,
  });
  managers.push(manager);
  manager.start();
  return manager;
}

/** A proxied manager whose link has never come up; `downFor` sets how long ago it went down. */
async function downManager(error = "ssh: connect to host whale port 22: Connection refused", code = 255) {
  const manager = makeManager(failingSsh(error, code));
  for (let i = 0; i < 200 && !manager.linkFor("anthropic")?.message; i++) await Bun.sleep(2);
  return { manager, downFor: (ms: number) => { manager.linkFor("anthropic")!.downSince = Date.now() - ms; } };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "exo-proxy-down-"));
  setAssignmentsFileForTests(join(dir, "assignments.json"));
  setApiCreditSecretsForTests({
    names: async () => [KEY],
    value: async () => KEY_VALUE,
    helperCommand: name => `/bin/secrets run --allow ${name} -- printenv ${name}`,
  }, join(dir, "credit-state.json"));
  await refreshApiCreditSecrets({ force: true });
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  resetProviderProxyRoutesForTest();
  writeExocortexConfig({});
  setApiCreditSecretsForTests(null);
  setAssignmentsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("the config", () => {
  test("is off unless set; a bad delay is the default; a disabled fallback turns it off", () => {
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback() } } });
    expect(apiCreditConfig().proxyDownAfterMs).toBeNull();
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback({}) } } });
    expect(apiCreditConfig().proxyDownAfterMs).toBe(60_000);
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback({ afterSeconds: 15 }) } } });
    expect(apiCreditConfig().proxyDownAfterMs).toBe(15_000);
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback({ afterSeconds: -1 }) } } });
    expect(apiCreditConfig().proxyDownAfterMs).toBe(60_000);
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { ...fallback({}), enabled: false } } } });
    expect(apiCreditConfig().proxyDownAfterMs).toBeNull();
  });
});

describe("without whenProxyDown", () => {
  test("a proxied provider stays on its link however long it has been down, even with keys configured", async () => {
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback() } } });
    const { manager, downFor } = await downManager();
    downFor(3_600_000);
    expect(await routeClaudeTurn("conv", null)).toEqual({ account: "main", reason: "new", detail: "single account", apiCredit: null });
    expect(claudeProxyFallbackInMs("conv")).toBeNull();
    expect(manager.list()[0].apiCredits).toBeUndefined();
    expect(getLastUsage("anthropic")?.apiCredits).toBeUndefined();
    const env = claudeProcessOptions("/tmp", "main", "conv", null).env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe(providerProxyRoute("anthropic")!.baseUrl);
  });
});

describe("with whenProxyDown", () => {
  beforeEach(() => {
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback({ afterSeconds: 30 }) } } });
  });

  test("a connected link keeps every turn on the proxy", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const manager = makeManager(ssh.spawn);
    await manager.ready("anthropic");
    expect((await routeClaudeTurn("conv", null)).apiCredit).toBeNull();
    expect(claudeProxyFallbackInMs("conv")).toBeNull();
    expect(manager.list()[0].apiCredits).toEqual({ afterSeconds: 30, active: false, label: "vm one" });
  });

  test("a brief outage stays on the link; past the delay the turn runs on the key", async () => {
    const { manager, downFor } = await downManager();
    downFor(5_000);
    expect((await routeClaudeTurn("conv", null)).apiCredit).toBeNull();
    const left = claudeProxyFallbackInMs("conv")!;
    expect(left).toBeGreaterThan(20_000);
    expect(left).toBeLessThanOrEqual(25_000);
    expect(manager.list()[0].apiCredits?.active).toBe(false);

    downFor(31_000);
    const route = await routeClaudeTurn("conv", null);
    expect(route.apiCredit?.id).toBe(KEY);
    expect(route.proxyDownAlias).toBe("whale");
    expect(claudeProxyFallbackInMs("conv")).toBe(0);
    expect(manager.list()[0].apiCredits).toEqual({ afterSeconds: 30, active: true, label: "vm one" });
  });

  test("the turn runs directly on the key: no forwarder address or token, and the key only behind its helper", async () => {
    const { downFor } = await downManager();
    downFor(31_000);
    const route = await routeClaudeTurn("conv", null);
    const options = claudeProcessOptions("/tmp", route.account, "conv", route.apiCredit);
    const env = options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(options.settings).toEqual({ apiKeyHelper: `/bin/secrets run --allow ${KEY} -- printenv ${KEY}` });
    expect(JSON.stringify(options)).not.toContain(KEY_VALUE);
    // The running process is told apart from the proxied one, so moving either way starts a new one.
    expect(claudeSessionKey("m", "low", "/w", null, "main", KEY)).not.toBe(claudeSessionKey("m", "low", "/w", "whale", "main", undefined));
  });

  test("a helper request falls back too, unless the conversation it is for may not use credits", async () => {
    const { downFor } = await downManager();
    downFor(31_000);
    expect((await routeClaudeTurn(undefined, null)).apiCredit?.id).toBe(KEY);
    registerAppConversation({ convId: "app-never", app: "batch", lifetime: "ephemeral", createdAt: 0, lastActivityAt: 0, system: { text: "", base: "none" }, builtin: [], appTools: [], route: { credits: "never" } });
    try {
      expect((await routeClaudeTurn(undefined, null, undefined, null, "app-never")).apiCredit).toBeNull();
    } finally {
      removeAppConversationRecord("app-never");
    }
  });

  test("a conversation with credits never stays on the link", async () => {
    const { downFor } = await downManager();
    downFor(3_600_000);
    registerAppConversation({ convId: "app-never", app: "batch", lifetime: "ephemeral", createdAt: 0, lastActivityAt: 0, system: { text: "", base: "none" }, builtin: [], appTools: [], route: { credits: "never" } });
    try {
      expect((await routeClaudeTurn("app-never", null)).apiCredit).toBeNull();
      expect(claudeProxyFallbackInMs("app-never")).toBeNull();
      expect(claudeUsageAvailability(Date.now(), { apiCredits: false }).ready).toBe(true);
    } finally {
      removeAppConversationRecord("app-never");
    }
  });

  test("no usable key: the turn waits for the link as before", async () => {
    setApiCreditSecretsForTests({ names: async () => [], value: async () => null, helperCommand: () => null }, join(dir, "credit-state.json"));
    await refreshApiCreditSecrets({ force: true });
    const { manager, downFor } = await downManager();
    downFor(3_600_000);
    expect((await routeClaudeTurn("conv", null)).apiCredit).toBeNull();
    expect(claudeProxyFallbackInMs("conv")).toBeNull();
    expect(manager.list()[0].apiCredits).toEqual({ afterSeconds: 30, active: false, label: null });
  });

  test("a process with background tasks keeps how it bills", async () => {
    const { downFor } = await downManager();
    downFor(31_000);
    const onLink = { account: "main", open: true, backgroundWork: true, apiCredit: null };
    expect((await routeClaudeTurn("conv", onLink)).apiCredit).toBeNull();
    const key = { id: KEY, label: "vm one", renewsOnDay: null };
    expect((await routeClaudeTurn("conv", { ...onLink, apiCredit: key })).apiCredit?.id).toBe(KEY);
  });

  test("a failure that will not clear up falls back at once", async () => {
    await downManager("Permission denied (publickey).");
    expect(claudeProxyFallbackInMs("conv")).toBe(0);
    expect((await routeClaudeTurn("conv", null)).apiCredit?.id).toBe(KEY);
  });

  test("a remote that is not logged in falls back at once, and is asked again", async () => {
    let status: ProviderProxyRemoteStatus = { ...loggedIn, loggedIn: false, error: "Claude Code is not signed in." };
    const ssh = fakeSsh({ deps: { auth: stubAuth({ status: async () => status }) } });
    const manager = makeManager(ssh.spawn);
    const link = manager.linkFor("anthropic")!;
    for (let i = 0; i < 200 && link.state !== "connected"; i++) await Bun.sleep(2);
    expect((await routeClaudeTurn("conv", null)).apiCredit?.id).toBe(KEY);
    status = loggedIn;
    for (let i = 0; i < 200 && link.remote.anthropic?.loggedIn !== true; i++) {
      await Bun.sleep(2);
      claudeProxyFallbackInMs("conv");
    }
    expect((await routeClaudeTurn("conv", null)).apiCredit).toBeNull();
  });

  test("the link coming back sends the next turn to the proxy", async () => {
    let up = false;
    const manager = makeManager(failingSsh("", 255, () => up));
    const link = manager.linkFor("anthropic")!;
    for (let i = 0; i < 200 && !link.message; i++) await Bun.sleep(2);
    link.downSince = Date.now() - 31_000;
    expect((await routeClaudeTurn("conv", null)).apiCredit?.id).toBe(KEY);
    up = true;
    for (let i = 0; i < 500 && link.state !== "connected"; i++) await Bun.sleep(2);
    expect(link.downSince).toBeNull();
    expect((await routeClaudeTurn("conv", null)).apiCredit).toBeNull();
    expect(manager.list()[0].apiCredits?.active).toBe(false);
  });

  test("the bars keep the remote's last usage, with the keys' credits while turns run on them", async () => {
    const { manager, downFor } = await downManager();
    setProxiedUsage("anthropic", loggedIn.usage);
    downFor(5_000);
    expect(getLastUsage("anthropic")?.apiCredits).toBeUndefined();
    downFor(31_000);
    const usage = getLastUsage("anthropic");
    expect(usage?.fiveHour?.utilization).toBe(12);
    expect(usage?.apiCredits).toMatchObject({ active: true, ready: true, label: "vm one", balanceUsd: null, pool: null });
    // Without a remote usage to show, the credits still do.
    setProxiedUsage("anthropic", null);
    expect(getLastUsage("anthropic")).toMatchObject({ fiveHour: null, sevenDay: null, apiCredits: { active: true } });
    // A turn still running on a key shows it after the link is back.
    const end = beginApiCreditTurn({ id: KEY, label: "vm one", renewsOnDay: null });
    manager.linkFor("anthropic")!.downSince = Date.now();
    expect(getLastUsage("anthropic")?.apiCredits?.active).toBe(true);
    end();
    expect(getLastUsage("anthropic")?.apiCredits).toBeUndefined();
  });

  test("the keys' notices say why, and the way back names the proxy", async () => {
    const { downFor } = await downManager();
    downFor(31_000);
    const route = await routeClaudeTurn("conv", null);
    expect(apiCreditSwitchNotice("conv", route)).toBe(`Running on Claude API credits ("vm one"): /proxy whale is down.`);
    expect(conversationOnApiCredits("conv")).toBe(true);
    expect(apiCreditSwitchNotice("conv", route)).toBeNull();
    expect(apiCreditSwitchNotice("conv", { account: "main", reason: "new", detail: "", apiCredit: null })).toBe("Back on /proxy whale: it is up again.");
    expect(conversationOnApiCredits("conv")).toBe(false);
  });

  test("the remote's last known limits don't hold a turn that can run on the key", async () => {
    const { downFor } = await downManager();
    downFor(31_000);
    expect(claudeUsageAvailability()).toEqual({ ready: true, resetAt: null });
  });

  test("announces the moment the delay passes, so the bars and /proxy follow", async () => {
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: fallback({ afterSeconds: 0.05 }) } } });
    let actives = 0;
    const manager = makeManager(failingSsh());
    manager.setListeners({ onChange: () => { if (manager.list()[0].apiCredits?.active) actives++; } });
    for (let i = 0; i < 500 && actives === 0; i++) await Bun.sleep(2);
    expect(actives).toBeGreaterThan(0);
  });
});
