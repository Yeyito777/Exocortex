import { createAbortError } from "./abort";
import type { StreamCallbacks } from "./providers/types";

export const STALE_STREAM_MAX_RETRIES = 8;
export const STALE_STREAM_ERROR_MESSAGE = "Timed out (stale stream)";

/**
 * Root controller for one assistant turn.
 *
 * User interrupts and daemon lifecycle aborts remain terminal and abort the
 * root signal. While a provider request is active, a watchdog abort is instead
 * delivered to that request's replaceable attempt controller. This lets the
 * request unwind without making the root signal permanently unusable for a
 * retry.
 */
export class RetryableStreamAbortController implements AbortController {
  private readonly root = new AbortController();
  private watchdogAttempt: AbortController | null = null;

  get signal(): AbortSignal {
    return this.root.signal;
  }

  abort(reason?: unknown): void {
    if (reason === "watchdog" && !this.root.signal.aborted && this.watchdogAttempt) {
      // Consume repeated watchdog ticks while the interrupted request is still
      // unwinding. Falling through to the root here would turn a retryable stall
      // into a terminal cancellation race.
      if (!this.watchdogAttempt.signal.aborted) this.watchdogAttempt.abort(reason);
      return;
    }
    this.root.abort(reason);
  }

  setWatchdogAttempt(controller: AbortController): void {
    this.watchdogAttempt = controller;
  }

  clearWatchdogAttempt(controller: AbortController): void {
    if (this.watchdogAttempt === controller) this.watchdogAttempt = null;
  }
}

export class StaleStreamRetriesExhaustedError extends Error {
  readonly maxRetries: number;

  constructor(maxRetries = STALE_STREAM_MAX_RETRIES) {
    super(`${STALE_STREAM_ERROR_MESSAGE} after ${maxRetries} retries`);
    this.name = "StaleStreamRetriesExhaustedError";
    this.maxRetries = maxRetries;
  }
}

interface WatchdogRetryOptions {
  maxRetries?: number;
  /** Test seam; production uses the same exponential schedule as provider retries. */
  retryDelayMs?: (retryAttempt: number) => number;
}

function defaultRetryDelayMs(retryAttempt: number): number {
  const zeroBasedAttempt = Math.max(0, retryAttempt - 1);
  return Math.min(1000 * Math.pow(2, zeroBasedAttempt), 30_000) + Math.random() * 1000;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run a provider operation with retryable app-watchdog interruptions.
 *
 * Providers already retry transport errors. This wrapper covers the broader
 * Exocortex watchdog, which can also interrupt hangs outside a provider's own
 * idle timeout (for example a stuck connection/auth promise). Each retry gets a
 * fresh child signal while explicit root aborts still propagate immediately.
 */
export async function runWithStaleStreamRetries<T>(
  controller: RetryableStreamAbortController,
  callbacks: StreamCallbacks,
  operation: (signal: AbortSignal) => Promise<T>,
  options: WatchdogRetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? STALE_STREAM_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  let retries = 0;

  while (true) {
    if (controller.signal.aborted) throw createAbortError();

    const attempt = new AbortController();
    const onRootAbort = () => attempt.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", onRootAbort, { once: true });
    controller.setWatchdogAttempt(attempt);

    let failure: unknown;
    let completed = false;
    let result!: T;
    try {
      result = await operation(attempt.signal);
      completed = true;
    } catch (error) {
      failure = error;
    } finally {
      controller.clearWatchdogAttempt(attempt);
      controller.signal.removeEventListener("abort", onRootAbort);
    }

    // A user/lifecycle abort always wins, including a race where it arrives as a
    // watchdog-interrupted request is unwinding. Do not accept a provider result
    // that resolved from its abort handler: an aborted attempt is never a valid
    // completion, even if the transport normalized cancellation into success.
    if (controller.signal.aborted) throw completed ? createAbortError() : failure;
    const watchdogInterrupted = attempt.signal.aborted && attempt.signal.reason === "watchdog";
    if (completed && !attempt.signal.aborted) return result;
    if (!watchdogInterrupted) throw completed ? createAbortError() : failure;
    if (retries >= maxRetries) throw new StaleStreamRetriesExhaustedError(maxRetries);

    retries += 1;
    const delayMs = Math.max(0, retryDelayMs(retries));
    callbacks.onRetry?.(
      retries,
      maxRetries,
      STALE_STREAM_ERROR_MESSAGE,
      Math.round(delayMs / 1000),
      { kind: "transient" },
    );
    await abortableDelay(delayMs, controller.signal);
  }
}
