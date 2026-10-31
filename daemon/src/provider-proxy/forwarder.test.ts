import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PROXY_ACCOUNT_MOVE_HEADER, PROVIDER_PROXY_API_CREDITS_HEADER, PROVIDER_PROXY_CONVERSATION_HEADER, type ProviderProxyAccountMove } from "@exocortex/shared/provider-proxy";
import { ProviderProxyForwarder } from "./forwarder";
import { ProviderProxyLink, ProviderProxyUnavailableError, type ProviderProxyHttpRequest, type ProviderProxyWebSocketHandlers } from "./link";
import { fakeSsh, stubAuth } from "./testing";

interface FakeLink {
  ready: () => Promise<void>;
  /** Fail this many HTTP requests as if the link dropped before the answer. */
  dropRequests?: number;
  requests: ProviderProxyHttpRequest[];
  sockets: Array<{ sent: string[]; handlers: ProviderProxyWebSocketHandlers; closed: boolean }>;
}

function fakeLink(overrides: Partial<FakeLink> = {}): FakeLink {
  const link: FakeLink = { ready: async () => {}, requests: [], sockets: [], ...overrides };
  return Object.assign(link, {
    waitReady: () => link.ready(),
    async openHttp(request: ProviderProxyHttpRequest) {
      link.requests.push(request);
      if (link.dropRequests) {
        link.dropRequests--;
        throw new ProviderProxyUnavailableError("The SSH connection to whale was lost (exit 255).");
      }
      return {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-upstream": "yes" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
            controller.enqueue(new TextEncoder().encode("data: two\n\n"));
            controller.close();
          },
        }),
      };
    },
    async openWebSocket(_request: unknown, handlers: ProviderProxyWebSocketHandlers) {
      const socket = { sent: [] as string[], handlers, closed: false };
      link.sockets.push(socket);
      handlers.onMessage("hello from upstream");
      return { status: 101 as const, headers: { "x-codex-turn-state": "ts-9" }, send: (text: string) => { socket.sent.push(text); handlers.onMessage(`echo:${text}`); }, close: () => { socket.closed = true; } };
    },
  });
}

const dirs: string[] = [];
const forwarders: ProviderProxyForwarder[] = [];
function start(linkFor: (provider: string) => FakeLink | null, stateFile?: string, hold: { linkHoldMs?: number; linkHoldRetryDelaysMs?: number[]; fallbackInMs?: () => number | null } = {}): ProviderProxyForwarder {
  const forwarder = new ProviderProxyForwarder({ linkFor: provider => linkFor(provider) as unknown as ProviderProxyLink | null, ...(stateFile ? { stateFile } : {}), ...hold });
  forwarder.start();
  forwarders.push(forwarder);
  return forwarder;
}

