/**
 * Wait out a /proxy link outage inside a turn instead of failing it.
 *
 * The forwarder (provider-proxy/forwarder.ts) holds a request through a short
 * outage of the link (a Wi-Fi blip, DNS, the remote daemon restarting). Past
 * its hold it fails the request with PROVIDER_PROXY_LINK_DOWN_PREFIX, which
 * Claude Code quotes in its API error, and the turn lands here: it keeps
 * everything it has, shows that it is waiting, tries the link on a backoff
 * and sends the same request again once the link is up. Rounds the provider
 * committed before the failure are not run again (see network-wait.ts).
 *
 * Failures that will not clear up by themselves (SSH authentication or host
 * key, an outdated or refusing remote) are not waited for, and the wait gives
 * up after a budget (`agent.proxyOutageWaitMinutes`, 30 minutes by default).
 * Stop aborts the wait; a steer preempts it like any retry backoff.
 *
 * With somewhere else to run (`fallbackInMs`: Claude's API-credit keys,
 * `whenProxyDown`), the wait lasts until that is due, then the request goes
 * again, and its routing takes it there.
 */

import { readExocortexConfig } from "@exocortex/shared/config";
import { log } from "./log";
import { abortableDelay, waitPreemptibly } from "./network-wait";
import { isTransientProviderProxyError } from "./provider-proxy/link";
import { isProviderProxyLinkDownMessage } from "./provider-proxy/route";
import type { RetryableStreamAbortController } from "./watchdog-retry";

/** Pauses before each attempt to reach the link; the last repeats. */
export const PROXY_LINK_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000, 60_000];
export const DEFAULT_PROXY_OUTAGE_WAIT_MINUTES = 30;

export function proxyOutageWaitMs(): number {
  const minutes = readExocortexConfig().agent?.proxyOutageWaitMinutes;
  return (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_PROXY_OUTAGE_WAIT_MINUTES) * 60_000;
}

/** A provider request failed because the /proxy link was down for a reason that may clear up. */
export function isProxyLinkDownError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current != null && !seen.has(current) && seen.size < 16; current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    if (current instanceof Error && (current.name === "AbortError" || current.name === "StreamPreemptedError")) return false;
    if (isTransientProviderProxyError(current)) return true;
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (isProviderProxyLinkDownMessage(message)) return true;
    if (typeof current !== "object") break;
  }
  return false;
}

export interface ProxyLinkWaitDeps {
  /** The alias the provider goes through, or null when it is no longer proxied. */
  alias(): string | null;
  /** Try the link now: resolve once it is up (or no longer needed), reject with the failure otherwise. */
  connect(signal: AbortSignal): Promise<void>;
  /** How long until the request can run without the link: 0 now, null never or not now. */
  fallbackInMs?(): number | null;
}

export interface ProxyLinkWaitHooks {
  /** The link is down; the turn now waits for it. */
  start(alias: string): void;
  /** The wait is over: the link is back, or the wait ended otherwise. */
  end(): void;
}

export interface ProxyLinkWaitOptions {
  delaysMs?: readonly number[];
  /** Longest total wait for the link over one request; defaults to proxyOutageWaitMs(). */
  budgetMs?: number;
  label?: string;
}

/** Run `operation`, waiting for the /proxy link and running it again whenever it fails because the link is down. */
export async function runWithProxyLinkWait<T>(
  controller: RetryableStreamAbortController,
  operation: () => Promise<T>,
  deps: ProxyLinkWaitDeps,
  hooks: ProxyLinkWaitHooks,
  options: ProxyLinkWaitOptions = {},
): Promise<T> {
  const delays = options.delaysMs ?? PROXY_LINK_RETRY_DELAYS_MS;
  const label = options.label ? ` for ${options.label}` : "";
  let budgetMs: number | null = null;
  let waitedMs = 0;
  let triedFallback = false;
  while (true) {
    let failure: unknown;
    try {
      return await operation();
    } catch (error) {
      if (controller.signal.aborted || !isProxyLinkDownError(error)) throw error;
      failure = error;
    }
    const alias = deps.alias();
    if (!alias) throw failure;
    budgetMs ??= options.budgetMs ?? proxyOutageWaitMs();
    const message = failure instanceof Error ? failure.message : String(failure);
    log("warn", `proxy-link-wait: /proxy ${alias} is down${label} (${message}); waiting for it`);
    hooks.start(alias);
    let fallingBack = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const fallback = deps.fallbackInMs?.() ?? null;
        // Once per pause, should the retry end up here again.
        if (fallback === 0 && !triedFallback) {
          triedFallback = fallingBack = true;
          break;
        }
        const delay = Math.min(delays[Math.min(attempt, delays.length - 1)], fallback || Infinity);
        if (waitedMs + delay > budgetMs) {
          const minutes = Math.round(waitedMs / 60_000);
          const gaveUp = new Error(`${message} Exocortex waited ${minutes >= 1 ? `${minutes} min` : `${Math.round(waitedMs / 1000)}s`} for /proxy ${alias} and gave up; send a message to try again.`, { cause: failure });
          // Not a network failure for network-wait.ts: the network may be fine.
          gaveUp.name = "ProviderProxyUnavailableError";
          throw gaveUp;
        }
        const started = Date.now();
        try {
          await waitPreemptibly(controller, signal => abortableDelay(delay, signal));
          triedFallback = false;
          const left = deps.fallbackInMs?.() ?? null;
          if (left === 0) continue;
          await waitPreemptibly(controller, signal => left === null ? deps.connect(signal) : Promise.race([deps.connect(signal), abortableDelay(left, signal)]));
          if (deps.fallbackInMs?.() === 0) continue;
          break;
        } catch (error) {
          if (controller.signal.aborted || (!isTransientProviderProxyError(error) && deps.fallbackInMs?.() !== 0)) throw error;
          failure = error;
        } finally {
          waitedMs += Date.now() - started;
        }
      }
    } finally {
      hooks.end();
    }
    log("info", fallingBack ? `proxy-link-wait: /proxy ${alias} is still down${label}; retrying the request without it` : `proxy-link-wait: /proxy ${alias} is back${label}; retrying the request`);
  }
}
