import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_PROXY_ACCOUNT_MOVE_HEADER, PROVIDER_PROXY_API_CREDITS_HEADER, PROVIDER_PROXY_CONVERSATION_HEADER } from "@exocortex/shared/provider-proxy";
import { writeExocortexConfig } from "@exocortex/shared/config";
import { refreshApiCreditSecrets, setApiCreditSecretsForTests, usableApiCreditKey } from "../providers/anthropic/api-credits";
import { addClaudeAccount, setClaudeAccountsFileForTests } from "../providers/anthropic/accounts";
import { claudeAccountsInfo, getConversationAccount, setAssignmentsFileForTests } from "../providers/anthropic/account-pool";
import { setClaudeAuthProbeForTests } from "../providers/anthropic/auth-cache";
import { applyUsageHeaders, CLAUDE_ACCOUNT_HEADER, CLAUDE_RATE_LIMIT_HEADER, clearUsage, getAccountLimitedUntil, getAccountUsage } from "../providers/anthropic/usage";
import type { ClaudeAuthStatus } from "../providers/anthropic/types";
import { createProxiedClaudeRouter, proxiedConversationKey, rateLimitInfoFromHeaders } from "./claude-routing";
import { ProviderProxyLink } from "./link";
import { fakeSsh, stubAuth, type UpstreamCall } from "./testing";
import { UpstreamAuthError } from "./upstream-auth";

const SIGNED_IN: ClaudeAuthStatus = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" };
const H = 3_600;
let dir: string;
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
const links: ProviderProxyLink[] = [];

/** One account's usage as Claude Code would report it (percent, seconds until reset). */
function report(account: string, fiveHour: number, fiveHourResetIn: number, weekly: number, weeklyResetIn: number): void {
  const now = Math.floor(Date.now() / 1000);
  applyUsageHeaders(new Headers({
    [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify({
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: fiveHour / 100, resetsAt: now + fiveHourResetIn },
        seven_day: { utilization: weekly / 100, resetsAt: now + weeklyResetIn },
      },
    }),
    [CLAUDE_ACCOUNT_HEADER]: account,
  }));
}

/** Upstream rate-limit headers as api.anthropic.com sends them. */
function limiterHeaders(status: string, fiveHour: number, weekly: number, extra: Record<string, string> = {}): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  return {
    "anthropic-ratelimit-unified-status": status,
    "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
    "anthropic-ratelimit-unified-5h-reset": String(now + 2 * H),
    "anthropic-ratelimit-unified-7d-utilization": String(weekly),
    "anthropic-ratelimit-unified-7d-reset": String(now + 72 * H),
    ...extra,
  };
}

interface Upstream { calls: UpstreamCall[]; answer: (account: string, call: number) => Response }

/** A link to a real endpoint that routes with the real pool, an upstream that names the account it saw. */
async function proxied(upstream: Upstream, authOverrides: Parameters<typeof stubAuth>[0] = {}) {
  const auth = stubAuth({
    async headers(_provider, _url, options) {
      return { authorization: `Bearer token-${options.account ?? "main"}` };
    },
    ...authOverrides,
  });
  const ssh = fakeSsh({
    deps: {
      auth,
      claudeRouter: createProxiedClaudeRouter(),
      fetch: (async (url: string, init: UpstreamCall["init"]) => {
        upstream.calls.push({ url, init });
        const account = init.headers.authorization.replace("Bearer token-", "");
        return upstream.answer(account, upstream.calls.length);
      }) as unknown as typeof fetch,
    },
  });
  const link = new ProviderProxyLink("whale", { providers: () => ["anthropic"], spawnProcess: ssh.spawn, reconnectDelaysMs: [20], helloTimeoutMs: 2_000 });
  links.push(link);
  await link.waitReady(2_000);
  const send = async (conversation: string | null) => {
    const response = await link.openHttp({
      provider: "anthropic",
      method: "POST",
      target: "/v1/messages",
      headers: conversation ? { [PROVIDER_PROXY_CONVERSATION_HEADER]: conversation } : {},
      body: new TextEncoder().encode("{}"),
    });
    return { status: response.status, text: await new Response(response.body).text(), headers: response.headers };
  };
  return { send, link };
}

const ok = (account: string, fiveHour = 0.2, weekly = 0.3) => new Response(`served by ${account}`, { status: 200, headers: limiterHeaders("allowed", fiveHour, weekly) });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-proxied-routing-"));
  mkdirSync(join(dir, "main"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = join(dir, "main");
  setClaudeAccountsFileForTests(join(dir, "accounts.json"));
  setAssignmentsFileForTests(join(dir, "assignments.json"));
  setClaudeAuthProbeForTests(async () => SIGNED_IN);
  addClaudeAccount("max2", join(dir, "max2"));
  clearUsage();
});

