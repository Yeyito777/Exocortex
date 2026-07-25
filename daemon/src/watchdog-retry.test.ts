import { describe, expect, test } from "bun:test";
import {
  RetryableStreamAbortController,
  STALE_STREAM_ERROR_MESSAGE,
  StaleStreamRetriesExhaustedError,
  runWithStaleStreamRetries,
} from "./watchdog-retry";

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

describe("retryable stale-stream watchdog", () => {
  test("retries a watchdog-interrupted provider attempt without aborting the turn", async () => {
    const controller = new RetryableStreamAbortController();
    const retries: unknown[][] = [];
    let calls = 0;
    let firstAttemptStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstAttemptStarted = resolve; });

    const resultPromise = runWithStaleStreamRetries(
      controller,
      {
        onText: () => {},
        onThinking: () => {},
        onRetry: (...args) => retries.push(args),
      },
      async (signal) => {
        calls += 1;
        if (calls === 1) {
          firstAttemptStarted();
          return rejectOnAbort(signal);
        }
        return "recovered";
      },
      { retryDelayMs: () => 0 },
    );

    await started;
    controller.abort("watchdog");

    await expect(resultPromise).resolves.toBe("recovered");
    expect(calls).toBe(2);
    expect(controller.signal.aborted).toBe(false);
    expect(retries).toEqual([[
      1,
      8,
      STALE_STREAM_ERROR_MESSAGE,
      0,
      { kind: "transient" },
    ]]);
  });

  test("uses all eight retries before hard-failing a repeatedly stale stream", async () => {
    const controller = new RetryableStreamAbortController();
    const retries: number[] = [];
    let calls = 0;

    const resultPromise = runWithStaleStreamRetries(
      controller,
      {
        onText: () => {},
        onThinking: () => {},
        onRetry: (attempt) => retries.push(attempt),
      },
      (signal) => {
        calls += 1;
        queueMicrotask(() => controller.abort("watchdog"));
        return rejectOnAbort(signal);
      },
      { retryDelayMs: () => 0 },
    );

    await expect(resultPromise).rejects.toEqual(new StaleStreamRetriesExhaustedError(8));
    expect(calls).toBe(9);
    expect(retries).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(controller.signal.aborted).toBe(false);
  });

  test("keeps explicit user aborts terminal and does not emit a retry", async () => {
    const controller = new RetryableStreamAbortController();
    const retries: number[] = [];
    let attemptStarted!: () => void;
    const started = new Promise<void>((resolve) => { attemptStarted = resolve; });

    const resultPromise = runWithStaleStreamRetries(
      controller,
      {
        onText: () => {},
        onThinking: () => {},
        onRetry: (attempt) => retries.push(attempt),
      },
      (signal) => {
        attemptStarted();
        return rejectOnAbort(signal);
      },
      { retryDelayMs: () => 0 },
    );

    await started;
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(retries).toEqual([]);
  });

  test("does not accept a stale attempt that resolves from its abort handler", async () => {
    const controller = new RetryableStreamAbortController();
    let calls = 0;
    let firstAttemptStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstAttemptStarted = resolve; });

    const resultPromise = runWithStaleStreamRetries(
      controller,
      { onText: () => {}, onThinking: () => {} },
      (signal) => {
        calls += 1;
        if (calls > 1) return Promise.resolve("fresh result");
        firstAttemptStarted();
        return new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("stale result"), { once: true });
        });
      },
      { retryDelayMs: () => 0 },
    );

    await started;
    controller.abort("watchdog");

    await expect(resultPromise).resolves.toBe("fresh result");
    expect(calls).toBe(2);
    expect(controller.signal.aborted).toBe(false);
  });

  test("does not accept a provider result that resolves during a root abort", async () => {
    const controller = new RetryableStreamAbortController();
    let attemptStarted!: () => void;
    const started = new Promise<void>((resolve) => { attemptStarted = resolve; });

    const resultPromise = runWithStaleStreamRetries(
      controller,
      { onText: () => {}, onThinking: () => {} },
      (signal) => {
        attemptStarted();
        return new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("cancelled result"), { once: true });
        });
      },
      { retryDelayMs: () => 0 },
    );

    await started;
    controller.abort("daemon-restart");

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("daemon-restart");
  });

  test("falls back to a terminal watchdog abort when no provider attempt is active", () => {
    const controller = new RetryableStreamAbortController();

    controller.abort("watchdog");

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("watchdog");
  });
});
