import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientHostInfo, Event } from "@exocortex/shared/protocol";
import { hostname } from "node:os";
import { updateExocortexConfig } from "@exocortex/shared/config";
import {
  attachClientHost, clientExecAlive, clientHostNotice, connectedClientHosts, noteUserWroteFrom, restartClientHostsForTest,
  resetClientHostsForTest, runOnClientHost, setClientExecLivenessForTest, settleClientExec, type AttachClientHostOptions,
} from "./client-hosts";
import { appendMessages, create, setSubagentPolicy } from "./conversations";
import { CLIENT_HOST_NOTICE_KIND, announcedHost } from "./messages";
import type { ConnectedClient } from "./server";
import { pendingTurnNotices, turnNoticeMessages, type TurnNoticeState } from "./turn-notices";
import { getRegisteredTools } from "./tools/registry";
import { LineSplitter } from "./line-splitter";

// Through the registry: client-bash → conversations → registry would otherwise
// reach the registry before client_bash is defined.
const clientBash = getRegisteredTools().find(tool => tool.name === "client_bash")!;
const laptop: ClientHostInfo = { hostname: "toronto", user: "yeyito", platform: "linux", home: "/home/yeyito" };
const mac: ClientHostInfo = { hostname: "Aurelios-MacBook-Pro.local", user: "yeyito", platform: "darwin", home: "/Users/yeyito" };
const phone: ClientHostInfo = { hostname: "localhost", user: "root", platform: "linux", home: "/root" };
/** The laptop, named: runOnClientHost runs only on a machine it names (or the announced one). */
const TORONTO = { host: "toronto" };
const via = () => connectedClientHosts()[0]?.via ?? null;

function fakeClient(subscriptions: string[] = []): { client: ConnectedClient; sent: Event[]; close(): void } {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const client = { id: "c", socket, subscriptions: new Set(subscriptions), lines: new LineSplitter(), capabilities: new Set() } as unknown as ConnectedClient;
  const sent: Event[] = [];
  return {
    client,
    sent,
    close() {
      socket.destroyed = true;
      socket.emit("close");
    },
  };
}

function attach(info: ClientHostInfo = laptop, subscriptions: string[] = [], options?: AttachClientHostOptions) {
  const fake = fakeClient(subscriptions);
  attachClientHost(fake.client, info, event => fake.sent.push(event), options);
  return fake;
}

function lastLinkRequest(sent: Event[]) {
  const request = sent.findLast(event => event.type === "provider_proxy_client_exec");
  if (request?.type !== "provider_proxy_client_exec") throw new Error("no provider_proxy_client_exec sent");
  return request;
}

function lastRequest(sent: Event[]) {
  const request = sent.findLast(event => event.type === "client_exec_request");
  if (request?.type !== "client_exec_request") throw new Error(`no client_exec_request sent: ${JSON.stringify(sent)}`);
  return request;
}

function setNames(names: Record<string, string> | undefined): void {
  updateExocortexConfig(config => {
    if (names) config.clientHosts = { names };
    else delete config.clientHosts;
  });
}

afterEach(() => {
  resetClientHostsForTest();
  setNames(undefined);
});