afterEach(() => {
  for (const link of links.splice(0)) link.close();
  clearUsage();
  setClaudeAuthProbeForTests(null);
  setAssignmentsFileForTests(null);
  setClaudeAccountsFileForTests(null);
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("proxied Claude requests are routed across the remote's pool", () => {
  test("new work skips an account past its floor, and the conversation name never reaches the upstream", async () => {
    // main is nearly out of weekly capacity; max2 has room.
    report("main", 30, 2 * H, 97, 30 * H);
    report("max2", 10, 3 * H, 20, 96 * H);
    const upstream: Upstream = { calls: [], answer: account => ok(account) };
    const { send } = await proxied(upstream);
    expect(await send("macbook/conv-1")).toMatchObject({ status: 200, text: "served by max2" });
    expect(upstream.calls[0].init.headers[PROVIDER_PROXY_CONVERSATION_HEADER]).toBeUndefined();
    expect(getConversationAccount("proxy:macbook/conv-1")?.account).toBe("max2");
    // The response's limiter headers update the account that served it.
    expect(getAccountUsage("max2")?.fiveHour?.utilization).toBe(20);
    expect(getAccountUsage("max2")?.sevenDay?.utilization).toBe(30);
    // The remote's own Accounts data lists it as a conversation on max2.
    expect(claudeAccountsInfo().accounts.find(account => account.id === "max2")?.conversations.map(conv => conv.convId)).toContain("proxy:macbook/conv-1");
  });

  test("a conversation stays on its account while its cache is warm; other new work follows the routing rule", async () => {
    report("main", 10, 2 * H, 20, 30 * H);
    report("max2", 10, 3 * H, 20, 96 * H);
    // No limiter headers here: the reports below decide.
    const upstream: Upstream = { calls: [], answer: account => new Response(`served by ${account}`) };
    const { send } = await proxied(upstream);
    // Soonest weekly reset first: main.
    expect((await send("macbook/conv-1")).text).toBe("served by main");
    // main now resets later than max2: new work prefers max2, but conv-1's cache on main is warm.
    report("main", 10, 2 * H, 20, 120 * H);
    report("max2", 10, 3 * H, 20, 24 * H);
    expect((await send("macbook/conv-1")).text).toBe("served by main");
    expect((await send("macbook/conv-2")).text).toBe("served by max2");
    // A request of no conversation (a title, say) is new work and leaves no assignment.
    expect((await send(null)).text).toBe("served by max2");
    expect(getConversationAccount("proxy:")).toBeNull();
  });

  test("an account that refuses at its usage limit is marked limited and the same request moves to another", async () => {
    report("main", 10, 2 * H, 20, 30 * H);
    report("max2", 10, 3 * H, 20, 96 * H);
    const upstream: Upstream = {
      calls: [],
      answer: (account) => account === "main"
        ? new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limit" } }), {
          status: 429,
          headers: limiterHeaders("rejected", 1, 0.5, { "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 2 * H) }),
        })
        : ok(account),
    };
    const { send } = await proxied(upstream);
    const moved = await send("macbook/conv-1");
    expect(moved).toMatchObject({ status: 200, text: "served by max2" });
    // The client is told, to announce the move in the conversation.
    expect(JSON.parse(decodeURIComponent(moved.headers[PROVIDER_PROXY_ACCOUNT_MOVE_HEADER]!))).toMatchObject({ from: "main", to: "max2" });
    expect(upstream.calls.map(call => call.init.headers.authorization)).toEqual(["Bearer token-main", "Bearer token-max2"]);
    expect(getAccountLimitedUntil("main")).toBeGreaterThan(Date.now());
    // The conversation now lives on max2, and it resumes there (its history is the same request body).
    expect(getConversationAccount("proxy:macbook/conv-1")?.account).toBe("max2");
    const stayed = await send("macbook/conv-1");
    expect(stayed.text).toBe("served by max2");
    expect(stayed.headers[PROVIDER_PROXY_ACCOUNT_MOVE_HEADER]).toBeUndefined();
    expect(upstream.calls).toHaveLength(3);
  });

  test("with every account limited the refusal goes back to the client instead of looping", async () => {
    report("main", 10, 2 * H, 20, 30 * H);
    const upstream: Upstream = {
      calls: [],
      answer: () => new Response("limit", { status: 429, headers: limiterHeaders("rejected", 1, 1) }),
    };
    const { send } = await proxied(upstream);
    expect((await send("macbook/conv-1")).status).toBe(429);
    expect(upstream.calls.length).toBeLessThanOrEqual(2);
  });

  test("an account whose login cannot be refreshed is kept out of routing and the request uses another", async () => {
    report("main", 10, 2 * H, 20, 30 * H);
    report("max2", 10, 3 * H, 20, 96 * H);
    const upstream: Upstream = { calls: [], answer: account => ok(account) };
    const { send } = await proxied(upstream, {
      async headers(_provider, _url, options) {
        if (options.account === "main" || options.account === undefined) throw new UpstreamAuthError("Claude Code's login was rejected and could not be refreshed.");
        return { authorization: `Bearer token-${options.account}` };
      },
    });
    expect((await send("macbook/conv-1")).text).toBe("served by max2");
    expect(claudeAccountsInfo().accounts.find(account => account.id === "main")?.state).toBe("blocked");
  });
});

describe("helpers", () => {
  test("conversation names are validated", () => {
    expect(proxiedConversationKey("macbook.local/1792090615628-gj1mo3")).toBe("proxy:macbook.local/1792090615628-gj1mo3");
    expect(proxiedConversationKey(undefined)).toBeNull();
    expect(proxiedConversationKey("no-slash")).toBeNull();
    expect(proxiedConversationKey("host/../../etc")).toBeNull();
    expect(proxiedConversationKey(`host/${"x".repeat(300)}`)).toBeNull();
  });

  test("limiter headers become the rate_limit_event info Claude Code would report", () => {
    expect(rateLimitInfoFromHeaders(new Headers())).toBeNull();
    expect(rateLimitInfoFromHeaders(new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1800000000",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "1.0",
      "anthropic-ratelimit-unified-5h-reset": "1800000000",
    }))).toEqual({
      status: "rejected",
      resetsAt: 1800000000,
      isUsingOverage: true,
      unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1800000000 } },
    });
  });
});

