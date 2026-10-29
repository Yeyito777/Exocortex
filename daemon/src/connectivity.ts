/**
 * The daemon's shared connectivity monitor.
 *
 * A provider request that fails at the network level (see
 * classifyNetworkFailure) asks this monitor whether the network is reachable.
 * While it is not, the monitor probes on a backoff (3s doubling to 30s) and
 * every waiting turn resumes as soon as one probe succeeds or a provider makes
 * progress again. There is one monitor per daemon, so every conversation and
 * every client sees the same state.
 *
 * The probe is cheap and never calls a model: resolve a well-known host's name
 * (the providers' own failure mode is usually DNS) and open a TCP connection
 * to port 443. Any reachable host counts as online.
 */

import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { createAbortError, raceAbort } from "./abort";
import { log } from "./log";

export const PROBE_INITIAL_DELAY_MS = 3_000;
export const PROBE_MAX_DELAY_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Provider API hosts first, then general-purpose ones. */
export const DEFAULT_PROBE_HOSTS = ["api.anthropic.com", "chatgpt.com", "www.google.com"];
/** Lookups that outlived their timeout and still hold a resolver thread. */
const MAX_OUTSTANDING_LOOKUPS = 4;

export type ConnectivityProbe = (signal: AbortSignal) => Promise<boolean>;

export interface ConnectivitySnapshot {
  online: boolean;
  /** When the monitor last found the network unreachable; null while online. */
  offlineSince: number | null;
  /** When the next probe runs while offline. */
  nextProbeAt: number | null;
}

export interface ConnectivityClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: ConnectivityClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ConnectivityMonitorOptions {
  probe: ConnectivityProbe;
  clock?: ConnectivityClock;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export class ConnectivityMonitor {
  private readonly probe: ConnectivityProbe;
  private readonly clock: ConnectivityClock;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private online = true;
  private offlineSince: number | null = null;
  private nextProbeAt: number | null = null;
  private nextDelayMs: number;
  private timer: unknown = null;
  private inFlight: Promise<boolean> | null = null;
  private probeController: AbortController | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(snapshot: ConnectivitySnapshot) => void>();

  constructor(options: ConnectivityMonitorOptions) {
    this.probe = options.probe;
    this.clock = options.clock ?? systemClock;
    this.initialDelayMs = options.initialDelayMs ?? PROBE_INITIAL_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? PROBE_MAX_DELAY_MS;
    this.nextDelayMs = this.initialDelayMs;
  }

  isOnline(): boolean {
    return this.online;
  }

  snapshot(): ConnectivitySnapshot {
    return { online: this.online, offlineSince: this.offlineSince, nextProbeAt: this.nextProbeAt };
  }

  /** Listen for online/offline changes (and rescheduled probes while offline). */
  subscribe(listener: (snapshot: ConnectivitySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Probe now, joining a probe already running. Resolves whether the network
   * is reachable; the monitor's state follows the result. `signal` only stops
   * this caller from waiting.
   */
  check(signal?: AbortSignal): Promise<boolean> {
    const probe = this.inFlight ?? this.startProbe();
    return signal ? raceAbort(probe, signal) : probe;
  }

  /** A provider request hit a network-level error: find out whether we are offline. */
  reportTrouble(): void {
    if (this.online && !this.inFlight) void this.check();
  }

  /** A provider answered: the network is evidently back. */
  reportSuccess(): void {
    if (!this.online) this.markOnline("a provider responded");
  }

  /** Resolve once the network is reachable again (immediately while online). */
  waitForOnline(signal?: AbortSignal): Promise<void> {
    if (this.online) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(createAbortError());
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.waiters.delete(done);
        reject(createAbortError());
      };
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Stop probing (daemon shutdown, tests). Waiters stay pending until aborted. */
  stop(): void {
    this.clearTimer();
    this.probeController?.abort();
    this.probeController = null;
  }

  private startProbe(): Promise<boolean> {
    this.clearTimer();
    const controller = new AbortController();
    this.probeController = controller;
    const run = (async () => {
      try {
        return await this.probe(controller.signal);
      } catch {
        return false;
      }
    })().then((reachable) => {
      if (this.probeController === controller) this.probeController = null;
      this.inFlight = null;
      if (!controller.signal.aborted) {
        if (reachable) this.markOnline("a probe succeeded");
        else this.markOffline();
      }
      return reachable;
    });
    this.inFlight = run;
    return run;
  }

  private markOffline(): void {
    const now = this.clock.now();
    if (this.online) {
      this.online = false;
      this.offlineSince = now;
      this.nextDelayMs = this.initialDelayMs;
      log("warn", "connectivity: the network is unreachable; waiting for it to return");
    }
    const delayMs = this.nextDelayMs;
    this.nextDelayMs = Math.min(this.nextDelayMs * 2, this.maxDelayMs);
    this.nextProbeAt = now + delayMs;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.online && !this.inFlight) void this.check();
    }, delayMs);
    this.emit();
  }

  private markOnline(reason: string): void {
    if (this.online) return;
    const offlineForMs = this.offlineSince === null ? 0 : this.clock.now() - this.offlineSince;
    this.online = true;
    this.offlineSince = null;
    this.nextProbeAt = null;
    this.nextDelayMs = this.initialDelayMs;
    this.clearTimer();
    log("info", `connectivity: the network is back after ${Math.round(offlineForMs / 1000)}s (${reason})`);
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
    this.emit();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        log("warn", `connectivity: listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("probe timed out"))), timeoutMs);
    const onAbort = () => finish(() => reject(createAbortError()));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

let outstandingLookups = 0;

async function resolveHost(host: string, signal: AbortSignal): Promise<string> {
  if (outstandingLookups >= MAX_OUTSTANDING_LOOKUPS) throw new Error("resolver busy");
  outstandingLookups += 1;
  const pending = lookup(host).finally(() => { outstandingLookups -= 1; });
  const { address } = await withTimeout(pending, PROBE_TIMEOUT_MS, signal);
  return address;
}

function openTcp(address: string, port: number, signal: AbortSignal): Promise<void> {
  return withTimeout(new Promise<void>((resolve, reject) => {
    const socket = connect({ host: address, port });
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
    };
    const onAbort = () => cleanup();
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => { cleanup(); resolve(); });
    socket.once("error", (error) => { cleanup(); reject(error); });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => { cleanup(); reject(new Error("connect timed out")); });
  }), PROBE_TIMEOUT_MS + 500, signal);
}

/** DNS + TCP reachability of any of `hosts` on port 443. */
export function createConnectivityProbe(hosts: string[] = DEFAULT_PROBE_HOSTS): ConnectivityProbe {
  return async (signal) => {
    for (const host of hosts) {
      if (signal.aborted) return false;
      try {
        const address = await resolveHost(host, signal);
        await openTcp(address, 443, signal);
        return true;
      } catch {
        // Try the next host.
      }
    }
    return false;
  };
}

function configuredProbeHosts(): string[] {
  const raw = process.env.EXOCORTEX_CONNECTIVITY_PROBE_HOSTS?.trim();
  if (!raw) return DEFAULT_PROBE_HOSTS;
  const hosts = raw.split(",").map(host => host.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : DEFAULT_PROBE_HOSTS;
}

/** The daemon-wide monitor. */
export const connectivity = new ConnectivityMonitor({ probe: createConnectivityProbe(configuredProbeHosts()) });
