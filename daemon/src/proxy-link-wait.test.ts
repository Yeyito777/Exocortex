import { describe, expect, test } from "bun:test";
import { ProviderProxyUnavailableError } from "./provider-proxy/link";
import { isProxyLinkDownError, runWithProxyLinkWait } from "./proxy-link-wait";
import { classifyNetworkFailure } from "./providers/errors";
import { RetryableStreamAbortController } from "./watchdog-retry";

const LINK_DOWN = new Error("Claude Code: API Error: 503 Exocortex /proxy (link down): Could not reach the Exocortex daemon on whale over SSH (exit 255): ssh: Could not resolve hostname yeyito.dev.");
const transient = () => new ProviderProxyUnavailableError("Could not reach the Exocortex daemon on whale over SSH (exit 255): ssh: connect to host whale port 22: Network is unreachable.");

function harness(connect: () => Promise<void>) {
  const log: string[] = [];
  const deps = { alias: () => "whale", connect };
  const hooks = { start: (alias: string) => { log.push(`start:${alias}`); }, end: () => { log.push("end"); } };
  return { log, deps, hooks, controller: new RetryableStreamAbortController() };
}

describe("runWithProxyLinkWait", () => {
  test("classifies link-down failures, and keeps them away from the network wait", () => {
    expect(isProxyLinkDownError(LINK_DOWN)).toBe(true);
    expect(isProxyLinkDownError(transient())).toBe(true);
    expect(isProxyLinkDownError(new ProviderProxyUnavailableError("Permission denied (publickey).", false))).toBe(false);
    expect(isProxyLinkDownError(new Error("Claude Code: API Error: 503 Exocortex /proxy: The Exocortex daemon on whale does not support /proxy"))).toBe(false);
    expect(isProxyLinkDownError(new Error("Claude Code: API Error: 529 Overloaded"))).toBe(false);
    expect(classifyNetworkFailure(LINK_DOWN)).toBeNull();
    expect(classifyNetworkFailure(transient())).toBeNull();
  });

  test("tries the link on the backoff and gives up after the budget with the reason", async () => {
    let attempts = 0;
    const { log, deps, hooks, controller } = harness(async () => { attempts++; throw transient(); });
    let calls = 0;
    const error = await runWithProxyLinkWait(controller, async () => { calls++; throw LINK_DOWN; }, deps, hooks, { delaysMs: [5, 10], budgetMs: 40 })
      .catch((e: Error) => e);
    expect(calls).toBe(1);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Could not resolve hostname yeyito.dev");
    expect((error as Error).message).toContain("for /proxy whale and gave up");
    expect(classifyNetworkFailure(error)).toBeNull();
    expect(log).toEqual(["start:whale", "end"]);
  });

  test("a link failure that will not clear up ends the wait at once", async () => {
    const { log, deps, hooks, controller } = harness(async () => { throw new ProviderProxyUnavailableError("Host key verification failed.", false); });
    await expect(runWithProxyLinkWait(controller, async () => { throw LINK_DOWN; }, deps, hooks, { delaysMs: [5], budgetMs: 60_000 }))
      .rejects.toThrow("Host key verification failed.");
    expect(log).toEqual(["start:whale", "end"]);
  });

  test("passes errors through when the provider is no longer proxied", async () => {
    const { log, hooks, controller } = harness(async () => {});
    await expect(runWithProxyLinkWait(controller, async () => { throw LINK_DOWN; }, { alias: () => null, connect: async () => {} }, hooks))
      .rejects.toBe(LINK_DOWN);
    expect(log).toEqual([]);
  });

  test("abort during the wait cancels it", async () => {
    const { log, deps, hooks, controller } = harness(async () => { throw transient(); });
    const run = runWithProxyLinkWait(controller, async () => { throw LINK_DOWN; }, deps, hooks, { delaysMs: [60_000], budgetMs: 600_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(log).toEqual(["start:whale", "end"]);
  });
});
