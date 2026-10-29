import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { SshProcess } from "@exocortex/shared/ssh-transport";
import type { ProxyableProviderId } from "@exocortex/shared/provider-proxy";
import { ProviderProxyLink, ProviderProxyUnavailableError } from "./link";
import { UpstreamAuthError } from "./upstream-auth";
import { fakeSsh, loggedIn, stubAuth, type UpstreamCall } from "./testing";

const links: ProviderProxyLink[] = [];
function makeLink(
  spawn: () => SshProcess,
  providers: ProxyableProviderId[] = ["anthropic", "openai"],
  reconnectDelaysMs = [20],
  extra: Partial<ConstructorParameters<typeof ProviderProxyLink>[1]> = {},
): ProviderProxyLink {
  const link = new ProviderProxyLink("whale", { providers: () => providers, spawnProcess: spawn, reconnectDelaysMs, helloTimeoutMs: 2_000, ...extra });
  links.push(link);
  return link;
}

function sseBody(chunks: string[], hold = false): { body: ReadableStream<Uint8Array>; cancelled: () => boolean; finish(): void } {
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      if (!hold) c.close();
    },
    cancel() { cancelled = true; },
  });
  return { body, cancelled: () => cancelled, finish: () => controller.close() };
}

afterEach(() => {
  for (const link of links.splice(0)) link.close();
});

