/**
 * Wait out network outages inside a turn instead of failing it.
 *
 * A provider request that fails at the network level (classifyNetworkFailure)
 * asks the shared connectivity monitor whether the network is reachable. If
 * not, the turn keeps everything it has (its input, committed rounds, queued
 * messages behind it) and waits until the monitor sees the network again,
 * then sends the same request again. While the monitor already knows the
 * network is down, no request is attempted at all.
 *
 * A retry is just another provider request over the same messages, like the
 * watchdog's stale-stream retry: rounds the provider completed before the
 * failure are already committed and are not run again (Claude Code forks its
 * session at the latest committed round; see docs/anthropic.md).
 *
 * Stop aborts the wait like any turn. A steer preempts it so the queued input
 * joins the request that waits next.
 */

import { createAbortError } from "./abort";
import type { ConnectivityMonitor } from "./connectivity";
import { log } from "./log";
import { classifyNetworkFailure } from "./providers/errors";
import { STEER_PREEMPTION_REASON, StreamPreemptedError, type RetryableStreamAbortController } from "./watchdog-retry";

/**
 * Network-level failures while the probe still reaches the network are
 * retried this many times before the error surfaces: the trouble is then with
 * the provider (or its host), not the connection.
 */
export const MAX_ONLINE_NETWORK_RETRIES = 3;

export interface NetworkWaitHooks {
  /** The network is down; the turn now waits for it. */
  onWaitStart(error: unknown): void;
  /** The wait is over: the network is back, or the wait was cancelled. */
  onWaitEnd(): void;
}

export interface NetworkWaitOptions {
  maxOnlineRetries?: number;
  /** Delay before retrying a network failure while the probe reaches the network. */
  onlineRetryDelayMs?: (retry: number) => number;
  /** Label for logs. */
  label?: string;
}

function defaultOnlineRetryDelayMs(retry: number): number {
  return Math.min(3_000 * Math.pow(2, Math.max(0, retry - 1)), 30_000);
}

export function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait in a preemptible slot, so Stop and steering reach it like a retry backoff. */
export async function waitPreemptibly<T>(controller: RetryableStreamAbortController, wait: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (controller.signal.aborted) throw createAbortError();
  const slot = new AbortController();
  const onRootAbort = () => slot.abort(controller.signal.reason);
  controller.signal.addEventListener("abort", onRootAbort, { once: true });
  controller.setAttempt(slot, true);
  try {
    return await wait(slot.signal);
  } catch (error) {
    if (!controller.signal.aborted && slot.signal.reason === STEER_PREEMPTION_REASON) {
      throw new StreamPreemptedError();
    }
    throw error;
  } finally {
    controller.clearAttempt(slot);
    controller.signal.removeEventListener("abort", onRootAbort);
  }
}

/**
 * Run `operation`, waiting for connectivity and running it again whenever it
 * fails at the network level during an outage.
 */
export async function runWithNetworkWait<T>(
  controller: RetryableStreamAbortController,
  monitor: ConnectivityMonitor,
  operation: () => Promise<T>,
  hooks: NetworkWaitHooks,
  options: NetworkWaitOptions = {},
): Promise<T> {
  const maxOnlineRetries = options.maxOnlineRetries ?? MAX_ONLINE_NETWORK_RETRIES;
  const onlineRetryDelayMs = options.onlineRetryDelayMs ?? defaultOnlineRetryDelayMs;
  const label = options.label ? ` for ${options.label}` : "";
  let onlineRetries = 0;
  let lastError: unknown = null;

  const waitForNetwork = async (error: unknown): Promise<void> => {
    hooks.onWaitStart(error);
    try {
      await waitPreemptibly(controller, signal => monitor.waitForOnline(signal));
    } finally {
      hooks.onWaitEnd();
    }
    log("info", `network-wait: connectivity returned${label}; retrying the request`);
  };

  while (true) {
    // Known outage: do not even try (a new turn, a wake, or a retry after a steer).
    if (!monitor.isOnline()) await waitForNetwork(lastError);
    try {
      return await operation();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      const kind = classifyNetworkFailure(error);
      if (!kind) throw error;
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // The turn waits from here: through the probe, and the outage if there is one.
      hooks.onWaitStart(error);
      try {
        const reachable = await waitPreemptibly(controller, signal => monitor.check(signal));
        if (!reachable) {
          log("warn", `network-wait: request failed during a network outage${label} (${message}); waiting for connectivity`);
          await waitPreemptibly(controller, signal => monitor.waitForOnline(signal));
          log("info", `network-wait: connectivity returned${label}; retrying the request`);
          onlineRetries = 0;
          continue;
        }
      } finally {
        hooks.onWaitEnd();
      }
      // The network is reachable: the failure is the provider's own trouble.
      onlineRetries += 1;
      const allowed = kind === "network" ? maxOnlineRetries : 0;
      if (onlineRetries > allowed) throw error;
      const delayMs = onlineRetryDelayMs(onlineRetries);
      log("warn", `network-wait: request failed at the network level although the network is reachable${label} (${message}); retry ${onlineRetries}/${allowed} in ${Math.round(delayMs / 1000)}s`);
      await waitPreemptibly(controller, signal => abortableDelay(delayMs, signal));
    }
  }
}
