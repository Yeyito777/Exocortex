import { createAbortError } from "../abort";

interface Waiter {
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
}

/** Small abort-aware semaphore used to cap expensive tools daemon-wide. */
export class AbortableSemaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(createAbortError());

    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.releaseHandle());
    }

    return new Promise((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(createAbortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
      // Close the check/listener race if the signal aborted synchronously
      // between the initial guard and queue insertion.
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal?.aborted) {
        if (waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(createAbortError());
        continue;
      }
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.active++;
      waiter.resolve(this.releaseHandle());
    }
  }
}