describe("provider proxy link + remote endpoint", () => {
  test("hello reports the remote host and what it can serve", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    expect(link.state).toBe("connected");
    expect(link.host?.hostname).toBeTruthy();
    expect(link.remote.anthropic).toEqual(loggedIn);
    expect(ssh.spawned[0].commands[0]).toMatchObject({ type: "provider_proxy_hello", version: 1, providers: ["anthropic", "openai"] });
  });

  test("an outdated remote fails clearly instead of hanging", async () => {
    const link = makeLink(fakeSsh({ outdated: true }).spawn);
    await expect(link.waitReady(2_000)).rejects.toThrow("does not support /proxy; update Exocortex there");
    expect(link.state).toBe("disconnected");
  });

  test("an unreachable host fails with ssh's own error", async () => {
    const link = makeLink(() => {
      const emitter = new EventEmitter();
      const process = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as SshProcess;
      queueMicrotask(() => {
        (process.stderr as PassThrough).write("ssh: connect to host whale port 22: Connection refused\n");
        setTimeout(() => emitter.emit("close", 255, null), 5);
      });
      return process;
    });
    await expect(link.waitReady(2_000)).rejects.toThrow(/Could not reach the Exocortex daemon on whale over SSH \(exit 255\): ssh: connect to host whale port 22: Connection refused/);
  });

  test("tells failures that may clear up from ones that will not", async () => {
    const failing = (stderr: string, code = 255) => () => {
      const emitter = new EventEmitter();
      const process = Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as SshProcess;
      queueMicrotask(() => {
        (process.stderr as PassThrough).write(`${stderr}\n`);
        setTimeout(() => emitter.emit("close", code, null), 5);
      });
      return process;
    };
    const failure = async (spawn: () => SshProcess) => {
      const link = makeLink(spawn, ["anthropic"], [60_000]);
      const error = await link.waitReady(2_000).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderProxyUnavailableError);
      expect(link.downTransient).toBe((error as ProviderProxyUnavailableError).transient);
      // A request made while it is down says the same.
      expect(await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} }).catch((e: ProviderProxyUnavailableError) => e.transient))
        .toBe((error as ProviderProxyUnavailableError).transient);
      return (error as ProviderProxyUnavailableError).transient;
    };
    expect(await failure(failing("ssh: Could not resolve hostname yeyito.dev: nodename nor servname provided, or not known"))).toBe(true);
    expect(await failure(failing("ssh: connect to host whale port 22: Network is unreachable"))).toBe(true);
    expect(await failure(failing("exocortexd proxy: connect ENOENT /run/user/1000/exocortex/exocortexd.sock", 1))).toBe(true);
    expect(await failure(failing("yeyito@whale: Permission denied (publickey)."))).toBe(false);
    expect(await failure(failing("Host key verification failed."))).toBe(false);
    expect(await failure(failing("zsh:1: command not found: exocortexd", 127))).toBe(false);
    expect(await failure(fakeSsh({ outdated: true }).spawn)).toBe(false);
  });

  test("replaces the link's credentials with the remote's and streams the body through", async () => {
    const calls: UpstreamCall[] = [];
    const auth = stubAuth();
    const ssh = fakeSsh({ deps: { auth, fetch: (async (url: string, init: UpstreamCall["init"]) => {
      calls.push({ url, init });
      return new Response(sseBody(["event: a\ndata: 1\n\n", "event: b\ndata: 2\n\n"]).body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "set-cookie": "__cf_bm=x", "anthropic-ratelimit-unified-5h-utilization": "0.4" },
      });
    }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const response = await link.openHttp({
      provider: "anthropic",
      method: "POST",
      target: "/v1/messages?beta=true",
      headers: { authorization: "Bearer local-secret", cookie: "local=1", "anthropic-version": "2023-06-01" },
      body: new TextEncoder().encode("{\"model\":\"m\"}"),
    });
    expect(response.status).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["anthropic-ratelimit-unified-5h-utilization"]).toBe("0.4");
    expect(await new Response(response.body).text()).toBe("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://anthropic.test/v1/messages?beta=true");
    expect(calls[0].init.headers.authorization).toBe("Bearer remote-anthropic-token");
    expect(calls[0].init.headers.cookie).toBeUndefined();
    expect(calls[0].init.headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].init.redirect).toBe("manual");
    expect(new TextDecoder().decode(calls[0].init.body as Uint8Array)).toBe("{\"model\":\"m\"}");
  });

  test("retries once with refreshed credentials after a 401", async () => {
    const auth = stubAuth();
    let attempts = 0;
    const ssh = fakeSsh({ deps: { auth, fetch: (async () => {
      attempts++;
      return attempts === 1 ? new Response("expired", { status: 401 }) : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const response = await link.openHttp({ provider: "openai", method: "GET", target: "/backend-api/codex/models", headers: {} });
    expect(response.status).toBe(200);
    expect(await new Response(response.body).text()).toBe("ok");
    expect(auth.rejections).toEqual([false, true]);
  });

  test("a remote that cannot authenticate answers 401 with its reason", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth({ headers: async () => { throw new UpstreamAuthError("Claude Code is not signed in on this machine."); } }), fetch: (async () => { throw new Error("must not fetch"); }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} });
    expect(response.status).toBe(401);
    expect(await new Response(response.body).text()).toContain("Claude Code is not signed in on this machine.");
  });

  test("refuses requests outside the allowlist without contacting the upstream", async () => {
    let fetched = false;
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async () => { fetched = true; return new Response("x"); }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    await expect(link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/organizations/keys", headers: {} })).rejects.toThrow("is not an allowed anthropic http request");
    await expect(link.openHttp({ provider: "openai", method: "GET", target: "/backend-api/codex/models/../accounts", headers: {} })).rejects.toThrow("invalid request target");
    expect(fetched).toBe(false);
  });

  test("cancelling the local request aborts the upstream request", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const held = sseBody(["event: a\ndata: 1\n\n"], true);
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Response(held.body, { status: 200 });
    }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const abort = new AbortController();
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} }, abort.signal);
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: a\ndata: 1\n\n");
    abort.abort();
    await expect(reader.read()).rejects.toThrow();
    for (let i = 0; i < 50 && !upstreamSignal?.aborted; i++) await Bun.sleep(5);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(link.activeStreams).toBe(0);
  });

  test("the remote waits for a backed-up connection before sending more", async () => {
    const drain = { needs: true, waiters: [] as Array<() => void> };
    const ssh = fakeSsh({ drain, deps: { auth: stubAuth(), fetch: (async () => new Response(sseBody(["one", "two", "three"]).body)) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} });
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one");
    await Bun.sleep(20);
    expect(drain.waiters).toHaveLength(1);
    drain.needs = false;
    drain.waiters.shift()!();
    const rest: string[] = [];
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest.push(new TextDecoder().decode(chunk.value));
    expect(rest.join("")).toBe("twothree");
  });

  test("a lost link fails streams in flight at once, then reconnects", async () => {
    const held = sseBody(["partial"], true);
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async () => new Response(held.body)) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} });
    const reader = response.body.getReader();
    await reader.read();
    ssh.spawned[0].kill();
    await expect(reader.read()).rejects.toThrow("The SSH connection to whale was lost");
    expect(link.state).toBe("disconnected");
    await expect(link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} })).rejects.toBeInstanceOf(ProviderProxyUnavailableError);
    await link.waitReady(2_000);
    expect(link.state).toBe("connected");
    expect(ssh.spawned).toHaveLength(2);
  });

  test("websocket streams relay messages both ways and retry a 401 handshake", async () => {
    const sent: string[] = [];
    const incoming: Array<{ type: "text"; text: string } | { type: "close"; code?: number }> = [];
    let wake: (() => void) | null = null;
    let handshakes = 0;
    const auth = stubAuth();
    const { OpenAIWebSocketHttpError } = await import("../providers/openai/websocket");
    const ssh = fakeSsh({ deps: {
      auth,
      connectWebSocket: async (url, headers) => {
        handshakes++;
        if (handshakes === 1) throw new OpenAIWebSocketHttpError(401, new Headers(), "expired");
        expect(url).toBe("wss://openai.test/backend-api/codex/responses");
        expect(headers.authorization).toBe("Bearer remote-openai-fresh");
        return {
          headers: new Headers({ "x-codex-turn-state": "ts-1", "set-cookie": "x=1" }),
          socket: {
            async sendText(text: string) {
              sent.push(text);
              incoming.push({ type: "text", text: `echo:${text}` });
              wake?.();
            },
            async nextMessage() {
              while (incoming.length === 0) await new Promise<void>(resolve => { wake = resolve; });
              return incoming.shift()!;
            },
            close() { incoming.push({ type: "close", code: 1000 }); wake?.(); },
          } as never,
        };
      },
    } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const messages: string[] = [];
    let closed: { code?: number } | null = null;
    const opened = await link.openWebSocket({ provider: "openai", target: "/backend-api/codex/responses", headers: { authorization: "Bearer local" } }, {
      onMessage: text => messages.push(text),
      onClose: info => { closed = info; },
    });
    expect(opened.status).toBe(101);
    expect(opened.headers["x-codex-turn-state"]).toBe("ts-1");
    expect(opened.headers["set-cookie"]).toBeUndefined();
    if (!("send" in opened)) throw new Error("not open");
    opened.send("{\"type\":\"response.create\"}");
    for (let i = 0; i < 50 && messages.length === 0; i++) await Bun.sleep(5);
    expect(sent).toEqual(["{\"type\":\"response.create\"}"]);
    expect(messages).toEqual(["echo:{\"type\":\"response.create\"}"]);
    incoming.push({ type: "close", code: 1000 });
    (wake as (() => void) | null)?.();
    for (let i = 0; i < 50 && !closed; i++) await Bun.sleep(5);
    expect(closed).toMatchObject({ code: 1000 });
    expect(auth.rejections).toEqual([false, true]);
  });

  test("a refused websocket handshake comes back as its HTTP status and body", async () => {
    const { OpenAIWebSocketHttpError } = await import("../providers/openai/websocket");
    const ssh = fakeSsh({ deps: { auth: stubAuth(), connectWebSocket: async () => { throw new OpenAIWebSocketHttpError(429, new Headers({ "retry-after": "3" }), "slow down"); } } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const opened = await link.openWebSocket({ provider: "openai", target: "/backend-api/codex/responses", headers: {} }, { onMessage: () => {}, onClose: () => {} });
    expect(opened).toMatchObject({ status: 429, body: "slow down", headers: { "retry-after": "3" } });
  });

  test("status and usage resets are answered by the remote", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth({ status: async (_provider, options) => ({ ...loggedIn, usage: options?.refreshUsage ? { fiveHour: { utilization: 55, resetsAt: null }, sevenDay: null } : null }) }) } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    expect((await link.status("openai", true)).usage?.fiveHour?.utilization).toBe(55);
    expect(link.remote.openai?.usage?.fiveHour?.utilization).toBe(55);
    expect(await link.consumeReset("openai")).toEqual({ outcome: "reset", windowsReset: 1 });
  });

  test("remote_bash runs on the remote, with output caps, timeouts and a clear failure when the link drops", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    const ran = await link.exec({ command: "echo remote-$((40+2))", timeoutMs: 10_000 });
    expect(ran).toMatchObject({ output: "remote-42\n", exitCode: 0, timedOut: false, byteTruncated: false });
    const big = await link.exec({ command: "head -c 1500000 /dev/zero | tr '\\0' x", timeoutMs: 10_000 });
    expect("output" in big && big.output.length).toBe(1_000_000);
    expect(big).toMatchObject({ byteTruncated: true });
    const slow = await link.exec({ command: "sleep 5", timeoutMs: 200 });
    expect(slow).toMatchObject({ timedOut: true });
    const pending = link.exec({ command: "sleep 5", timeoutMs: 10_000 });
    await Bun.sleep(50);
    ssh.spawned[0].kill();
    expect(await pending).toEqual({ failure: expect.stringContaining("The SSH connection to whale was lost") });
  });

  test("remote_bash on a remote that stops answering fails fast instead of waiting out its timeout", async () => {
    // The far end swallows remote_bash commands, like a frozen or half-dead link.
    const ssh = fakeSsh({ deps: { auth: stubAuth() }, unknownCommands: ["provider_proxy_exec"] });
    const link = makeLink(ssh.spawn, undefined, undefined, { execLiveness: { ackMs: 100, silenceMs: 200 } });
    await link.waitReady(2_000);
    expect(link.features).toContain("exec-alive");
    const started = Date.now();
    const outcome = await link.exec({ command: "echo hi", timeoutMs: 600_000 });
    expect(outcome).toEqual({ failure: expect.stringContaining("did not respond within 0s") });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a long remote_bash command stays alive on the remote's heartbeats", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn, undefined, undefined, { execLiveness: { ackMs: 200, silenceMs: 11_000 } });
    await link.waitReady(2_000);
    // Longer than the acknowledgement limit; heartbeats come every 10 s.
    const ran = await link.exec({ command: "sleep 0.4; echo done", timeoutMs: 10_000 });
    expect(ran).toMatchObject({ output: "done\n", exitCode: 0 });
  });

  test("an older remote without exec-alive is waited on as before", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() }, noFeatures: true });
    const link = makeLink(ssh.spawn, undefined, undefined, { execLiveness: { ackMs: 10, silenceMs: 10 } });
    await link.waitReady(2_000);
    expect(await link.exec({ command: "sleep 0.2; echo ok", timeoutMs: 5_000 })).toMatchObject({ output: "ok\n" });
  });
});