describe("client hosts", () => {
  test("fails immediately when no machine is attached", async () => {
    const outcome = await runOnClientHost({ announced: "toronto" }, { command: "ls", timeoutMs: 1_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("The user's machine is not connected") });
  });

  test("prefers the machine's daemon link over its TUI, and falls back to the TUI when the link goes", async () => {
    const tui = attach(laptop, ["conv-1"], { via: "tui", reportsAlive: true });
    await Bun.sleep(2);
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    expect(via()).toBe("daemon");

    const running = runOnClientHost(TORONTO, { command: "echo hi", timeoutMs: 5_000 });
    const request = lastLinkRequest(link.sent);
    expect(request).toMatchObject({ command: "echo hi", timeoutMs: 5_000 });
    expect(tui.sent).toEqual([]);
    settleClientExec(link.client, { type: "provider_proxy_client_exec_result", execId: request.execId, output: "hi\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "hi\n", exitCode: 0 });

    link.close();
    expect(via()).toBe("tui");
    const viaTui = runOnClientHost(TORONTO, { command: "echo again", timeoutMs: 5_000 });
    const tuiRequest = lastRequest(tui.sent);
    settleClientExec(tui.client, { type: "client_exec_result", execId: tuiRequest.execId, output: "again\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await viaTui).toMatchObject({ output: "again\n" });
  });

  test("a link that does not acknowledge a command fails it fast, and the next call skips it", async () => {
    setClientExecLivenessForTest({ ackMs: 30, silenceMs: 80 });
    const tui = attach(laptop, [], { via: "tui", reportsAlive: true });
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const started = Date.now();
    const outcome = await runOnClientHost(TORONTO, { command: "echo hi", timeoutMs: 600_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("did not respond within 0s") });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(link.sent.at(-1)).toMatchObject({ type: "provider_proxy_client_exec_cancel" });

    // The stalled link is skipped while the TUI answers.
    expect(via()).toBe("tui");
    const next = runOnClientHost(TORONTO, { command: "echo hi", timeoutMs: 600_000 });
    const request = lastRequest(tui.sent);
    clientExecAlive(tui.client, [request.execId]);
    settleClientExec(tui.client, { type: "client_exec_result", execId: request.execId, output: "hi\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await next).toMatchObject({ output: "hi\n" });

    // Heard from again: the link is preferred again.
    clientExecAlive(link.client, []);
    expect(via()).toBe("daemon");
  });

  test("a long command stays alive on heartbeats, and fails fast when they stop", async () => {
    setClientExecLivenessForTest({ ackMs: 40, silenceMs: 60 });
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const running = runOnClientHost(TORONTO, { command: "sleep 100", timeoutMs: 600_000 });
    const { execId } = lastLinkRequest(link.sent);
    let settled = false;
    void running.then(() => { settled = true; });
    for (let i = 0; i < 6; i++) {
      clientExecAlive(link.client, [execId]);
      await Bun.sleep(30);
    }
    expect(settled).toBe(false);
    expect(await running).toEqual({ failure: expect.stringContaining("stopped responding while the command ran") });
  });

  test("hosts without heartbeats (older TUIs) wait for the result as before", async () => {
    setClientExecLivenessForTest({ ackMs: 10, silenceMs: 10 });
    const { client, sent } = attach();
    const running = runOnClientHost(TORONTO, { command: "sleep 1", timeoutMs: 5_000 });
    await Bun.sleep(50);
    settleClientExec(client, { type: "client_exec_result", execId: lastRequest(sent).execId, output: "done", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "done" });
  });

  test("results from another connection, or of the other kind of connection, are not trusted", async () => {
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const running = runOnClientHost(TORONTO, { command: "id", timeoutMs: 5_000 });
    const { execId } = lastLinkRequest(link.sent);
    settleClientExec(fakeClient().client, { type: "provider_proxy_client_exec_result", execId, output: "forged", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    settleClientExec(link.client, { type: "provider_proxy_client_exec_result", execId, output: "real", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "real" });
  });

  test("ignores announcements without a usable host", () => {
    const fake = fakeClient();
    attachClientHost(fake.client, { hostname: "" }, () => {});
    attachClientHost(fake.client, null, () => {});
    expect(connectedClientHosts()).toEqual([]);
  });

  test("sends the request to the attached client and resolves with its result", async () => {
    const { client, sent } = attach();
    const running = runOnClientHost(TORONTO, { command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });
    const request = lastRequest(sent);
    expect(request).toMatchObject({ command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });

    // Answers from another connection are not trusted.
    settleClientExec(fakeClient().client, { type: "client_exec_result", execId: request.execId, output: "forged", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    settleClientExec(client, { type: "client_exec_result", execId: request.execId, output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toEqual({ host: laptop, clientId: "toronto", output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
  });

  test("a lost connection fails its pending commands and detaches the host", async () => {
    const fake = attach();
    const running = runOnClientHost(TORONTO, { command: "sleep 100", timeoutMs: 100_000 });
    fake.close();
    expect(await running).toEqual({ failure: expect.stringContaining("connection to toronto (yeyito@toronto, over its TUI over /ssh) was lost") });
    expect(connectedClientHosts()).toEqual([]);
  });

  test("aborting cancels the command on the client", async () => {
    const { sent } = attach();
    const controller = new AbortController();
    const running = runOnClientHost(TORONTO, { command: "sleep 100", timeoutMs: 100_000 }, controller.signal);
    const { execId } = lastRequest(sent);
    controller.abort();
    expect(await running).toEqual({ failure: expect.stringContaining("Interrupted") });
    expect(sent.at(-1)).toEqual({ type: "client_exec_cancel", execId });
  });
});

describe("client_bash tool", () => {
  async function run(input: Record<string, unknown>, result: Record<string, unknown>) {
    const { client, sent } = attach();
    const running = clientBash.execute({ host: "toronto", ...input }, { conversationId: "conv-1" });
    await Bun.sleep(0);
    settleClientExec(client, {
      type: "client_exec_result", execId: lastRequest(sent).execId,
      output: "", byteTruncated: false, exitCode: 0, signal: null, timedOut: false, ...result,
    });
    return { result: await running, request: lastRequest(sent) };
  }

  test("returns output and reports failing exit codes", async () => {
    expect((await run({ command: "echo hi" }, { output: "hi\n" })).result).toMatchObject({ output: "hi\n", isError: false, exitCode: 0 });
    expect((await run({ command: "false" }, { exitCode: 1 })).result).toMatchObject({ output: "\n(exit code 1)", isError: true });
  });

  test("passes cwd and timeout, and reports a timeout on the client", async () => {
    const { result, request } = await run({ command: "sleep 9", cwd: "/tmp", timeout_seconds: 2 }, {
      output: "partial", timedOut: true, signal: "SIGTERM", exitCode: null,
    });
    expect(request).toMatchObject({ cwd: "/tmp", timeoutMs: 2_000 });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("Error: command timed out after 2s on toronto (yeyito@toronto)\npartial");
  });

  test("reports client-side errors", async () => {
    const { result } = await run({ command: "ls", cwd: "/nope" }, { error: "Working directory not found: /nope", exitCode: null });
    expect(result).toMatchObject({ output: "Error on toronto (yeyito@toronto): Working directory not found: /nope", isError: true });
  });

  test("errors without a client", async () => {
    const result = await clientBash.execute({ command: "ls" }, { conversationId: "conv-1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("The user's machine is not connected");
  });
});

/** Run `ls` for a target; which fake got the request, or the failure. Nothing may reach the others. */
async function runsOn(target: Parameters<typeof runOnClientHost>[0], fakes: Record<string, { client: ConnectedClient; sent: Event[] }>): Promise<string> {
  const before = new Map(Object.entries(fakes).map(([name, fake]) => [name, fake.sent.length]));
  const running = runOnClientHost(target, { command: "ls", timeoutMs: 5_000 });
  const reached = Object.entries(fakes).filter(([name, fake]) => fake.sent.length > before.get(name)!);
  expect(reached.length).toBeLessThanOrEqual(1);
  if (reached.length === 0) {
    const outcome = await running;
    if (!("failure" in outcome)) throw new Error("ran nowhere but did not fail");
    return outcome.failure;
  }
  const [name, fake] = reached[0];
  const request = fake.sent.at(-1)!;
  if (!("execId" in request)) throw new Error(`unexpected ${request.type}`);
  const type = request.type === "client_exec_request" ? "client_exec_result" : "provider_proxy_client_exec_result";
  settleClientExec(fake.client, { type, execId: request.execId, output: "", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
  await running;
  return name;
}

describe("client IDs", () => {
  test("come from the platform or hostname, numbered when taken", () => {
    attach(mac, [], { via: "daemon" });
    attach(phone, [], { via: "daemon" });
    attach(laptop);
    attach({ ...mac, hostname: "Office-iMac.local" });
    attach({ ...phone, hostname: "192.168.1.20" });
    expect(connectedClientHosts().map(host => [host.id, `${host.info.user}@${host.info.hostname}`])).toEqual([
      ["linux", "root@localhost"],
      ["linux-2", "root@192.168.1.20"],
      ["mac", "yeyito@Aurelios-MacBook-Pro.local"],
      ["mac-2", "yeyito@Office-iMac.local"],
      ["toronto", "yeyito@toronto"],
    ]);
  });

  test("stay the same across reconnects and restarts, whatever order machines attach in", () => {
    const first = attach(mac, [], { via: "daemon" });
    attach({ ...mac, hostname: "Office-iMac.local" });
    first.close();
    attach(mac, [], { via: "tui" });
    expect(connectedClientHosts().map(host => host.id)).toEqual(["mac", "mac-2"]);

    // A restart: the IDs are read back from client-hosts.json.
    restartClientHostsForTest();
    attach({ ...mac, hostname: "Office-iMac.local" });
    attach(mac);
    expect(connectedClientHosts().map(host => [host.id, host.info.hostname])).toEqual([["mac", mac.hostname], ["mac-2", "Office-iMac.local"]]);
  });

  test("a configured name wins, matching the hostname in any case, and moves an automatic ID out of its way", () => {
    attach(phone, [], { via: "daemon" });
    attach({ ...laptop, hostname: "phone" });
    expect(connectedClientHosts().map(host => host.id)).toEqual(["linux", "phone"]);
    setNames({ "root@LOCALHOST": "Phone", "yeyito@toronto": "not a valid id!" });
    expect(connectedClientHosts().map(host => [host.id, host.info.hostname])).toEqual([["phone", "localhost"], ["phone-2", "phone"]]);
    // Two machines given one name: the first keeps it.
    setNames({ "root@localhost": "phone", "yeyito@phone": "phone" });
    expect(connectedClientHosts().map(host => host.id)).toEqual(["phone", "phone-2"]);
  });
});

describe("choosing the machine", () => {
  test("with one machine connected, host may be left out only when it is the one the conversation was told about", async () => {
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    expect(await runsOn({ announced: "mac" }, { mac: macLink })).toBe("mac");
    expect(await runsOn({ host: "mac", announced: null }, { mac: macLink })).toBe("mac");
    expect(await runsOn({ announced: null }, { mac: macLink })).toContain('host is needed, as this conversation was not told mac is the only machine connected. Connected now: mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito). Pass host="mac" only if the command is meant for that machine.');
  });

  test("with two connected, host is required and picks exactly that one", async () => {
    setNames({ "root@localhost": "phone" });
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    const macTui = attach(mac, ["conv-1"], { via: "tui", reportsAlive: true });
    await Bun.sleep(2);
    const phoneLink = attach(phone, [], { via: "daemon", reportsAlive: true });
    const fakes = { macLink, macTui, phoneLink };
    for (const announced of [null, "mac", "phone"]) {
      const failure = await runsOn({ announced }, fakes);
      expect(failure).toBe("Several of the user's machines are connected: mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito); phone (root@localhost, Linux, home /root). Nothing was run; pass host with the ID of the machine the command is for.");
    }
    expect(await runsOn({ host: "phone" }, fakes)).toBe("phoneLink");
    expect(await runsOn({ host: "MAC" }, fakes)).toBe("macLink");
    expect(await runsOn({ host: "root@localhost" }, fakes)).toBe("phoneLink");
    expect(await runsOn({ host: "yeyito@aurelios-macbook-pro.local" }, fakes)).toBe("macLink");
  });

  test("an unknown or disconnected machine fails naming the ones connected, and nothing runs elsewhere", async () => {
    setNames({ "root@localhost": "phone" });
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    const phoneLink = attach(phone, [], { via: "daemon", reportsAlive: true });
    expect(await runsOn({ host: "laptop" }, { macLink, phoneLink })).toBe('No machine of the user\'s is called "laptop". Connected: mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito); phone (root@localhost, Linux, home /root). Nothing was run; pass one of those IDs as host only if the command is meant for that machine.');
    // A prefix is not a name.
    expect(await runsOn({ host: "ma" }, { macLink, phoneLink })).toContain('called "ma"');
    macLink.close();
    expect(await runsOn({ host: "mac" }, { phoneLink })).toBe("The user's machine mac is not connected right now. Connected: phone (root@localhost, Linux, home /root). Nothing was run; pass one of those IDs as host only if the command is meant for that machine.");
    phoneLink.close();
    expect(await runsOn({ host: "phone" }, {})).toContain("The user's machine phone is not connected right now. None is connected.");
  });

  test("never falls back: the machine told about goes and another comes, and a call without host runs nowhere", async () => {
    setNames({ "root@localhost": "phone" });
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    const [notice] = [clientHostNotice()!];
    expect(notice.defaultHost).toBe("mac");
    macLink.close();
    const phoneLink = attach(phone, [], { via: "daemon", reportsAlive: true });
    const phoneTui = attach(phone, ["conv-1"], { via: "tui", reportsAlive: true });
    expect(await runsOn({ announced: "mac" }, { phoneLink, phoneTui })).toContain("host is needed, as this conversation was not told phone is the only machine connected. Connected now: phone (root@localhost");
    expect(await runsOn({ host: "phone", announced: "mac" }, { phoneLink, phoneTui })).toBe("phoneLink");
  });
});

describe("what the model is told", () => {
  let n = 0;
  const newId = (name: string) => `hosts-${name}-${process.pid}-${++n}`;
  const lookup = (convs: Record<string, TurnNoticeState>) => (id: string) => convs[id];

  test("a new conversation hears which machine the user is writing from", () => {
    setNames({ "root@localhost": "phone" });
    const macTui = attach(mac, [], { via: "tui", reportsAlive: true });
    attach(mac, [], { via: "daemon", reportsAlive: true });
    attach(phone, [], { via: "daemon", reportsAlive: true });
    noteUserWroteFrom(macTui.client, "conv-1");
    noteUserWroteFrom(fakeClient().client, "conv-1"); // an app or the CLI: not a machine
    const [notice] = pendingTurnNotices({ id: "conv-1", messages: [] });
    expect(notice).toEqual({
      kind: CLIENT_HOST_NOTICE_KIND,
      text: `The user's machines connected now: mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito); phone (root@localhost, Linux, home /root). client_bash needs host set to the ID of the machine a command is for; every other tool still runs on ${hostname()}. The user last wrote here from mac.`,
      metadata: { clientOrigin: "yeyito@Aurelios-MacBook-Pro.local" },
    });
  });

  test("one machine: host may be left out, and the stored notice says for which", () => {
    attach(mac, [], { via: "daemon", reportsAlive: true });
    const [notice] = pendingTurnNotices({ id: "conv-1", messages: [] });
    expect(notice.text).toBe(`The user's machine mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito) is connected. client_bash runs commands there; host may be left out while it is the only one. Every other tool still runs on ${hostname()}.`);
    expect(announcedHost(turnNoticeMessages([notice], "model", 1), CLIENT_HOST_NOTICE_KIND)).toBe("mac");
  });

  test("an ongoing conversation is told again when the user writes from another machine, not when the same one", () => {
    setNames({ "root@localhost": "phone" });
    const macTui = attach(mac, [], { via: "tui" });
    const phoneTui = attach(phone, [], { via: "tui" });
    noteUserWroteFrom(macTui.client, "conv-1");
    const messages = turnNoticeMessages(pendingTurnNotices({ id: "conv-1", messages: [] }), "model", 1);
    noteUserWroteFrom(macTui.client, "conv-1");
    expect(pendingTurnNotices({ id: "conv-1", messages })).toEqual([]);
    noteUserWroteFrom(phoneTui.client, "conv-1");
    const [moved] = pendingTurnNotices({ id: "conv-1", messages });
    expect(moved.text).toEndWith("The user last wrote here from phone.");
    // After a restart the stored notice still says so: nothing new to tell.
    const after = [...messages, ...turnNoticeMessages([moved], "model", 2)];
    restartClientHostsForTest();
    attach(mac, [], { via: "tui" });
    attach(phone, [], { via: "tui" });
    expect(pendingTurnNotices({ id: "conv-1", messages: after })).toEqual([]);
  });

  test("subagents hear where the user last wrote to the conversation that started them, after a restart too", () => {
    setNames({ "root@localhost": "phone" });
    const macTui = attach(mac, [], { via: "tui" });
    attach(phone, [], { via: "daemon" });
    const policy = (parentConversationId: string) => ({ parentConversationId, allowEdits: false, parentSystemInstructions: "" });
    const [parent, child, grandchild] = [newId("parent"), newId("child"), newId("grandchild")];
    noteUserWroteFrom(macTui.client, parent);
    const convs: Record<string, TurnNoticeState> = {};
    convs[parent] = { id: parent, messages: turnNoticeMessages(pendingTurnNotices({ id: parent, messages: [] }), "model", 1) };
    convs[child] = { id: child, messages: [], subagentPolicy: policy(parent) };
    const [childNotice] = pendingTurnNotices({ ...convs[child], conversationById: lookup(convs) });
    expect(childNotice.text).toEndWith("The user last wrote to the conversation that started this task from mac.");
    convs[child] = { ...convs[child], messages: turnNoticeMessages([childNotice], "model", 1) };

    // Restarted: nothing in memory, the stored notices still tell.
    restartClientHostsForTest();
    attach(mac, [], { via: "daemon" });
    attach(phone, [], { via: "daemon" });
    const [grandchildNotice] = pendingTurnNotices({ id: grandchild, messages: [], subagentPolicy: policy(child), conversationById: lookup(convs) });
    expect(grandchildNotice.text).toEndWith("The user last wrote to the conversation that started this task from mac.");
    expect(pendingTurnNotices({ ...convs[child], conversationById: lookup(convs) })).toEqual([]);
  });

  test("the client_bash tool leaves host out for the machine the conversation was told about, and only that one", async () => {
    const convId = newId("tool");
    create(convId, "openai", "gpt-5.4", convId);
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    appendMessages(convId, turnNoticeMessages(pendingTurnNotices({ id: convId, messages: [] }), "gpt-5.4", Date.now()));
    const running = clientBash.execute({ command: "pwd" }, { conversationId: convId });
    await Bun.sleep(0);
    settleClientExec(macLink.client, { type: "provider_proxy_client_exec_result", execId: lastLinkRequest(macLink.sent).execId, output: "/Users/yeyito\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "/Users/yeyito\n", isError: false });

    macLink.close();
    const phoneLink = attach(phone, [], { via: "daemon", reportsAlive: true });
    const refused = await clientBash.execute({ command: "cd ~/Desktop/Exocortex" }, { conversationId: convId });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("Nothing was run: host is needed");
    expect(phoneLink.sent).toEqual([]);
    expect(clientBash.summarize!({ command: "pwd", host: "linux" })).toEqual({ label: "Client linux $", detail: "pwd" });
  });

  test("subagents get the same rule: host required while several are connected", async () => {
    const [parent, child] = [newId("parent"), newId("child")];
    for (const conv of [parent, child]) create(conv, "openai", "gpt-5.4", conv);
    setSubagentPolicy(child, { parentConversationId: parent, allowEdits: false, parentSystemInstructions: "", depth: 1 });
    const macLink = attach(mac, [], { via: "daemon", reportsAlive: true });
    const phoneLink = attach(phone, [], { via: "daemon", reportsAlive: true });
    appendMessages(child, turnNoticeMessages(pendingTurnNotices({ id: child, messages: [] }), "gpt-5.4", Date.now()));
    const refused = await clientBash.execute({ command: "ls" }, { conversationId: child });
    expect(refused.output).toContain("Several of the user's machines are connected");
    expect([macLink.sent, phoneLink.sent]).toEqual([[], []]);
  });
});