describe("proxied Claude requests on API credits", () => {
  const KEYS = ["ANTHROPIC_API_KEY_MAIN_CREDITS", "ANTHROPIC_API_KEY_MAX2_CREDITS"];

  beforeEach(async () => {
    writeExocortexConfig({ providers: { anthropic: { apiCreditFallback: { enabled: true, keys: [
      { secret: KEYS[0], label: "main" }, { secret: KEYS[1], label: "max2" },
    ] } } } });
    setApiCreditSecretsForTests({
      names: async () => KEYS,
      value: async name => `value-of-${name}`,
      helperCommand: () => null,
    }, join(dir, "credit-state.json"));
    await refreshApiCreditSecrets({ force: true });
  });

  afterEach(() => {
    writeExocortexConfig({});
    setApiCreditSecretsForTests(null);
  });

  test("with every account limited, a key signs the request; one out of credits hands over to the next", async () => {
    report("main", 100, 2 * H, 50, 30 * H);
    report("max2", 100, 3 * H, 50, 96 * H);
    // The stub signs with the key's value (x-api-key), so the fake upstream sees who signed.
    const upstream: Upstream = {
      calls: [],
      answer: (signer) => signer === "value-of-ANTHROPIC_API_KEY_MAIN_CREDITS"
        ? new Response(`{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}`, { status: 400 })
        : new Response(`event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":100,"output_tokens":1}}}\n\n`, {
          status: 200, headers: { "content-type": "text/event-stream" },
        }),
    };
    const { send } = await proxied(upstream, {
      async headers(_provider, _url, options) {
        const signer = options.apiCredit ? `value-of-${options.apiCredit.id}` : options.account ?? "main";
        return { authorization: `Bearer token-${signer}`, ...(options.apiCredit ? { "x-api-key": signer } : {}) };
      },
    });
    const response = await send("macbook/conv-1");
    expect(response.status).toBe(200);
    expect(upstream.calls.map(call => call.init.headers["x-api-key"])).toEqual(["value-of-ANTHROPIC_API_KEY_MAIN_CREDITS", "value-of-ANTHROPIC_API_KEY_MAX2_CREDITS"]);
    expect((response.headers as unknown as Record<string, string>)[PROVIDER_PROXY_API_CREDITS_HEADER]).toBe("max2");
    expect(usableApiCreditKey()?.id).toBe(KEYS[1]);
  });
});