describe("a connection that stops moving without dropping", () => {
  const stall = { checkMs: 30, afterMs: 150, minBytes: 4096 };

  test("is dropped and reconnected; requests in flight fail like a dropped connection", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async () => new Response(sseBody(["ok"]).body)) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn, ["anthropic"], [20], { stall });
    await link.waitReady(2_000);
    expect(link.features).toContain("link-ping");
    ssh.spawned[0].freeze();
    const started = Date.now();
    const error = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {}, body: new Uint8Array(64 * 1024) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderProxyUnavailableError);
    expect((error as ProviderProxyUnavailableError).transient).toBe(true);
    expect((error as Error).message).toMatch(/^The SSH connection to whale stalled \(.+; \d+ (B|KB) moved\); reconnecting\.$/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ssh.spawned[0].signals).toEqual(["SIGKILL"]);
    await link.waitReady(2_000);
    expect(ssh.spawned).toHaveLength(2);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} });
    expect(await new Response(response.body).text()).toBe("ok");
  });

  test("an idle link whose remote stops answering pings is reconnected", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn, ["anthropic"], [20], { stall });
    await link.waitReady(2_000);
    await Bun.sleep(100);
    expect(ssh.spawned[0].commands.some(command => command.type === "provider_proxy_ping")).toBe(true);
    expect(ssh.spawned).toHaveLength(1);
    ssh.spawned[0].freeze();
    for (let i = 0; i < 100 && ssh.spawned.length < 2; i++) await Bun.sleep(10);
    expect(ssh.spawned).toHaveLength(2);
    await link.waitReady(2_000);
  });

  test("a busy link is not a stuck one, even while its pings go unanswered", async () => {
    let stop = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (stop) { controller.close(); return; }
        await Bun.sleep(10);
        controller.enqueue(new Uint8Array(2048).fill(120));
      },
    });
    const ssh = fakeSsh({ ignoredCommands: ["provider_proxy_ping"], deps: { auth: stubAuth(), fetch: (async () => new Response(body)) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn, ["anthropic"], [20], { stall });
    await link.waitReady(2_000);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: {} });
    const reader = response.body.getReader();
    let received = 0;
    const until = Date.now() + 600;
    while (Date.now() < until) received += (await reader.read()).value?.length ?? 0;
    // Four times the stall limit, pings unanswered, but data kept coming.
    expect(received).toBeGreaterThan(20_000);
    expect(ssh.spawned).toHaveLength(1);
    expect(link.state).toBe("connected");
    stop = true;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) { /* drain */ }
    // Idle now, and the pings still go unanswered: that is a stall.
    for (let i = 0; i < 100 && ssh.spawned.length < 2; i++) await Bun.sleep(10);
    expect(ssh.spawned).toHaveLength(2);
  });

  test("an older remote without link-ping is not pinged", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() }, noFeatures: true });
    const link = makeLink(ssh.spawn, ["anthropic"], [20], { stall });
    await link.waitReady(2_000);
    await Bun.sleep(300);
    expect(ssh.spawned[0].commands.map(command => command.type)).not.toContain("provider_proxy_ping");
    expect(ssh.spawned).toHaveLength(1);
    expect(link.state).toBe("connected");
  });

  test("large messages go out in slices and arrive whole, multi-byte characters included", async () => {
    const calls: UpstreamCall[] = [];
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async (url: string, init: UpstreamCall["init"]) => {
      calls.push({ url, init });
      return new Response("done");
    }) as unknown as typeof fetch } });
    const link = makeLink(ssh.spawn, ["anthropic"], [20], { stall });
    await link.waitReady(2_000);
    const body = new Uint8Array(1_500_000);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7919) & 0xff;
    const wide = "é€😀".repeat(60_000);
    const response = await link.openHttp({ provider: "anthropic", method: "POST", target: "/v1/messages", headers: { "anthropic-version": "2023-06-01", "x-wide": wide }, body });
    expect(await new Response(response.body).text()).toBe("done");
    const open = ssh.spawned[0].commands.find(command => command.type === "provider_proxy_open") as { headers: Record<string, string> };
    expect(open.headers["x-wide"]).toBe(wide);
    expect(Buffer.from(calls[0].init.body as Uint8Array).equals(Buffer.from(body))).toBe(true);
  });
});