afterEach(() => {
  for (const forwarder of forwarders.splice(0)) forwarder.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a request while the turn has somewhere else to run", () => {
  const post = (forwarder: ProviderProxyForwarder) => fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${forwarder.secret}` } });

  test("is held only until the fallback is due", async () => {
    const down = fakeLink({ ready: async () => { throw new ProviderProxyUnavailableError("The SSH connection to whale was lost (exit 255)."); } });
    const forwarder = start(() => down, undefined, { linkHoldMs: 60_000, linkHoldRetryDelaysMs: [10], fallbackInMs: () => 40 });
    const started = Date.now();
    const response = await post(forwarder);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.text()).toContain("Exocortex /proxy (link down): The SSH connection to whale was lost");
  });

  test("a failure that will not clear up reads as link down, for the turn to move", async () => {
    const down = fakeLink({ ready: async () => { throw new ProviderProxyUnavailableError("Permission denied (publickey).", false); } });
    const forwarder = start(() => down, undefined, { fallbackInMs: () => 0 });
    expect(await (await post(forwarder)).text()).toContain("Exocortex /proxy (link down): Permission denied");
  });

  test("a healthy link is not held to anything", async () => {
    const forwarder = start(() => fakeLink(), undefined, { fallbackInMs: () => null });
    expect((await post(forwarder)).status).toBe(200);
  });
});

describe("provider proxy forwarder", () => {
  test("listens on loopback only and requires its secret", async () => {
    const link = fakeLink();
    const forwarder = start(() => link);
    expect(forwarder.baseUrl("anthropic")).toBe(`http://127.0.0.1:${forwarder.port}/anthropic`);
    const url = `${forwarder.baseUrl("anthropic")}/v1/messages`;
    expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(url, { method: "POST", body: "{}", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const wrongHost = await fetch(url, { method: "POST", body: "{}", headers: { authorization: `Bearer ${forwarder.secret}`, host: "evil.example" } });
    expect(wrongHost.status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${forwarder.port}/deepseek/v1/chat`, { headers: { authorization: `Bearer ${forwarder.secret}` } })).status).toBe(404);
    expect(link.requests).toHaveLength(0);
  });

  test("forwards allowlisted requests without the secret and streams the answer", async () => {
    const link = fakeLink();
    const forwarder = start(() => link);
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages?beta=true`, {
      method: "POST",
      headers: { authorization: `Bearer ${forwarder.secret}`, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: "{\"model\":\"m\"}",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    expect(link.requests).toHaveLength(1);
    const [request] = link.requests;
    expect(request).toMatchObject({ provider: "anthropic", method: "POST", target: "/v1/messages?beta=true" });
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(new TextDecoder().decode(request.body)).toBe("{\"model\":\"m\"}");
  });

  test("accepts the secret as x-api-key too and refuses paths outside the allowlist", async () => {
    const link = fakeLink();
    const forwarder = start(() => link);
    const refused = await fetch(`${forwarder.baseUrl("anthropic")}/v1/files`, { method: "POST", headers: { "x-api-key": forwarder.secret }, body: "{}" });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("not an allowed anthropic http request");
    expect(link.requests).toHaveLength(0);
  });

  test("answers 503 with the reason when the provider is no longer proxied or its link is down", async () => {
    const notProxied = start(() => null);
    const off = await fetch(`${notProxied.baseUrl("openai")}/backend-api/codex/models`, { headers: { authorization: `Bearer ${notProxied.secret}` } });
    expect(off.status).toBe(503);
    expect(await off.text()).toContain("openai is no longer proxied");

    let attempts = 0;
    const down = start(() => fakeLink({ ready: async () => { attempts++; throw new ProviderProxyUnavailableError("The SSH connection to whale was lost (exit 255)."); } }), undefined, { linkHoldMs: 200, linkHoldRetryDelaysMs: [20] });
    const response = await fetch(`${down.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${down.secret}` }, body: "{}" });
    expect(response.status).toBe(503);
    // Held and retried first; then the client is told not to retry by itself: the turn waits instead.
    expect(attempts).toBeGreaterThan(2);
    expect(response.headers.get("x-should-retry")).toBe("false");
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toBe("Exocortex /proxy (link down): The SSH connection to whale was lost (exit 255).");
  });

  test("holds a request through a short link outage and forwards it once the link is back", async () => {
    let attempts = 0;
    const link = fakeLink({ ready: async () => {
      if (++attempts < 3) throw new ProviderProxyUnavailableError("Could not reach the Exocortex daemon on whale over SSH (exit 255): ssh: Could not resolve hostname yeyito.dev: nodename nor servname provided, or not known.");
    } });
    const forwarder = start(() => link, undefined, { linkHoldMs: 5_000, linkHoldRetryDelaysMs: [20] });
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${forwarder.secret}` }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    expect(attempts).toBe(3);
    expect(link.requests).toHaveLength(1);
  });

  test("sends a request again when the link drops before the upstream answers", async () => {
    const link = fakeLink({ dropRequests: 1 });
    const forwarder = start(() => link, undefined, { linkHoldMs: 5_000, linkHoldRetryDelaysMs: [20] });
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${forwarder.secret}` }, body: "{\"model\":\"m\"}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: one\n\ndata: two\n\n");
    expect(link.requests).toHaveLength(2);
    expect(new TextDecoder().decode(link.requests[1].body)).toBe("{\"model\":\"m\"}");
  });

  test("a request held for a down link follows /proxy to another host, or off", async () => {
    let closed = false;
    const down = Object.defineProperty(fakeLink({ ready: async () => {
      throw closed
        ? new ProviderProxyUnavailableError("The /proxy link was closed.", false)
        : new ProviderProxyUnavailableError("ssh: Could not resolve hostname old-host");
    } }), "isClosed", { get: () => closed });
    const up = fakeLink();
    let route: FakeLink | null = down;
    const forwarder = start(() => route, undefined, { linkHoldMs: 5_000, linkHoldRetryDelaysMs: [30] });
    // The user switches /proxy while the request is held; the old link closes at once.
    setTimeout(() => { route = up; closed = true; }, 60);
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${forwarder.secret}` }, body: "{}" });
    expect(response.status).toBe(200);
    expect(up.requests).toHaveLength(1);

    closed = false;
    route = down;
    setTimeout(() => { route = null; closed = true; }, 60);
    const off = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${forwarder.secret}` }, body: "{}" });
    expect(off.status).toBe(503);
    expect(await off.text()).toContain("no longer proxied");
  });

  test("fails at once, without a hold, when the link failure will not clear up", async () => {
    let attempts = 0;
    const forwarder = start(() => fakeLink({ ready: async () => {
      attempts++;
      throw new ProviderProxyUnavailableError("Could not reach the Exocortex daemon on whale over SSH (exit 255): yeyito@whale: Permission denied (publickey).", false);
    } }), undefined, { linkHoldMs: 60_000, linkHoldRetryDelaysMs: [20] });
    const started = Date.now();
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${forwarder.secret}` }, body: "{}" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(attempts).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("false");
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toBe("Exocortex /proxy: Could not reach the Exocortex daemon on whale over SSH (exit 255): yeyito@whale: Permission denied (publickey).");
  });

  test("bridges websockets to the link, passing the handshake headers", async () => {
    const link = fakeLink();
    const forwarder = start(() => link);
    const url = `ws://127.0.0.1:${forwarder.port}/openai/backend-api/codex/responses`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${forwarder.secret}` } } as unknown as string[]);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = (event) => {
        received.push(String(event.data));
        if (received.length === 1) socket.send("{\"type\":\"response.create\"}");
        if (received.length === 2) resolve();
      };
      socket.onerror = () => reject(new Error("websocket failed"));
    });
    expect(received).toEqual(["hello from upstream", "echo:{\"type\":\"response.create\"}"]);
    expect(link.sockets[0].sent).toEqual(["{\"type\":\"response.create\"}"]);
    const closed = new Promise<CloseEvent>(resolve => { socket.onclose = resolve; });
    link.sockets[0].handlers.onClose({ code: 1000 });
    expect((await closed).code).toBe(1000);
  });

  test("keeps its port and secret across restarts, in a private file", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-forwarder-"));
    dirs.push(dir);
    const file = join(dir, "provider-proxy.json");
    const first = start(() => null, file);
    const { port, secret } = first;
    first.stop();
    const second = start(() => null, file);
    expect(second.port).toBe(port);
    expect(second.secret).toBe(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("Claude account moves on the remote", () => {
  test("are taken off the response and reported for the named conversation", async () => {
    const link = fakeLink();
    const move = encodeURIComponent(JSON.stringify({ from: "main", to: "max2", detail: "\"main\" is at a usage limit" }));
    Object.assign(link, {
      async openHttp(request: ProviderProxyHttpRequest) {
        link.requests.push(request);
        return { status: 200, headers: { "content-type": "text/plain", [PROVIDER_PROXY_ACCOUNT_MOVE_HEADER]: move }, body: new Response("ok").body! };
      },
    });
    const moves: Array<[string, ProviderProxyAccountMove]> = [];
    const forwarder = new ProviderProxyForwarder({
      linkFor: () => link as unknown as ProviderProxyLink,
      onAccountMove: (conversation, accountMove) => moves.push([conversation, accountMove]),
    });
    forwarder.start();
    forwarders.push(forwarder);
    const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${forwarder.secret}`, [PROVIDER_PROXY_CONVERSATION_HEADER]: "macbook/conv-1" },
      body: "{}",
    });
    expect(await response.text()).toBe("ok");
    expect(response.headers.get(PROVIDER_PROXY_ACCOUNT_MOVE_HEADER)).toBeNull();
    // The conversation's name goes to the remote, which takes it off before the upstream.
    expect(link.requests[0].headers[PROVIDER_PROXY_CONVERSATION_HEADER]).toBe("macbook/conv-1");
    expect(moves).toEqual([["macbook/conv-1", { from: "main", to: "max2", detail: "\"main\" is at a usage limit" }]]);
  });
});

describe("how the remote billed a conversation's request", () => {
  test("is its API credits with the credits note, a subscription for a Messages answer without it", async () => {
    const link = fakeLink();
    let status = 200;
    let credits: string | null = "main%20key";
    Object.assign(link, {
      async openHttp(request: ProviderProxyHttpRequest) {
        link.requests.push(request);
        return { status, headers: { "content-type": "text/plain", ...(credits ? { [PROVIDER_PROXY_API_CREDITS_HEADER]: credits } : {}) }, body: new Response("ok").body! };
      },
    });
    const reports: Array<[string, string | null]> = [];
    const forwarder = new ProviderProxyForwarder({
      linkFor: () => link as unknown as ProviderProxyLink,
      onApiCredits: (conversation, label) => reports.push([conversation, label]),
    });
    forwarder.start();
    forwarders.push(forwarder);
    const send = async (path: string, conversation = "macbook/conv-1") => {
      const response = await fetch(`${forwarder.baseUrl("anthropic")}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${forwarder.secret}`, ...(conversation ? { [PROVIDER_PROXY_CONVERSATION_HEADER]: conversation } : {}) },
        body: "{}",
      });
      await response.text();
      return response;
    };
    const first = await send("/v1/messages?beta=true");
    expect(first.headers.get(PROVIDER_PROXY_API_CREDITS_HEADER)).toBeNull();
    credits = null;
    await send("/v1/messages?beta=true");
    // Neither a refused request nor a request only a login may make says it ran on a subscription.
    status = 429;
    await send("/v1/messages");
    status = 200;
    await send("/api/oauth/usage");
    // Nor a request of no named conversation.
    await send("/v1/messages", "");
    expect(reports).toEqual([["macbook/conv-1", "main key"], ["macbook/conv-1", null]]);
  });
});

describe("a client that goes away mid-answer", () => {
  test("cancels the remote stream, and the daemon carries on", async () => {
    // Bun's server errors out of the process (an unhandled rejection) if the
    // body it is sending is errored after its client went away.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    let upstreamSignal: AbortSignal | undefined;
    const ssh = fakeSsh({ deps: { auth: stubAuth(), fetch: (async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("data: one\n\n")); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch } });
    const link = new ProviderProxyLink("whale", { providers: () => ["anthropic"], spawnProcess: ssh.spawn, reconnectDelaysMs: [20], helloTimeoutMs: 2_000 });
    try {
      await link.waitReady(2_000);
      const forwarder = new ProviderProxyForwarder({ linkFor: () => link });
      forwarder.start();
      forwarders.push(forwarder);
      const client = new AbortController();
      const response = await fetch(`${forwarder.baseUrl("anthropic")}/v1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${forwarder.secret}` },
        body: "{}",
        signal: client.signal,
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: one\n\n");
      // Claude Code drops its request when its turn is stopped.
      client.abort();
      await reader.read().catch(() => {});
      for (let i = 0; i < 100 && !(upstreamSignal?.aborted && link.activeStreams === 0); i++) await Bun.sleep(5);
      await Bun.sleep(20);
      expect(unhandled.map(String)).toEqual([]);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(link.activeStreams).toBe(0);
      expect(ssh.spawned[0].commands.some(command => command.type === "provider_proxy_cancel")).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      link.close();
    }
  });
});
