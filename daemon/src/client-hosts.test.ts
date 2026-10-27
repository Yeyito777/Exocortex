import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientHostInfo, Event } from "@exocortex/shared/protocol";
import {
  attachClientHost, attachedClientHost, attachedClientHostVia, clientExecAlive, resetClientHostsForTest, runOnClientHost,
  setClientExecLivenessForTest, settleClientExec, type AttachClientHostOptions,
} from "./client-hosts";
import type { ConnectedClient } from "./server";
import { getRegisteredTools } from "./tools/registry";
import { LineSplitter } from "./line-splitter";

// Through the registry: client-bash → conversations → registry would otherwise
// reach the registry before client_bash is defined.
const clientBash = getRegisteredTools().find(tool => tool.name === "client_bash")!;
const laptop: ClientHostInfo = { hostname: "toronto", user: "yeyito", platform: "linux", home: "/home/yeyito" };

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

afterEach(() => resetClientHostsForTest());

describe("client hosts", () => {
  test("fails immediately when no machine is attached", async () => {
    const outcome = await runOnClientHost("conv-1", { command: "ls", timeoutMs: 1_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("The user's machine is not connected") });
  });

  test("prefers the machine's daemon link over its TUI, and falls back to the TUI when the link goes", async () => {
    const tui = attach(laptop, ["conv-1"], { via: "tui", reportsAlive: true });
    await Bun.sleep(2);
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    expect(attachedClientHostVia("conv-1")).toBe("daemon");

    const running = runOnClientHost("conv-1", { command: "echo hi", timeoutMs: 5_000 });
    const request = lastLinkRequest(link.sent);
    expect(request).toMatchObject({ command: "echo hi", timeoutMs: 5_000 });
    expect(tui.sent).toEqual([]);
    settleClientExec(link.client, { type: "provider_proxy_client_exec_result", execId: request.execId, output: "hi\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "hi\n", exitCode: 0 });

    link.close();
    expect(attachedClientHostVia("conv-1")).toBe("tui");
    const viaTui = runOnClientHost("conv-1", { command: "echo again", timeoutMs: 5_000 });
    const tuiRequest = lastRequest(tui.sent);
    settleClientExec(tui.client, { type: "client_exec_result", execId: tuiRequest.execId, output: "again\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await viaTui).toMatchObject({ output: "again\n" });
  });

  test("a link that does not acknowledge a command fails it fast, and the next call skips it", async () => {
    setClientExecLivenessForTest({ ackMs: 30, silenceMs: 80 });
    const tui = attach(laptop, [], { via: "tui", reportsAlive: true });
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const started = Date.now();
    const outcome = await runOnClientHost("conv-1", { command: "echo hi", timeoutMs: 600_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("did not respond within 0s") });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(link.sent.at(-1)).toMatchObject({ type: "provider_proxy_client_exec_cancel" });

    // The stalled link is skipped while the TUI answers.
    expect(attachedClientHostVia()).toBe("tui");
    const next = runOnClientHost("conv-1", { command: "echo hi", timeoutMs: 600_000 });
    const request = lastRequest(tui.sent);
    clientExecAlive(tui.client, [request.execId]);
    settleClientExec(tui.client, { type: "client_exec_result", execId: request.execId, output: "hi\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await next).toMatchObject({ output: "hi\n" });

    // Heard from again: the link is preferred again.
    clientExecAlive(link.client, []);
    expect(attachedClientHostVia()).toBe("daemon");
  });

  test("a long command stays alive on heartbeats, and fails fast when they stop", async () => {
    setClientExecLivenessForTest({ ackMs: 40, silenceMs: 60 });
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const running = runOnClientHost("conv-1", { command: "sleep 100", timeoutMs: 600_000 });
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
    const running = runOnClientHost("conv-1", { command: "sleep 1", timeoutMs: 5_000 });
    await Bun.sleep(50);
    settleClientExec(client, { type: "client_exec_result", execId: lastRequest(sent).execId, output: "done", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "done" });
  });

  test("results from another connection, or of the other kind of connection, are not trusted", async () => {
    const link = attach(laptop, [], { via: "daemon", reportsAlive: true });
    const running = runOnClientHost("conv-1", { command: "id", timeoutMs: 5_000 });
    const { execId } = lastLinkRequest(link.sent);
    settleClientExec(fakeClient().client, { type: "provider_proxy_client_exec_result", execId, output: "forged", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    settleClientExec(link.client, { type: "provider_proxy_client_exec_result", execId, output: "real", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toMatchObject({ output: "real" });
  });

  test("ignores announcements without a usable host", () => {
    const fake = fakeClient();
    attachClientHost(fake.client, { hostname: "" }, () => {});
    attachClientHost(fake.client, null, () => {});
    expect(attachedClientHost()).toBeNull();
  });

  test("sends the request to the attached client and resolves with its result", async () => {
    const { client, sent } = attach();
    const running = runOnClientHost("conv-1", { command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });
    const request = lastRequest(sent);
    expect(request).toMatchObject({ command: "uname -a", cwd: "~/src", timeoutMs: 5_000 });

    // Answers from another connection are not trusted.
    settleClientExec(fakeClient().client, { type: "client_exec_result", execId: request.execId, output: "forged", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    settleClientExec(client, { type: "client_exec_result", execId: request.execId, output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
    expect(await running).toEqual({ host: laptop, output: "Linux toronto\n", byteTruncated: false, exitCode: 0, signal: null, timedOut: false });
  });

  test("prefers a client viewing the conversation, then the most recently attached", async () => {
    const viewing = attach({ ...laptop, hostname: "viewing" }, ["conv-1"]);
    await Bun.sleep(2);
    attach({ ...laptop, hostname: "newer" });
    expect(attachedClientHost("conv-1")?.hostname).toBe("viewing");
    expect(attachedClientHost("conv-2")?.hostname).toBe("newer");
    viewing.close();
    expect(attachedClientHost("conv-1")?.hostname).toBe("newer");
  });

  test("a lost connection fails its pending commands and detaches the host", async () => {
    const fake = attach();
    const running = runOnClientHost("conv-1", { command: "sleep 100", timeoutMs: 100_000 });
    fake.close();
    expect(await running).toEqual({ failure: expect.stringContaining("connection to yeyito@toronto (its TUI over /ssh) was lost") });
    expect(attachedClientHost()).toBeNull();
  });

  test("aborting cancels the command on the client", async () => {
    const { sent } = attach();
    const controller = new AbortController();
    const running = runOnClientHost("conv-1", { command: "sleep 100", timeoutMs: 100_000 }, controller.signal);
    const { execId } = lastRequest(sent);
    controller.abort();
    expect(await running).toEqual({ failure: expect.stringContaining("Interrupted") });
    expect(sent.at(-1)).toEqual({ type: "client_exec_cancel", execId });
  });
});

describe("client_bash tool", () => {
  async function run(input: Record<string, unknown>, result: Record<string, unknown>) {
    const { client, sent } = attach();
    const running = clientBash.execute(input, { conversationId: "conv-1" });
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
    expect(result.output).toBe("Error: command timed out after 2s on yeyito@toronto\npartial");
  });

  test("reports client-side errors", async () => {
    const { result } = await run({ command: "ls", cwd: "/nope" }, { error: "Working directory not found: /nope", exitCode: null });
    expect(result).toMatchObject({ output: "Error on yeyito@toronto: Working directory not found: /nope", isError: true });
  });

  test("errors without a client", async () => {
    const result = await clientBash.execute({ command: "ls" }, { conversationId: "conv-1" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("The user's machine is not connected");
  });
});