describe("client_bash over the link (the remote runs commands on this machine)", () => {
  function remoteSends(ssh: ReturnType<typeof fakeSsh>, event: Record<string, unknown>): void {
    (ssh.spawned.at(-1)!.process.stdout as PassThrough).write(`${JSON.stringify(event)}\n`);
  }
  async function commandOfType(ssh: ReturnType<typeof fakeSsh>, type: string, execId: string): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const found = ssh.spawned.at(-1)!.commands.find(command => command.type === type && (command.execId === execId || (Array.isArray(command.execIds) && command.execIds.includes(execId))));
      if (found) return found;
      await Bun.sleep(10);
    }
    throw new Error(`no ${type} for ${execId}`);
  }

  test("the hello offers this machine, and the remote's commands run here and answer over the link", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    expect(ssh.spawned[0].commands[0]).toMatchObject({ type: "provider_proxy_hello", clientHost: { hostname: expect.any(String), platform: process.platform } });
    remoteSends(ssh, { type: "provider_proxy_client_exec", execId: "x1", command: "echo mac-$((40+2))", timeoutMs: 5_000 });
    await commandOfType(ssh, "provider_proxy_client_exec_alive", "x1");
    expect(await commandOfType(ssh, "provider_proxy_client_exec_result", "x1")).toMatchObject({ output: "mac-42\n", exitCode: 0, timedOut: false });
  });

  test("clientHost: null offers nothing", async () => {
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn, undefined, undefined, { clientHost: null });
    await link.waitReady(2_000);
    expect(ssh.spawned[0].commands[0]).not.toHaveProperty("clientHost");
  });

  test("the remote can cancel a command, and a lost link stops the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "client-exec-link-"));
    const ssh = fakeSsh({ deps: { auth: stubAuth() } });
    const link = makeLink(ssh.spawn);
    await link.waitReady(2_000);
    remoteSends(ssh, { type: "provider_proxy_client_exec", execId: "c1", command: "sleep 30", timeoutMs: 60_000 });
    await commandOfType(ssh, "provider_proxy_client_exec_alive", "c1");
    remoteSends(ssh, { type: "provider_proxy_client_exec_cancel", execId: "c1" });
    expect(await commandOfType(ssh, "provider_proxy_client_exec_result", "c1")).toMatchObject({ signal: "SIGTERM" });

    const marker = join(dir, "ran");
    remoteSends(ssh, { type: "provider_proxy_client_exec", execId: "c2", command: `sleep 0.5; touch ${marker}`, timeoutMs: 60_000 });
    await commandOfType(ssh, "provider_proxy_client_exec_alive", "c2");
    ssh.spawned[0].kill();
    await Bun.sleep(900);
    expect(existsSync(marker)).toBe(false);
  });
});
