import { describe, expect, test } from "bun:test";
import { AbortableSemaphore } from "./semaphore";

describe("AbortableSemaphore", () => {
  test("bounds concurrency and releases queued callers in order", async () => {
    const semaphore = new AbortableSemaphore(1);
    const releaseFirst = await semaphore.acquire();
    let secondAcquired = false;
    const second = semaphore.acquire().then(release => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(semaphore.activeCount).toBe(1);
    expect(semaphore.pendingCount).toBe(1);

    releaseFirst();
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);
    expect(semaphore.activeCount).toBe(1);
    releaseSecond();
    expect(semaphore.activeCount).toBe(0);
  });

  test("removes aborted waiters without consuming a slot", async () => {
    const semaphore = new AbortableSemaphore(1);
    const release = await semaphore.acquire();
    const ac = new AbortController();
    const waiting = semaphore.acquire(ac.signal);
    ac.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(semaphore.pendingCount).toBe(0);
    release();
    expect(semaphore.activeCount).toBe(0);
  });
});
